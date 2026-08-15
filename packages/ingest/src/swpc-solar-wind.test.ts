import { describe, expect, it } from 'vitest';
import { parseSwpcSolarWind } from './swpc-solar-wind';

/**
 * The product's real shape: a header row, then one row per minute.
 *
 * Fixture-based rather than networked, like the aurora and OMNI adapters — the
 * parser was checked once against the live feed (10,008 rows over seven days,
 * no null speeds, propagation offset 59.4 minutes) and these encode that
 * behaviour without making the suite depend on SWPC being up.
 */
const HEADER = [
  'time_tag',
  'speed',
  'density',
  'temperature',
  'bx',
  'by',
  'bz',
  'bt',
  'vx',
  'vy',
  'vz',
  'propagated_time_tag',
];

/** One minute, with the ~59 min propagation offset the real feed carries. */
function row(
  observedIso: string,
  propagatedIso: string,
  speed: number | null,
  bz: number | null,
  density: number | null = 4.4,
): unknown[] {
  return [observedIso, speed, density, 112141, -3.46, -0.03, bz, 4, -360, 27, -27, propagatedIso];
}

describe('parseSwpcSolarWind', () => {
  it('buckets by the propagated time, not the observation time', () => {
    // The whole reason this product is used instead of the raw L1 stream: OMNI
    // is time-shifted to the bow shock nose and so is this. The offset was 59.4
    // minutes on a 362 km/s wind, so the two timestamps routinely fall in
    // different hours — a whole bucket apart at this resolution.
    const samples = parseSwpcSolarWind([
      HEADER,
      row('2026-08-15T05:21:00Z', '2026-08-15T06:20:24Z', 362, 1.9),
    ]);

    expect(samples).toHaveLength(1);
    expect(samples[0]?.timeUtc).toBe('2026-08-15T06:00:00.000Z');
  });

  it('averages the minutes within an hour', () => {
    // A mean, not an extreme: speed and Bz are linear physical quantities, and
    // OMNI's own hourly values are averages of high-resolution data. Taking a
    // peak here would make the recent week disagree in kind with the history.
    const samples = parseSwpcSolarWind([
      HEADER,
      row('2026-08-15T05:00:00Z', '2026-08-15T06:01:00Z', 400, 2),
      row('2026-08-15T05:01:00Z', '2026-08-15T06:02:00Z', 500, -2),
      row('2026-08-15T05:02:00Z', '2026-08-15T06:03:00Z', 600, 6),
    ]);

    expect(samples).toHaveLength(1);
    expect(samples[0]?.windSpeed).toBe(500);
    expect(samples[0]?.bzGsm).toBe(2);
  });

  it('splits across hour boundaries', () => {
    const samples = parseSwpcSolarWind([
      HEADER,
      row('2026-08-15T04:59:00Z', '2026-08-15T05:59:00Z', 300, 1),
      row('2026-08-15T05:01:00Z', '2026-08-15T06:01:00Z', 700, 3),
    ]);

    expect(samples.map((s) => s.timeUtc)).toEqual([
      '2026-08-15T05:00:00.000Z',
      '2026-08-15T06:00:00.000Z',
    ]);
    expect(samples[0]?.windSpeed).toBe(300);
    expect(samples[1]?.windSpeed).toBe(700);
  });

  it('skips a dropout per field rather than per row', () => {
    // A minute with a good speed and no magnetometer still contributes its
    // speed. Dropping the whole row would discard a measurement that is there.
    const samples = parseSwpcSolarWind([
      HEADER,
      row('2026-08-15T05:00:00Z', '2026-08-15T06:01:00Z', 400, null),
      row('2026-08-15T05:01:00Z', '2026-08-15T06:02:00Z', null, 4),
    ]);

    expect(samples).toHaveLength(1);
    expect(samples[0]?.windSpeed).toBe(400);
    expect(samples[0]?.bzGsm).toBe(4);
  });

  it('emits nothing for an hour where every field dropped out', () => {
    const samples = parseSwpcSolarWind([
      HEADER,
      row('2026-08-15T05:00:00Z', '2026-08-15T06:01:00Z', null, null, null),
    ]);
    expect(samples).toEqual([]);
  });

  it('keeps an hour that has only density, which the magnetopause still needs', () => {
    const [sample] = parseSwpcSolarWind([
      HEADER,
      row('2026-08-15T05:00:00Z', '2026-08-15T06:01:00Z', null, null, 6.2),
    ]);
    expect(sample?.density).toBe(6.2);
    expect(sample?.windSpeed).toBeNull();
  });

  it('averages density alongside speed', () => {
    // Dynamic pressure goes as density x speed^2, so a wrong density is a wrong
    // magnetopause — it gets the same treatment as the other fields, not a
    // sample-and-hold.
    const [sample] = parseSwpcSolarWind([
      HEADER,
      row('2026-08-15T05:00:00Z', '2026-08-15T06:01:00Z', 400, 1, 4),
      row('2026-08-15T05:01:00Z', '2026-08-15T06:02:00Z', 400, 1, 6),
    ]);
    expect(sample?.density).toBe(5);
  });

  it('never invents Kp or Dst', () => {
    // This product carries neither, and a zero would be a measurement.
    const [sample] = parseSwpcSolarWind([
      HEADER,
      row('2026-08-15T05:00:00Z', '2026-08-15T06:01:00Z', 400, 2),
    ]);
    expect(sample?.kp).toBeNull();
    expect(sample?.dst).toBeNull();
  });

  it('reads columns by name, so an inserted column cannot shift the mapping', () => {
    // The header is in the payload, so there is no reason to hard-code offsets
    // that a future column would silently move.
    const reordered = ['propagated_time_tag', 'bz', 'speed'];
    const samples = parseSwpcSolarWind([reordered, ['2026-08-15T06:01:00Z', 5, 450]]);

    expect(samples[0]?.windSpeed).toBe(450);
    expect(samples[0]?.bzGsm).toBe(5);
  });

  it('returns samples oldest first even if the feed is not ordered', () => {
    // The propagation shift scales with wind speed, so rows can emerge slightly
    // out of order across a sharp speed change.
    const samples = parseSwpcSolarWind([
      HEADER,
      row('2026-08-15T06:00:00Z', '2026-08-15T08:00:00Z', 300, 1),
      row('2026-08-15T05:00:00Z', '2026-08-15T07:00:00Z', 700, 2),
    ]);
    expect(samples.map((s) => s.timeUtc)).toEqual([
      '2026-08-15T07:00:00.000Z',
      '2026-08-15T08:00:00.000Z',
    ]);
  });

  it('rejects a payload with no header rather than guessing', () => {
    expect(() => parseSwpcSolarWind([])).toThrow();
    expect(() => parseSwpcSolarWind([HEADER])).toThrow();
    expect(() => parseSwpcSolarWind([['time_tag', 'density'], ['x', 1]])).toThrow(/missing/i);
  });

  it('ignores an unparseable timestamp instead of bucketing it at the epoch', () => {
    const samples = parseSwpcSolarWind([HEADER, row('nope', 'not a date', 400, 2)]);
    expect(samples).toEqual([]);
  });
});
