import { describe, expect, it } from 'vitest';
import type { EarthquakeEvent } from '@terra-pulse/schema';
import { openDatabase } from './client';
import {
  catalogSignature,
  insertEarthquakes,
  queryEarthquakes,
  queryEarthquakesInBoundingBox,
  signaturesMatch,
} from './queries';

function makeEvent(overrides: Partial<EarthquakeEvent> = {}): EarthquakeEvent {
  return {
    id: 'us0001',
    magnitude: 5.2,
    magnitudeType: 'mb',
    place: '10km SSW of Somewhere',
    timeUtc: '2026-07-20T12:00:00.000Z',
    updatedUtc: '2026-07-20T12:05:00.000Z',
    longitude: -112.14,
    latitude: 36.05,
    depthKm: 10,
    status: 'reviewed',
    tsunami: false,
    alertLevel: null,
    significance: 400,
    url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us0001',
    ...overrides,
  };
}

describe('earthquake queries', () => {
  it('round-trips an inserted event through a query with no filters', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent()]);

    const results = queryEarthquakes(db);

    expect(results).toEqual([makeEvent()]);
  });

  it('filters by minimum magnitude', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [
      makeEvent({ id: 'small', magnitude: 2.0 }),
      makeEvent({ id: 'big', magnitude: 6.0 }),
    ]);

    const results = queryEarthquakes(db, { minMagnitude: 4.5 });

    expect(results.map((e) => e.id)).toEqual(['big']);
  });

  it('filters by time range', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [
      makeEvent({ id: 'old', timeUtc: '2020-01-01T00:00:00.000Z' }),
      makeEvent({ id: 'recent', timeUtc: '2026-07-20T00:00:00.000Z' }),
    ]);

    const results = queryEarthquakes(db, { startUtc: '2025-01-01T00:00:00.000Z' });

    expect(results.map((e) => e.id)).toEqual(['recent']);
  });

  it('replaces an event with the same id rather than duplicating it', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent({ magnitude: 5.0 })]);
    insertEarthquakes(db, [makeEvent({ magnitude: 5.4 })]);

    const results = queryEarthquakes(db);

    expect(results).toHaveLength(1);
    expect(results[0]?.magnitude).toBe(5.4);
  });

  it('preserves a null alertLevel and a true tsunami flag through the round trip', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent({ alertLevel: 'orange', tsunami: true })]);

    const [result] = queryEarthquakes(db);

    expect(result?.alertLevel).toBe('orange');
    expect(result?.tsunami).toBe(true);
  });

  it('finds events inside a bounding box via the rtree index, and excludes ones outside it', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [
      makeEvent({ id: 'inside', longitude: -112.14, latitude: 36.05 }),
      makeEvent({ id: 'outside', longitude: 100, latitude: -30 }),
    ]);

    const results = queryEarthquakesInBoundingBox(db, {
      minLon: -120,
      maxLon: -100,
      minLat: 30,
      maxLat: 40,
    });

    expect(results.map((e) => e.id)).toEqual(['inside']);
  });

  it('keeps the rtree entry in sync after an event is re-ingested (row_id must stay stable)', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent({ longitude: 0, latitude: 0 })]);
    // Re-ingest the same event at a different location, as a real refresh
    // would if USGS revises an event's coordinates.
    insertEarthquakes(db, [makeEvent({ longitude: -112.14, latitude: 36.05 })]);

    const stale = queryEarthquakesInBoundingBox(db, {
      minLon: -1,
      maxLon: 1,
      minLat: -1,
      maxLat: 1,
    });
    const updated = queryEarthquakesInBoundingBox(db, {
      minLon: -120,
      maxLon: -100,
      minLat: 30,
      maxLat: 40,
    });

    expect(stale).toHaveLength(0);
    expect(updated.map((e) => e.id)).toEqual(['us0001']);
  });
});

describe('catalogSignature', () => {
  it('reports zero for an empty catalogue', () => {
    const db = openDatabase(':memory:');
    expect(catalogSignature(db)).toEqual({ count: 0, latestUpdatedUtc: null });
  });

  it('is unchanged when re-ingesting identical data', () => {
    // The whole point: a poll that finds nothing new must not look like a
    // change, or the renderer rebuilds and closes the user's open inspector.
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent()]);
    const before = catalogSignature(db);

    insertEarthquakes(db, [makeEvent()]);

    expect(signaturesMatch(before, catalogSignature(db))).toBe(true);
  });

  it('changes when a new event arrives', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent({ id: 'first' })]);
    const before = catalogSignature(db);

    insertEarthquakes(db, [makeEvent({ id: 'second' })]);

    expect(signaturesMatch(before, catalogSignature(db))).toBe(false);
  });

  it('changes when an existing event is revised, without the count moving', () => {
    // USGS refines magnitudes and flips status automatic→reviewed for hours
    // after an event. Row count alone would miss it entirely.
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent({ magnitude: 5.0, updatedUtc: '2026-07-20T12:05:00.000Z' })]);
    const before = catalogSignature(db);

    insertEarthquakes(db, [
      makeEvent({ magnitude: 5.4, status: 'reviewed', updatedUtc: '2026-07-20T14:30:00.000Z' }),
    ]);
    const after = catalogSignature(db);

    expect(after.count).toBe(before.count);
    expect(signaturesMatch(before, after)).toBe(false);
  });
});
