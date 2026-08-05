import { describe, expect, it } from 'vitest';
import type { EarthquakeEvent } from '@terra-pulse/schema';
import { openDatabase } from './client';
import { readSeenThrough, writeSeenThrough } from './app-state';
import { countMissedEarthquakes, insertEarthquakes, queryMissedEarthquakes } from './queries';

function makeEvent(overrides: Partial<EarthquakeEvent> = {}): EarthquakeEvent {
  return {
    id: 'us0001',
    source: 'usgs',
    magnitude: 6.2,
    magnitudeType: 'mww',
    place: 'Somewhere',
    timeUtc: '2026-07-20T12:00:00.000Z',
    updatedUtc: '2026-07-20T12:05:00.000Z',
    longitude: -112.14,
    latitude: 36.05,
    depthKm: 10,
    status: 'reviewed',
    tsunami: false,
    alertLevel: null,
    significance: 700,
    url: 'https://example.test',
    ...overrides,
  };
}

const SINCE = '2026-07-19T00:00:00.000Z';

describe('seen-through watermark', () => {
  it('is null on a first-ever launch, so nothing can have been missed', () => {
    expect(readSeenThrough(openDatabase(':memory:'))).toBeNull();
  });

  it('round-trips and overwrites rather than accumulating', () => {
    const db = openDatabase(':memory:');

    writeSeenThrough(db, '2026-07-20T00:00:00.000Z');
    writeSeenThrough(db, '2026-07-21T00:00:00.000Z');

    expect(readSeenThrough(db)).toBe('2026-07-21T00:00:00.000Z');
    const rows = db.prepare('SELECT COUNT(*) AS n FROM app_state').get();
    expect(Number(rows?.['n'])).toBe(1);
  });
});

describe('queryMissedEarthquakes', () => {
  it('returns only events after the watermark', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [
      makeEvent({ id: 'before', timeUtc: '2026-07-18T00:00:00.000Z' }),
      makeEvent({ id: 'after', timeUtc: '2026-07-20T00:00:00.000Z' }),
    ]);

    expect(queryMissedEarthquakes(db, SINCE, 5.8, 10).map((e) => e.id)).toEqual(['after']);
  });

  it('treats an event exactly on the watermark as already seen', () => {
    // Exclusive, because the watermark is written *at* a poll that saw it.
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent({ id: 'boundary', timeUtc: SINCE })]);

    expect(queryMissedEarthquakes(db, SINCE, 5.8, 10)).toEqual([]);
  });

  it('applies the magnitude threshold', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [
      makeEvent({ id: 'small', magnitude: 5.7 }),
      makeEvent({ id: 'big', magnitude: 5.8 }),
    ]);

    expect(queryMissedEarthquakes(db, SINCE, 5.8, 10).map((e) => e.id)).toEqual(['big']);
  });

  it('orders by magnitude so the cap can never hide the biggest', () => {
    // The failure this prevents: away three months, a chronological list caps
    // at ten M5.9s and the M7.5 never appears.
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [
      ...Array.from({ length: 12 }, (_, i) =>
        makeEvent({
          id: `small-${String(i)}`,
          magnitude: 5.9,
          timeUtc: `2026-07-${String(20 + (i % 8)).padStart(2, '0')}T12:00:00.000Z`,
        }),
      ),
      makeEvent({ id: 'the-big-one', magnitude: 7.5, timeUtc: '2026-07-19T01:00:00.000Z' }),
    ]);

    const shown = queryMissedEarthquakes(db, SINCE, 5.8, 10);

    expect(shown).toHaveLength(10);
    expect(shown[0]?.id).toBe('the-big-one');
  });

  it('counts everything that qualifies, not just what fits', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(
      db,
      Array.from({ length: 14 }, (_, i) =>
        makeEvent({ id: `e${String(i)}`, timeUtc: '2026-07-20T12:00:00.000Z' }),
      ),
    );

    expect(queryMissedEarthquakes(db, SINCE, 5.8, 10)).toHaveLength(10);
    expect(countMissedEarthquakes(db, SINCE, 5.8)).toBe(14);
  });

  it('reports nothing for a quiet absence', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent({ id: 'small', magnitude: 3 })]);

    expect(countMissedEarthquakes(db, SINCE, 5.8)).toBe(0);
    expect(queryMissedEarthquakes(db, SINCE, 5.8, 10)).toEqual([]);
  });
});
