import { describe, expect, it } from 'vitest';
import type { EarthquakeEvent } from '@terra-pulse/schema';
import { openDatabase } from './client';
import { insertEarthquakes } from './queries';
import { recordArchiveChunk } from './archive-queries';
import { queryRegionalRecurrence } from './recurrence-queries';

const YEAR_MS = 365.25 * 86_400_000;
const NOW = Date.parse('2026-01-01T00:00:00.000Z');

function quake(
  id: string,
  timeUtc: string,
  magnitude: number,
  latitude: number,
  longitude: number,
): EarthquakeEvent {
  return {
    id,
    source: 'usgs',
    magnitude,
    magnitudeType: 'mww',
    place: 'somewhere',
    timeUtc,
    updatedUtc: timeUtc,
    longitude,
    latitude,
    depthKm: 10,
    status: 'reviewed',
    tsunami: false,
    alertLevel: null,
    significance: null,
    url: 'https://example.test',
  };
}

/** Marks 1970..2025 downloaded, so completeness never confuses these tests. */
function withFullArchive(db: ReturnType<typeof openDatabase>, from = 1970, to = 2025) {
  for (let year = from; year <= to; year += 1) {
    recordArchiveChunk(
      db,
      { year, startUtc: `${year}-01-01T00:00:00.000Z`, endUtc: `${year + 1}-01-01T00:00:00.000Z` },
      4.5,
      0,
    );
  }
}

/** n events at the same spot, `spacingYears` apart, all independent by spacing. */
function evenlySpaced(count: number, spacingYears: number, magnitude = 6) {
  const start = Date.parse('1975-01-01T00:00:00.000Z');
  return Array.from({ length: count }, (_, i) =>
    quake(`e${i}`, new Date(start + i * spacingYears * YEAR_MS).toISOString(), magnitude, 0, 0),
  );
}

describe('queryRegionalRecurrence', () => {
  it('finds events inside the radius and ignores those outside', () => {
    const db = openDatabase(':memory:');
    withFullArchive(db);
    insertEarthquakes(db, [
      quake('in', '1990-01-01T00:00:00.000Z', 6, 0, 0),
      // ~445 km north — outside a 300 km radius.
      quake('out', '1995-01-01T00:00:00.000Z', 6, 4, 0),
    ]);

    const result = queryRegionalRecurrence(db, { latitude: 0, longitude: 0 }, 300, 6, NOW);
    expect(result.independent.map((e) => e.id)).toEqual(['in']);
  });

  it('ignores events below the floor', () => {
    const db = openDatabase(':memory:');
    withFullArchive(db);
    insertEarthquakes(db, [
      quake('big', '1990-01-01T00:00:00.000Z', 6.2, 0, 0),
      quake('small', '1995-01-01T00:00:00.000Z', 5.9, 0, 0),
    ]);

    const result = queryRegionalRecurrence(db, { latitude: 0, longitude: 0 }, 300, 6, NOW);
    expect(result.independent.map((e) => e.id)).toEqual(['big']);
  });

  it('excludes anything before the 1970 epoch', () => {
    const db = openDatabase(':memory:');
    withFullArchive(db);
    insertEarthquakes(db, [
      quake('ancient', '1965-01-01T00:00:00.000Z', 6.5, 0, 0),
      quake('modern', '1990-01-01T00:00:00.000Z', 6.5, 0, 0),
    ]);

    const result = queryRegionalRecurrence(db, { latitude: 0, longitude: 0 }, 300, 6, NOW);
    expect(result.independent.map((e) => e.id)).toEqual(['modern']);
  });

  /**
   * The whole reason declustering is mandatory. Raw counts near Tokyo at M6+
   * give a 0.06-year median gap against 0.32 declustered — the raw figure
   * answers "how often does the ground shake", not "how often does an
   * independent earthquake occur".
   */
  it('declusters an aftershock sequence out of the count', () => {
    const db = openDatabase(':memory:');
    withFullArchive(db);
    const mainshock = quake('main', '1990-01-01T00:00:00.000Z', 7, 0, 0);
    const aftershocks = Array.from({ length: 12 }, (_, i) =>
      quake(
        `aft${i}`,
        new Date(Date.parse(mainshock.timeUtc) + (i + 1) * 5 * 86_400_000).toISOString(),
        6.1,
        0.1,
        0.1,
      ),
    );
    insertEarthquakes(db, [mainshock, ...aftershocks]);

    const result = queryRegionalRecurrence(db, { latitude: 0, longitude: 0 }, 300, 6, NOW);
    expect(result.summary.rawCount).toBe(13);
    expect(result.summary.independentCount).toBe(1);
    // One independent event means no interval at all — not an interval of zero.
    expect(result.summary.intervalsYears).toEqual([]);
  });

  it('computes intervals between independent events', () => {
    const db = openDatabase(':memory:');
    withFullArchive(db);
    insertEarthquakes(db, evenlySpaced(10, 3));

    const result = queryRegionalRecurrence(db, { latitude: 0, longitude: 0 }, 300, 6, NOW);
    expect(result.summary.independentCount).toBe(10);
    expect(result.summary.intervalsYears).toHaveLength(9);
    expect(result.summary.medianYears).toBeCloseTo(3, 2);
  });

  it('returns independent events newest first', () => {
    const db = openDatabase(':memory:');
    withFullArchive(db);
    insertEarthquakes(db, evenlySpaced(4, 5));

    const result = queryRegionalRecurrence(db, { latitude: 0, longitude: 0 }, 300, 6, NOW);
    const times = result.independent.map((e) => e.timeUtc);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('reports a seismically quiet region as genuinely empty', () => {
    // Measured: Denver has no independent M5.5+ within 500 km since 1970. That
    // is a real answer about the region, not a failure to find data.
    const db = openDatabase(':memory:');
    withFullArchive(db);
    insertEarthquakes(db, [quake('elsewhere', '1990-01-01T00:00:00.000Z', 7, 40, 40)]);

    const result = queryRegionalRecurrence(db, { latitude: 0, longitude: 0 }, 300, 6, NOW);
    expect(result.summary.independentCount).toBe(0);
    expect(result.summary.medianYears).toBeNull();
    expect(result.summary.sinceLastYears).toBeNull();
  });

  it('finds events across the antimeridian', () => {
    // Reuses sequenceSearchBoxes, so the Kuril/Aleutian/Tonga arcs work. Without
    // it the box runs 178→182 and matches nothing.
    const db = openDatabase(':memory:');
    withFullArchive(db);
    insertEarthquakes(db, [
      quake('east', '1990-01-01T00:00:00.000Z', 6.5, 50, 179.5),
      quake('west', '2000-01-01T00:00:00.000Z', 6.5, 50, -179.5),
    ]);

    const result = queryRegionalRecurrence(db, { latitude: 50, longitude: 179.9 }, 300, 6, NOW);
    expect(result.independent.map((e) => e.id).sort()).toEqual(['east', 'west']);
  });
});

/**
 * A hole in the archive merges two real gaps into one longer false gap — an
 * error that always points toward "rarer than it is", and which looks exactly
 * like a complete answer. The flag is what lets the panel refuse instead.
 */
describe('archive completeness', () => {
  it('is true when every year since 1970 is downloaded', () => {
    const db = openDatabase(':memory:');
    withFullArchive(db);
    insertEarthquakes(db, evenlySpaced(3, 5));

    expect(
      queryRegionalRecurrence(db, { latitude: 0, longitude: 0 }, 300, 6, NOW).archiveComplete,
    ).toBe(true);
  });

  it('is false when the archive has never been downloaded', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, evenlySpaced(3, 5));

    expect(
      queryRegionalRecurrence(db, { latitude: 0, longitude: 0 }, 300, 6, NOW).archiveComplete,
    ).toBe(false);
  });

  it('is false when a single year in the middle is missing', () => {
    const db = openDatabase(':memory:');
    withFullArchive(db, 1970, 1994);
    withFullArchive(db, 1996, 2025);
    insertEarthquakes(db, evenlySpaced(3, 5));

    expect(
      queryRegionalRecurrence(db, { latitude: 0, longitude: 0 }, 300, 6, NOW).archiveComplete,
    ).toBe(false);
  });

  it('does not require the current year to be recorded complete', () => {
    // The backfill refetches the current year every run precisely because it
    // can never be marked done. Requiring it would make this permanently false.
    const db = openDatabase(':memory:');
    withFullArchive(db, 1970, 2025);
    insertEarthquakes(db, evenlySpaced(3, 5));

    expect(
      queryRegionalRecurrence(db, { latitude: 0, longitude: 0 }, 300, 6, NOW).archiveComplete,
    ).toBe(true);
  });
});
