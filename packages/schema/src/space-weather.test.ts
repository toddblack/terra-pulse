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
});

describe('storm thresholds', () => {
  it('keeps the display threshold clear of H4s registered trigger', () => {
    // H4 tests Kp >= 6. This is 5 (NOAA G1) and exists only for emphasis on the
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
  it('returns the series untouched when it already fits', () => {
    const samples = [at(0, 1, -5), at(1, 2, -8)];
    expect(downsampleSpaceWeather(samples, 10)).toEqual(samples);
  });

  it('keeps the extreme of each bucket, not the mean', () => {
    // The whole point. A storm is a spike a few hours long; averaging a decade
    // into 300 buckets flattens every storm in the record into the background
    // and produces a chart whose subject is missing.
    const quiet = Array.from({ length: 20 }, (_, i) => at(i, 1, -5));
    const withSpike = [...quiet];
    withSpike[7] = at(7, 9, -589);

    const [first, second] = downsampleSpaceWeather(withSpike, 2);
    expect(first?.kp).toBe(9);
    expect(first?.dst).toBe(-589);
    // The quiet half stays quiet.
    expect(second?.kp).toBe(1);
    expect(second?.dst).toBe(-5);
  });

  it('takes the most negative Dst, because that is the disturbed direction', () => {
    const samples = [at(0, null, 20), at(1, null, -300), at(2, null, 10)];
    expect(downsampleSpaceWeather(samples, 1)[0]?.dst).toBe(-300);
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
    expect(buckets.every((b) => b.kp === null)).toBe(true);
    expect(buckets.every((b) => b.dst !== null)).toBe(true);
  });

  it('handles the empty and degenerate cases', () => {
    expect(downsampleSpaceWeather([], 10)).toEqual([]);
    expect(downsampleSpaceWeather([at(0, 1, -1)], 0)).toEqual([]);
  });
});
