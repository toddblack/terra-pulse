import { describe, expect, it } from 'vitest';
import {
  DST_START_YEAR,
  DST_STORM_THRESHOLD,
  KP_START_YEAR,
  KP_STORM_THRESHOLD,
  downsampleSpaceWeather,
  isStormy,
  type SpaceWeatherSample,
} from './space-weather';

const at = (hour: number, kp: number | null, dst: number | null): SpaceWeatherSample => ({
  timeUtc: new Date(Date.UTC(2000, 0, 1, hour)).toISOString(),
  kp,
  dst,
  // The track draws Kp and Dst; the wind fields ride the same rows but are not
  // part of what these tests exercise.
  windSpeed: null,
  density: null,
  bzGsm: null,
});

describe('storm thresholds', () => {
  it('keeps the display threshold clear of H4cs registered trigger', () => {
    // H4c tests Kp >= 6. This is 5 (NOAA G1) and exists only for emphasis on the
    // track. A display threshold drifting into the analysis is exactly the
    // free-parameter-after-the-fact non-negotiable #3 forbids.
    expect(KP_STORM_THRESHOLD).toBeLessThan(6);
  });

  it('flags a storm by either index', () => {
    expect(isStormy(at(0, KP_STORM_THRESHOLD, null))).toBe(true);
    expect(isStormy(at(0, null, DST_STORM_THRESHOLD))).toBe(true);
    expect(isStormy(at(0, 2, -10))).toBe(false);
  });

  it('does not read a missing index as quiet', () => {
    expect(isStormy(at(0, null, null))).toBe(false);
    // ...but nor as stormy: absence is not evidence either way.
    expect(isStormy(at(0, null, -500))).toBe(true);
  });

  it('lets Kp reach further back than Dst', () => {
    // Different publishers, genuinely different depths: GFZ has Kp from 1932,
    // Kyoto/OMNI has Dst from 1963. Code that assumes one number for both would
    // either hide thirty-one years of Kp or ask OMNI for years it does not have.
    expect(KP_START_YEAR).toBe(1932);
    expect(DST_START_YEAR).toBe(1963);
    expect(KP_START_YEAR).toBeLessThan(DST_START_YEAR);
  });
});

describe('downsampleSpaceWeather', () => {
  it('gives every sample its own bucket when the series already fits', () => {
    const buckets = downsampleSpaceWeather([at(0, 1, -5), at(1, 2, -8)], 10);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]?.peakKp).toBe(1);
    expect(buckets[0]?.typicalKp).toBe(1);
    expect(buckets[1]?.peakDst).toBe(-8);
    // A one-hour bucket has nothing to summarise, so both marks coincide.
    expect(buckets[1]?.hours).toBe(1);
  });

  it('keeps the extreme of each bucket, not the mean', () => {
    // The whole point. A storm is a spike a few hours long; averaging a decade
    // into 300 buckets flattens every storm in the record into the background
    // and produces a chart whose subject is missing.
    const quiet = Array.from({ length: 20 }, (_, i) => at(i, 1, -5));
    const withSpike = [...quiet];
    withSpike[7] = at(7, 9, -589);

    const [first, second] = downsampleSpaceWeather(withSpike, 2);
    expect(first?.peakKp).toBe(9);
    expect(first?.peakDst).toBe(-589);
    // The quiet half stays quiet.
    expect(second?.peakKp).toBe(1);
    expect(second?.peakDst).toBe(-5);
  });

  it('carries a typical alongside the peak, so one spike does not paint the span', () => {
    // The failure this fixes: with the peak alone, a decade of quiet years each
    // containing one storm draws identically to a decade of continuous
    // disturbance. The typical is what separates them.
    const quiet = Array.from({ length: 20 }, (_, i) => at(i, 1, -5));
    const withSpike = [...quiet];
    withSpike[7] = at(7, 9, -589);

    const [first] = downsampleSpaceWeather(withSpike, 2);
    expect(first?.peakKp).toBe(9);
    expect(first?.typicalKp).toBe(1);
  });

  it('takes a median that was actually observed, never a mean', () => {
    // Kp is quasi-logarithmic, so the mean of two Kp values is not a meaningful
    // quantity — ap is the linear equivalent. The median is an order statistic:
    // it selects a reading rather than computing a new one.
    const even = downsampleSpaceWeather([at(0, 1, null), at(1, 8, null)], 1);
    // Not 4.5, which is neither observed nor a legal Kp.
    expect(even[0]?.typicalKp).toBe(1);

    const odd = downsampleSpaceWeather([at(0, 1, null), at(1, 8, null), at(2, 2, null)], 1);
    expect(odd[0]?.typicalKp).toBe(2);
  });

  it('keeps the median on Kp own scale', () => {
    // Every value it can return is one of the 28 published Kp values, because
    // it only ever selects one of its inputs.
    const samples = [at(0, 0.333, null), at(1, 0.667, null), at(2, 3.333, null), at(3, 4, null)];
    const typical = downsampleSpaceWeather(samples, 1)[0]?.typicalKp;
    expect(samples.some((s) => s.kp === typical)).toBe(true);
  });

  it('takes the most negative Dst, because that is the disturbed direction', () => {
    const samples = [at(0, null, 20), at(1, null, -300), at(2, null, 10)];
    expect(downsampleSpaceWeather(samples, 1)[0]?.peakDst).toBe(-300);
  });

  it('labels a bucket with a time that actually exists', () => {
    // Its first hour, rather than an interpolated midpoint that was never a
    // real sample.
    const samples = Array.from({ length: 8 }, (_, i) => at(i, 1, -1));
    const [first] = downsampleSpaceWeather(samples, 2);
    expect(first?.timeUtc).toBe(samples[0]?.timeUtc);
  });

  it('produces at most the requested number of buckets', () => {
    const samples = Array.from({ length: 1000 }, (_, i) => at(i % 24, 2, -9));
    expect(downsampleSpaceWeather(samples, 37).length).toBeLessThanOrEqual(37);
  });

  it('survives a series where one index is entirely missing', () => {
    const samples = Array.from({ length: 50 }, (_, i) => at(i % 24, null, -i));
    const buckets = downsampleSpaceWeather(samples, 5);
    expect(buckets.every((b) => b.peakKp === null && b.typicalKp === null)).toBe(true);
    expect(buckets.every((b) => b.peakDst !== null)).toBe(true);
  });

  it('handles the empty and degenerate cases', () => {
    expect(downsampleSpaceWeather([], 10)).toEqual([]);
    expect(downsampleSpaceWeather([at(0, 1, -1)], 0)).toEqual([]);
  });
});
