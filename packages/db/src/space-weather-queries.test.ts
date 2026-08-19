import { describe, expect, it } from 'vitest';
import type { SpaceWeatherSample } from '@terra-pulse/schema';
import { openDatabase } from './client';
import {
  insertSpaceWeather,
  querySpaceWeather,
  spaceWeatherCoverage,
  spaceWeatherYearsPresent,
} from './space-weather-queries';

const hour = (
  iso: string,
  kp: number | null,
  dst: number | null,
  windSpeed: number | null = null,
  bzGsm: number | null = null,
  density: number | null = null,
  xrayFlux: number | null = null,
): SpaceWeatherSample => ({
  timeUtc: iso,
  kp,
  dst,
  windSpeed,
  density,
  bzGsm,
  xrayFlux,
});

const fresh = () => openDatabase(':memory:');

describe('insertSpaceWeather', () => {
  it('stores and reads back a batch', () => {
    const db = fresh();
    insertSpaceWeather(db, [
      hour('1989-03-14T00:00:00.000Z', 9, -565),
      hour('1989-03-14T01:00:00.000Z', 9, -589),
    ]);

    const rows = querySpaceWeather(db, '1989-03-14T00:00:00.000Z', '1989-03-15T00:00:00.000Z');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.dst).toBe(-589);
  });

  it('is idempotent on the hour, so a refetch overwrites rather than duplicating', () => {
    // Provisional data being replaced by final is the normal case for Dst.
    const db = fresh();
    insertSpaceWeather(db, [hour('2020-01-01T00:00:00.000Z', 3, -10)]);
    insertSpaceWeather(db, [hour('2020-01-01T00:00:00.000Z', 3, -14)]);

    const rows = querySpaceWeather(db, '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dst).toBe(-14);
  });

  it('does not let a null erase a value we already have', () => {
    // Two sources with different coverage, or a pass that carries Kp but not
    // Dst. A gap must not overwrite a measurement.
    const db = fresh();
    insertSpaceWeather(db, [hour('2020-06-01T00:00:00.000Z', 4, -30)]);
    insertSpaceWeather(db, [hour('2020-06-01T00:00:00.000Z', null, null)]);

    const [row] = querySpaceWeather(db, '2020-06-01T00:00:00.000Z', '2020-06-02T00:00:00.000Z');
    expect(row?.kp).toBe(4);
    expect(row?.dst).toBe(-30);
  });

  it('keeps a genuinely missing index null rather than zero', () => {
    // Zero would read as "quiet", which is a measurement nobody made.
    const db = fresh();
    insertSpaceWeather(db, [hour('2020-06-02T00:00:00.000Z', null, -30)]);
    const [row] = querySpaceWeather(db, '2020-06-02T00:00:00.000Z', '2020-06-03T00:00:00.000Z');
    expect(row?.kp).toBeNull();
    expect(row?.dst).toBe(-30);
  });

  it('does nothing for an empty batch', () => {
    const db = fresh();
    expect(insertSpaceWeather(db, [])).toBe(0);
  });

  it('stores and reads back X-ray flux independently of the other indices', () => {
    const db = fresh();
    insertSpaceWeather(db, [hour('2024-05-10T00:00:00.000Z', 3, -20, null, null, null, 5e-5)]);
    const [row] = querySpaceWeather(db, '2024-05-10T00:00:00.000Z', '2024-05-11T00:00:00.000Z');
    expect(row?.xrayFlux).toBe(5e-5);
  });

  it('does not let a null erase a stored flux value either', () => {
    const db = fresh();
    insertSpaceWeather(db, [hour('2024-05-10T00:00:00.000Z', null, null, null, null, null, 1e-6)]);
    insertSpaceWeather(db, [hour('2024-05-10T00:00:00.000Z', null, null, null, null, null, null)]);
    const [row] = querySpaceWeather(db, '2024-05-10T00:00:00.000Z', '2024-05-11T00:00:00.000Z');
    expect(row?.xrayFlux).toBe(1e-6);
  });
});

describe('querySpaceWeather', () => {
  it('is bounded at both ends and half-open at the top', () => {
    // Unbounded over a full backfill is 550,000 rows and ~30 MB of structured
    // clone across IPC — the mistake `earthquakes:refresh` already made once.
    const db = fresh();
    insertSpaceWeather(db, [
      hour('2020-01-01T00:00:00.000Z', 1, -1),
      hour('2020-01-02T00:00:00.000Z', 2, -2),
      hour('2020-01-03T00:00:00.000Z', 3, -3),
    ]);

    const rows = querySpaceWeather(db, '2020-01-01T00:00:00.000Z', '2020-01-03T00:00:00.000Z');
    expect(rows.map((r) => r.kp)).toEqual([1, 2]);
  });

  it('returns samples oldest first', () => {
    const db = fresh();
    insertSpaceWeather(db, [
      hour('2020-01-02T00:00:00.000Z', 2, -2),
      hour('2020-01-01T00:00:00.000Z', 1, -1),
    ]);
    const rows = querySpaceWeather(db, '2020-01-01T00:00:00.000Z', '2020-02-01T00:00:00.000Z');
    expect(rows[0]?.kp).toBe(1);
  });
});

describe('coverage helpers', () => {
  it('reports which years hold data, so a backfill can skip them', () => {
    const db = fresh();
    insertSpaceWeather(db, [
      hour('1975-05-05T00:00:00.000Z', 1, -1),
      hour('2001-05-05T00:00:00.000Z', 2, -2),
    ]);
    expect(spaceWeatherYearsPresent(db, 'kp')).toEqual(new Set([1975, 2001]));
    expect(spaceWeatherYearsPresent(db, 'dst')).toEqual(new Set([1975, 2001]));
  });

  it('does not let one index vouch for the other', () => {
    // The case this exists for: GFZ's Kp fetch is a single request covering
    // 1932 to today, so after it every year holds samples. A Dst backfill
    // keyed on "any sample present" would skip all of them and silently never
    // fetch Dst — no error, and a track with no Dst on it.
    const db = fresh();
    insertSpaceWeather(db, [
      hour('1940-05-05T00:00:00.000Z', 3, null),
      hour('1975-05-05T00:00:00.000Z', 4, -30),
    ]);

    expect(spaceWeatherYearsPresent(db, 'kp')).toEqual(new Set([1940, 1975]));
    expect(spaceWeatherYearsPresent(db, 'dst')).toEqual(new Set([1975]));
  });

  it('reports the span and the count', () => {
    const db = fresh();
    insertSpaceWeather(db, [
      hour('1975-05-05T00:00:00.000Z', 1, -1),
      hour('2001-05-05T00:00:00.000Z', 2, -2),
    ]);
    const coverage = spaceWeatherCoverage(db);
    expect(coverage.samples).toBe(2);
    expect(coverage.firstUtc).toBe('1975-05-05T00:00:00.000Z');
    expect(coverage.lastUtc).toBe('2001-05-05T00:00:00.000Z');
  });

  it('reports an empty table honestly', () => {
    const coverage = spaceWeatherCoverage(fresh());
    expect(coverage.samples).toBe(0);
    expect(coverage.firstUtc).toBeNull();
  });
});
