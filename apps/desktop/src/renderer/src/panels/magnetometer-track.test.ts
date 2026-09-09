import { describe, expect, it } from 'vitest';
import { STATION_DISTURBED_NT, type MagnetometerSample } from '@terra-pulse/schema';
import { heightOf } from './space-weather-track';
import {
  layoutMagnetometerTrack,
  MAGNETOMETER_MAX_WINDOW_HOURS,
  MAGNETOMETER_RANGE_MAX_NT,
  MAGNETOMETER_RANGE_MIN_NT,
  peakMagnetometer,
} from './magnetometer-track';
import { nearestStation } from './useMagnetometerSeries';

const START = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;

/** Samples every minute, `hNt` from a generator. */
function series(count: number, h: (i: number) => number): MagnetometerSample[] {
  return Array.from({ length: count }, (_, i) => ({ timeMs: START + i * MINUTE, hNt: h(i) }));
}

describe('layoutMagnetometerTrack', () => {
  it('reports each bucket peak-to-peak, not the absolute field', () => {
    // The field sits at tens of thousands of nT; the disturbance is the swing.
    // A layout that leaked the absolute value would put every bar at full
    // scale forever.
    const samples = series(60, (i) => 21_000 + (i % 10));
    const bars = layoutMagnetometerTrack(samples, START, START + 60 * MINUTE, 6, 50);
    for (const bar of bars) {
      expect(bar.rangeNt).not.toBeNull();
      expect(bar.rangeNt).toBeLessThan(20);
    }
  });

  it('gives an empty bucket null, never zero', () => {
    // Zero is a claim the field held perfectly steady. Null is the truth, and
    // the row draws it as an absence — a station down mid-storm must not read
    // as a calm one.
    const samples = series(10, () => 21_000);
    const bars = layoutMagnetometerTrack(samples, START, START + 60 * MINUTE, 6, 50);
    expect(bars[0]?.rangeNt).not.toBeNull();
    expect(bars[5]?.rangeNt).toBeNull();
    expect(bars[5]?.samples).toBe(0);
  });

  it('gives a one-sample bucket null too', () => {
    // One reading has no range. Reporting 0 would be indistinguishable from a
    // genuinely steady bucket — the same rule parseDisturbance applies.
    const samples = [{ timeMs: START + 30 * MINUTE, hNt: 21_000 }];
    const bars = layoutMagnetometerTrack(samples, START, START + 60 * MINUTE, 6, 50);
    const occupied = bars.filter((bar) => bar.samples > 0);
    expect(occupied).toHaveLength(1);
    expect(occupied[0]?.rangeNt).toBeNull();
  });

  it('bins by time, not by sample index', () => {
    // Magnetometer traces have real gaps, so equal-index slices would not be
    // equal-time and this row would stop lining up with the rows above it.
    const samples: MagnetometerSample[] = [
      ...series(5, () => 21_000).map((s) => ({ ...s })),
      // A four-hour hole, then a burst.
      ...Array.from({ length: 5 }, (_, i) => ({
        timeMs: START + (240 + i) * MINUTE,
        hNt: 21_100 + i,
      })),
    ];
    const bars = layoutMagnetometerTrack(samples, START, START + 300 * MINUTE, 10, 50);
    // First bin (0-30 min) holds the first burst; the middle bins are empty.
    expect(bars[0]?.samples).toBe(5);
    expect(bars[4]?.samples).toBe(0);
    expect(bars[8]?.samples).toBeGreaterThan(0);
  });

  it('flags a bucket that reaches the display emphasis level', () => {
    const quiet = layoutMagnetometerTrack(
      series(10, (i) => 21_000 + i),
      START,
      START + 10 * MINUTE,
      1,
      STATION_DISTURBED_NT,
    );
    expect(quiet[0]?.disturbed).toBe(false);

    const stormy = layoutMagnetometerTrack(
      series(10, (i) => 21_000 + i * 20),
      START,
      START + 10 * MINUTE,
      1,
      STATION_DISTURBED_NT,
    );
    expect(stormy[0]?.disturbed).toBe(true);
  });

  it('returns nothing for an empty or inverted window', () => {
    expect(layoutMagnetometerTrack([], START, START, 10, 50)).toHaveLength(0);
    expect(layoutMagnetometerTrack([], START, START - MINUTE, 10, 50)).toHaveLength(0);
  });

  it('spans the track exactly', () => {
    const bars = layoutMagnetometerTrack([], START, START + 60 * MINUTE, 4, 50);
    expect(bars[0]?.x).toBe(0);
    const last = bars[3];
    expect(last?.x).toBeCloseTo(0.75, 10);
    expect((last?.x ?? 0) + (last?.width ?? 0)).toBeCloseTo(1, 10);
  });
});

describe('peakMagnetometer', () => {
  it('is null with nothing measured, and says so as 0% rather than as quiet', () => {
    const bars = layoutMagnetometerTrack([], START, START + 60 * MINUTE, 6, 50);
    const peak = peakMagnetometer(bars);
    expect(peak.rangeNt).toBeNull();
    expect(peak.measuredFraction).toBe(0);
  });

  it('reports 1 for an empty layout, so a bucketless window reads as "no data"', () => {
    expect(peakMagnetometer([]).measuredFraction).toBe(1);
  });

  it('takes the largest bucket range', () => {
    const samples = [
      ...series(5, (i) => 21_000 + i),
      ...Array.from({ length: 5 }, (_, i) => ({
        timeMs: START + (30 + i) * MINUTE,
        hNt: 21_000 + i * 100,
      })),
    ];
    const bars = layoutMagnetometerTrack(samples, START, START + 60 * MINUTE, 2, 50);
    expect(peakMagnetometer(bars).rangeNt).toBeCloseTo(400, 6);
  });
});

describe('the log scale', () => {
  it('separates a quiet interval from a storm, which a linear scale would not', () => {
    // The measured reason for the log scale: quiet is ~4 nT at Boulder and the
    // 2003 Halloween storm reached ~2,046 nT at College. Linear, the quiet
    // bucket is 0.2% of the row — indistinguishable from nothing.
    const quiet = heightOf(4, MAGNETOMETER_RANGE_MAX_NT, MAGNETOMETER_RANGE_MIN_NT);
    const storm = heightOf(2000, MAGNETOMETER_RANGE_MAX_NT, MAGNETOMETER_RANGE_MIN_NT);
    expect(quiet).toBeGreaterThan(0.15);
    expect(storm).toBeCloseTo(1, 3);

    const linearQuiet = heightOf(4, MAGNETOMETER_RANGE_MAX_NT);
    expect(linearQuiet).toBeLessThan(0.005);
  });

  it('puts the emphasis level in the middle of the row, not against an edge', () => {
    // If 50 nT sat at 3% or 97% the dashed line would be useless as a
    // reference, which is the practical test of the chosen domain.
    const line = heightOf(
      STATION_DISTURBED_NT,
      MAGNETOMETER_RANGE_MAX_NT,
      MAGNETOMETER_RANGE_MIN_NT,
    );
    expect(line).toBeGreaterThan(0.4);
    expect(line).toBeLessThan(0.75);
  });

  it('clamps rather than escaping the plot', () => {
    expect(heightOf(50_000, MAGNETOMETER_RANGE_MAX_NT, MAGNETOMETER_RANGE_MIN_NT)).toBe(1);
    expect(heightOf(0.01, MAGNETOMETER_RANGE_MAX_NT, MAGNETOMETER_RANGE_MIN_NT)).toBe(0);
  });
});

describe('the window limit', () => {
  it('is 30 days, which is 43,200 minute samples', () => {
    // The limit comes from the source: only sampling_period=60 returns values,
    // so every hour costs 60 samples and a year would be 525,600.
    expect(MAGNETOMETER_MAX_WINDOW_HOURS).toBe(720);
    expect(MAGNETOMETER_MAX_WINDOW_HOURS * 60).toBe(43_200);
  });
});

describe('nearestStation', () => {
  const stations = [
    { code: 'BOU', name: 'Boulder', latitude: 40.13, longitude: -105.24, agency: 'USGS' },
    { code: 'FRD', name: 'Fredericksburg', latitude: 38.2, longitude: -77.37, agency: 'USGS' },
    { code: 'CMO', name: 'College', latitude: 64.87, longitude: -147.86, agency: 'USGS' },
  ];

  it('picks the closest', () => {
    // Denver is beside Boulder.
    expect(nearestStation({ latitude: 39.74, longitude: -104.99 }, stations)?.station.code).toBe(
      'BOU',
    );
    // Washington DC is beside Fredericksburg.
    expect(nearestStation({ latitude: 38.9, longitude: -77.04 }, stations)?.station.code).toBe(
      'FRD',
    );
  });

  it('reports a real distance, because "nearest" is often very far', () => {
    // The honest half of this feature: the USGS network is ~31 stations and
    // heavily northern, so for most of the world the nearest observatory is
    // thousands of km away and the row has to be able to say so.
    const tokyo = nearestStation({ latitude: 35.7, longitude: 139.7 }, stations);
    expect(tokyo?.distanceKm).toBeGreaterThan(5000);
  });

  it('is null with no stations, which is not the same as none being near', () => {
    expect(nearestStation({ latitude: 0, longitude: 0 }, [])).toBeNull();
  });
});
