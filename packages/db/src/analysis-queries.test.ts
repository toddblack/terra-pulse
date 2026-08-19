import { describe, expect, it } from 'vitest';
import type { EarthquakeEvent } from '@terra-pulse/schema';
import { openDatabase } from './client';
import { insertEarthquakes } from './queries';
import { queryAnalysisCatalog } from './analysis-queries';

function makeEvent(overrides: Partial<EarthquakeEvent> = {}): EarthquakeEvent {
  return {
    id: 'us0001',
    source: 'usgs',
    magnitude: 5.2,
    magnitudeType: 'mb',
    place: '10km SSW of Somewhere',
    timeUtc: '2011-03-11T05:46:24.000Z',
    updatedUtc: '2011-03-11T05:46:24.000Z',
    longitude: 142.369,
    latitude: 38.297,
    depthKm: 29,
    status: 'reviewed',
    tsunami: true,
    alertLevel: 'red',
    significance: 2910,
    url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us0001',
    ...overrides,
  };
}

describe('queryAnalysisCatalog', () => {
  it('returns four parallel arrays, ordered by time', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [
      makeEvent({ id: 'b', timeUtc: '2011-03-12T00:00:00.000Z', magnitude: 5.5 }),
      makeEvent({ id: 'a', timeUtc: '2011-03-11T05:46:24.000Z', magnitude: 9.1 }),
    ]);

    const result = queryAnalysisCatalog(db, {
      minMagnitude: 5.0,
      startUtc: '2011-01-01T00:00:00.000Z',
      endUtc: '2012-01-01T00:00:00.000Z',
    });

    expect(result.timeMs).toEqual([
      Date.parse('2011-03-11T05:46:24.000Z'),
      Date.parse('2011-03-12T00:00:00.000Z'),
    ]);
    expect(result.magnitude).toEqual([9.1, 5.5]);
    expect(result.latitude).toHaveLength(2);
    expect(result.longitude).toHaveLength(2);
  });

  it('excludes events below the magnitude floor', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [
      makeEvent({ id: 'small', magnitude: 4.9 }),
      makeEvent({ id: 'big', magnitude: 5.0, timeUtc: '2011-03-12T00:00:00.000Z' }),
    ]);

    const result = queryAnalysisCatalog(db, {
      minMagnitude: 5.0,
      startUtc: '2011-01-01T00:00:00.000Z',
      endUtc: '2012-01-01T00:00:00.000Z',
    });

    expect(result.magnitude).toEqual([5.0]);
  });

  it('excludes events outside the half-open time range', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [
      makeEvent({ id: 'before', timeUtc: '2010-12-31T23:59:59.000Z' }),
      makeEvent({ id: 'at-start', timeUtc: '2011-01-01T00:00:00.000Z' }),
      makeEvent({ id: 'at-end', timeUtc: '2012-01-01T00:00:00.000Z' }),
    ]);

    const result = queryAnalysisCatalog(db, {
      minMagnitude: 5.0,
      startUtc: '2011-01-01T00:00:00.000Z',
      endUtc: '2012-01-01T00:00:00.000Z',
    });

    expect(result.timeMs).toEqual([Date.parse('2011-01-01T00:00:00.000Z')]);
  });

  it('returns empty arrays rather than throwing when nothing matches', () => {
    const db = openDatabase(':memory:');
    const result = queryAnalysisCatalog(db, {
      minMagnitude: 5.0,
      startUtc: '2011-01-01T00:00:00.000Z',
      endUtc: '2012-01-01T00:00:00.000Z',
    });

    expect(result).toEqual({ timeMs: [], latitude: [], longitude: [], magnitude: [] });
  });

  /**
   * The load-bearing check this codebase has been burned by skipping before
   * (`findCandidateMatches`, `catalogSignature` — see CLAUDE.md's "Conventions
   * these phases established"): a composite index only narrows on the columns
   * actually bound, and the query plan can *look* fine at a small row count
   * while quietly scanning at a real one. `idx_earthquakes_time_magnitude`
   * covers `(time_utc, magnitude)`; this query binds both, so it should use
   * that index rather than a table scan even before any row exists.
   */
  it('uses the existing time/magnitude index rather than scanning the table', () => {
    const db = openDatabase(':memory:');
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT CAST(strftime('%s', time_utc) AS INTEGER) * 1000 AS time_ms, latitude, longitude, magnitude
           FROM earthquakes
          WHERE magnitude >= ? AND time_utc >= ? AND time_utc < ?
          ORDER BY time_utc`,
      )
      .all(5.0, '2011-01-01T00:00:00.000Z', '2012-01-01T00:00:00.000Z') as unknown as {
      detail: string;
    }[];

    const detail = plan.map((row) => row.detail).join(' | ');
    expect(detail).toContain('idx_earthquakes_time_magnitude');
    expect(detail).not.toMatch(/SCAN earthquakes\b/);
  });
});
