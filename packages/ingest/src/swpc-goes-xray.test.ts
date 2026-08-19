import { describe, expect, it } from 'vitest';
import { parseSwpcGoesXray } from './swpc-goes-xray';

/**
 * The product's real shape: one object per minute per channel, verified live
 * — `flux`/`observed_flux`/`electron_correction`/`electron_contaminaton`/
 * `energy`, with exactly two `energy` values (`0.05-0.4nm` short,
 * `0.1-0.8nm` long) present for every timestamp.
 */
function record(timeIso: string, flux: number | null, energy = '0.1-0.8nm') {
  return {
    time_tag: timeIso,
    satellite: 18,
    flux,
    observed_flux: flux,
    electron_correction: 0,
    electron_contaminaton: false,
    energy,
  };
}

describe('parseSwpcGoesXray', () => {
  it('keeps only the long channel, which flare classification is defined on', () => {
    const samples = parseSwpcGoesXray([
      record('2026-08-15T05:00:00Z', 9e-9, '0.05-0.4nm'),
      record('2026-08-15T05:00:00Z', 3.4e-7, '0.1-0.8nm'),
    ]);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.xrayFlux).toBe(3.4e-7);
  });

  it('takes the peak within an hour, not the mean', () => {
    // The opposite choice from the solar-wind adapter, deliberately: a flare
    // is a spike lasting minutes against a background that can be orders of
    // magnitude quieter, so a mean would dilute it toward invisibility
    // before the data even reaches downsampleSpaceWeather's own peak/typical
    // split downstream.
    const samples = parseSwpcGoesXray([
      record('2026-08-15T05:00:00Z', 1e-7),
      record('2026-08-15T05:15:00Z', 5e-5), // M5.0
      record('2026-08-15T05:30:00Z', 1.2e-7),
    ]);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.xrayFlux).toBe(5e-5);
  });

  it('splits across hour boundaries', () => {
    const samples = parseSwpcGoesXray([
      record('2026-08-15T04:59:00Z', 1e-7),
      record('2026-08-15T05:01:00Z', 3e-6),
    ]);
    expect(samples.map((s) => s.timeUtc)).toEqual([
      '2026-08-15T04:00:00.000Z',
      '2026-08-15T05:00:00.000Z',
    ]);
  });

  it('never invents Kp, Dst, wind speed or Bz', () => {
    // This product carries none of them, and a zero would be a measurement.
    const [sample] = parseSwpcGoesXray([record('2026-08-15T05:00:00Z', 1e-7)]);
    expect(sample?.kp).toBeNull();
    expect(sample?.dst).toBeNull();
    expect(sample?.windSpeed).toBeNull();
    expect(sample?.bzGsm).toBeNull();
  });

  it('drops a non-finite or non-positive flux rather than plotting it on a log scale', () => {
    const samples = parseSwpcGoesXray([
      record('2026-08-15T05:00:00Z', null),
      record('2026-08-15T05:01:00Z', 0),
      record('2026-08-15T05:02:00Z', -1e-8),
      record('2026-08-15T05:03:00Z', Number.NaN),
    ]);
    expect(samples).toEqual([]);
  });

  it('ignores an unparseable timestamp instead of bucketing it at the epoch', () => {
    const samples = parseSwpcGoesXray([record('not a date', 1e-7)]);
    expect(samples).toEqual([]);
  });

  it('returns samples oldest first', () => {
    const samples = parseSwpcGoesXray([
      record('2026-08-15T06:00:00Z', 1e-7),
      record('2026-08-15T05:00:00Z', 2e-7),
    ]);
    expect(samples.map((s) => s.timeUtc)).toEqual([
      '2026-08-15T05:00:00.000Z',
      '2026-08-15T06:00:00.000Z',
    ]);
  });

  it('rejects a payload that is not an array', () => {
    expect(() => parseSwpcGoesXray(null)).toThrow();
    expect(() => parseSwpcGoesXray({ error: 'nope' })).toThrow();
  });

  it('handles an empty payload', () => {
    expect(parseSwpcGoesXray([])).toEqual([]);
  });
});
