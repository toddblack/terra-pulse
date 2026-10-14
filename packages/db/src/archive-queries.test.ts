import { describe, expect, it } from 'vitest';
import { archiveChunks, deepArchiveChunks } from '@terra-pulse/schema';
import {
  archiveChunkSummary,
  completedArchiveYears,
  listArchiveChunks,
  recordArchiveChunk,
  uncoveredArchiveYears,
} from './archive-queries';
import { openDatabase } from './client';

function chunkFor(year: number) {
  const chunk = archiveChunks(year).find((candidate) => candidate.year === year);
  if (!chunk) throw new Error(`no chunk for ${String(year)}`);
  return chunk;
}

describe('archive chunk bookkeeping', () => {
  it('records a completed chunk and reports it as done', () => {
    const db = openDatabase(':memory:');

    recordArchiveChunk(db, chunkFor(1993), 4.5, 3102);

    expect(completedArchiveYears(db, 4.5)).toEqual(new Set([1993]));
    expect(archiveChunkSummary(db, 4.5)).toEqual({ completedChunks: 1, storedEvents: 3102 });
  });

  it('reports nothing done on a fresh database', () => {
    const db = openDatabase(':memory:');

    expect(completedArchiveYears(db, 4.5).size).toBe(0);
    expect(archiveChunkSummary(db, 4.5)).toEqual({ completedChunks: 0, storedEvents: 0 });
  });

  it('does not count a year fetched at a higher floor as covering a lower one', () => {
    // A year pulled at M5.5 is missing every M4.5-5.5 event in it. Treating it
    // as done would leave a hole shaped exactly like that gap, and nothing
    // downstream would ever notice.
    const db = openDatabase(':memory:');
    recordArchiveChunk(db, chunkFor(1993), 5.5, 480);

    expect(completedArchiveYears(db, 4.5).size).toBe(0);
  });

  it('does count a year fetched at a lower floor as covering a higher one', () => {
    const db = openDatabase(':memory:');
    recordArchiveChunk(db, chunkFor(1993), 4.5, 3102);

    expect(completedArchiveYears(db, 5.5)).toEqual(new Set([1993]));
  });

  it('re-recording a year replaces it rather than duplicating', () => {
    // A resumed run can legitimately refetch a year whose events committed but
    // whose bookkeeping row did not.
    const db = openDatabase(':memory:');

    recordArchiveChunk(db, chunkFor(1993), 4.5, 3000);
    recordArchiveChunk(db, chunkFor(1993), 4.5, 3102);

    expect(archiveChunkSummary(db, 4.5)).toEqual({ completedChunks: 1, storedEvents: 3102 });
  });

  it('lists chunks oldest first', () => {
    const db = openDatabase(':memory:');
    recordArchiveChunk(db, chunkFor(2011), 4.5, 9584);
    recordArchiveChunk(db, chunkFor(1970), 4.5, 669);

    expect(listArchiveChunks(db).map((chunk) => chunk.year)).toEqual([1970, 2011]);
  });
});

describe('archiveChunks', () => {
  it('covers every year from 1970 through the requested one', () => {
    const chunks = archiveChunks(2026);

    expect(chunks[0]?.year).toBe(1970);
    expect(chunks.at(-1)?.year).toBe(2026);
    expect(chunks).toHaveLength(2026 - 1970 + 1);
  });

  it('produces half-open ranges that meet exactly, with no overlap or gap', () => {
    // FDSN's endtime is inclusive, so an overlapping boundary would fetch the
    // midnight event twice. Harmless for the upsert, but it would make the
    // per-chunk counts disagree with the catalogue total.
    const chunks = archiveChunks(1975);

    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]?.startUtc).toBe(chunks[i - 1]?.endUtc);
    }
  });

  it('is deterministic — resume depends on it', () => {
    expect(archiveChunks(2026)).toEqual(archiveChunks(2026));
  });
});

describe('uncoveredArchiveYears', () => {
  const NOW = Date.UTC(2026, 9, 13);
  const span = (fromYear: number, toYear: number): [number, number] => [
    Date.UTC(fromYear, 0, 1),
    Date.UTC(toYear, 11, 31),
  ];

  function deepChunkFor(year: number) {
    const chunk = deepArchiveChunks().find((candidate) => candidate.year === year);
    if (!chunk) throw new Error(`no deep chunk for ${String(year)}`);
    return chunk;
  }

  it('names every year when nothing was downloaded', () => {
    const db = openDatabase(':memory:');
    expect(uncoveredArchiveYears(db, ...span(1989, 1991), NOW)).toEqual([1989, 1990, 1991]);
  });

  it('names only the years that are actually absent', () => {
    const db = openDatabase(':memory:');
    recordArchiveChunk(db, chunkFor(1989), 4.5, 3000);
    recordArchiveChunk(db, chunkFor(1991), 4.5, 3000);

    expect(uncoveredArchiveYears(db, ...span(1989, 1991), NOW)).toEqual([1990]);
  });

  it('treats a pre-1970 year as missing at M4.5+, deep tier or not', () => {
    // The default question is about M4.5+, which the deep tier never holds.
    // The aftershock panel counts at M4.5+ and relies on this to say "lower
    // bound" for a 1960 mainshock.
    const db = openDatabase(':memory:');
    recordArchiveChunk(db, deepChunkFor(1960), 7.5, 3);

    expect(uncoveredArchiveYears(db, ...span(1960, 1960), NOW)).toEqual([1960]);
  });

  it('counts the deep tier for a view of the globe', () => {
    // A 1960 date range with the deep tier downloaded shows everything there
    // is to show. Calling it "not downloaded" would send the reader to a
    // button with nothing left to fetch.
    const db = openDatabase(':memory:');
    recordArchiveChunk(db, deepChunkFor(1960), 7.5, 3);

    expect(
      uncoveredArchiveYears(db, ...span(1960, 1960), NOW, { deepTierCounts: true }),
    ).toEqual([]);
    // But not a year the deep tier itself never fetched.
    expect(
      uncoveredArchiveYears(db, ...span(1960, 1961), NOW, { deepTierCounts: true }),
    ).toEqual([1961]);
  });

  it('does not let the deep tier stand in for the main archive after 1970', () => {
    // 1989 fetched only at M7.5+ is missing nearly everything a view of 1989
    // would draw.
    const db = openDatabase(':memory:');
    recordArchiveChunk(db, chunkFor(1989), 7.5, 4);

    expect(
      uncoveredArchiveYears(db, ...span(1989, 1989), NOW, { deepTierCounts: true }),
    ).toEqual([1989]);
  });

  it('needs no archive for a span inside the rolling cache', () => {
    const db = openDatabase(':memory:');
    const lastWeek = NOW - 7 * 24 * 3_600_000;

    expect(uncoveredArchiveYears(db, lastWeek, NOW, NOW)).toEqual([]);
  });
});
