import { describe, expect, it, vi } from 'vitest';
import { archiveChunks, type EarthquakeEvent } from '@terra-pulse/schema';
import { ArchiveCancelledError, fetchArchiveChunk } from './archive-backfill';

function chunkFor(year: number) {
  const chunk = archiveChunks(year).find((candidate) => candidate.year === year);
  if (!chunk) throw new Error(`no chunk for ${String(year)}`);
  return chunk;
}

function makeEvent(id: string, timeUtc: string): EarthquakeEvent {
  return {
    id,
    source: 'usgs',
    magnitude: 5.2,
    magnitudeType: 'mb',
    place: 'Somewhere',
    timeUtc,
    updatedUtc: timeUtc,
    longitude: 0,
    latitude: 0,
    depthKm: 10,
    status: 'reviewed',
    tsunami: false,
    alertLevel: null,
    significance: 400,
    url: 'https://example.test',
  };
}

/** A fake FDSN that hands out `total` events in pages, recording every call. */
function pagedService(total: number, year = 1993) {
  const all = Array.from({ length: total }, (_, i) =>
    makeEvent(`e${String(i)}`, `${String(year)}-06-01T00:00:00.000Z`),
  );
  const calls: { limit: number; offset: number }[] = [];

  const fetchPage = vi.fn(
    ({ limit, offset }: { limit: number; offset: number }): Promise<EarthquakeEvent[]> => {
      calls.push({ limit, offset });
      // FDSN's offset is 1-based.
      return Promise.resolve(all.slice(offset - 1, offset - 1 + limit));
    },
  );

  return { fetchPage, calls };
}

describe('fetchArchiveChunk', () => {
  it('returns every event in a chunk that fits in one page', async () => {
    const { fetchPage, calls } = pagedService(120);

    const events = await fetchArchiveChunk({
      chunk: chunkFor(1993),
      minMagnitude: 4.5,
      fetchPage,
      pageSize: 1000,
    });

    expect(events).toHaveLength(120);
    expect(calls).toEqual([{ limit: 1000, offset: 1 }]);
  });

  it('pages until the range is exhausted, without dropping or repeating events', async () => {
    // The failure this guards is off-by-one on FDSN's 1-based offset, which
    // loses exactly one event per page boundary — invisible in a count check
    // unless you look at identities.
    const { fetchPage } = pagedService(250);

    const events = await fetchArchiveChunk({
      chunk: chunkFor(1993),
      minMagnitude: 4.5,
      fetchPage,
      pageSize: 100,
    });

    expect(events).toHaveLength(250);
    expect(new Set(events.map((e) => e.id)).size).toBe(250);
    expect(events[0]?.id).toBe('e0');
    expect(events.at(-1)?.id).toBe('e249');
  });

  it('stops when a page comes back exactly full and the next is empty', async () => {
    const { fetchPage, calls } = pagedService(200);

    const events = await fetchArchiveChunk({
      chunk: chunkFor(1993),
      minMagnitude: 4.5,
      fetchPage,
      pageSize: 100,
    });

    expect(events).toHaveLength(200);
    // Two full pages then one empty confirming the end — and crucially it
    // terminates rather than looping.
    expect(calls).toHaveLength(3);
  });

  it('handles an empty year', async () => {
    const { fetchPage } = pagedService(0);

    const events = await fetchArchiveChunk({
      chunk: chunkFor(1971),
      minMagnitude: 4.5,
      fetchPage,
      pageSize: 100,
    });

    expect(events).toEqual([]);
  });

  it('drops an event landing exactly on the chunk end', async () => {
    // FDSN's endtime is inclusive, so the boundary event comes back in both
    // this chunk and the next. Counted twice, the recorded per-year totals stop
    // adding up to the catalogue.
    const fetchPage = vi.fn(() =>
      Promise.resolve([
        makeEvent('inside', '1993-12-31T23:59:59.000Z'),
        makeEvent('boundary', '1994-01-01T00:00:00.000Z'),
      ]),
    );

    const events = await fetchArchiveChunk({
      chunk: chunkFor(1993),
      minMagnitude: 4.5,
      fetchPage,
      pageSize: 1000,
    });

    expect(events.map((e) => e.id)).toEqual(['inside']);
  });

  it('throws rather than returning a partial chunk when cancelled', async () => {
    // A partial chunk that resolved normally would be recorded as a complete
    // year and leave a permanent hole.
    const signal = { aborted: false };
    const fetchPage = vi.fn(({ offset }: { offset: number }) => {
      signal.aborted = true;
      return Promise.resolve(
        Array.from({ length: 100 }, (_, i) =>
          makeEvent(`e${String(offset + i)}`, '1993-06-01T00:00:00.000Z'),
        ),
      );
    });

    await expect(
      fetchArchiveChunk({
        chunk: chunkFor(1993),
        minMagnitude: 4.5,
        signal,
        fetchPage,
        pageSize: 100,
      }),
    ).rejects.toBeInstanceOf(ArchiveCancelledError);
  });

  it('checks cancellation before making any request at all', async () => {
    const fetchPage = vi.fn();

    await expect(
      fetchArchiveChunk({
        chunk: chunkFor(1993),
        minMagnitude: 4.5,
        signal: { aborted: true },
        fetchPage,
      }),
    ).rejects.toBeInstanceOf(ArchiveCancelledError);

    expect(fetchPage).not.toHaveBeenCalled();
  });
});
