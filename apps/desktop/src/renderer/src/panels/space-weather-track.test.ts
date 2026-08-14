import { describe, expect, it } from 'vitest';
import type { SpaceWeatherSample } from '@terra-pulse/schema';
import { bucketsForWidth, layoutTrack, peakOf } from './space-weather-track';

const START = Date.UTC(2020, 0, 1);
const END = Date.UTC(2020, 0, 2);

const at = (hour: number, kp: number | null, dst: number | null): SpaceWeatherSample => ({
  timeUtc: new Date(Date.UTC(2020, 0, 1, hour)).toISOString(),
  kp,
  dst,
});

describe('layoutTrack', () => {
  it('positions a bar by its timestamp, not its index', () => {
    // The whole point. Gaps in the record are common — OMNI has them and a
    // partial backfill has whole missing years — and index-based spacing would
    // close those gaps silently, drawing a continuous record that doesn't exist.
    const bars = layoutTrack([at(0, 1, -1), at(18, 2, -2)], START, END, 0.01);
    expect(bars[0]?.x).toBeCloseTo(0, 5);
    expect(bars[1]?.x).toBeCloseTo(18 / 24, 5);
  });

  it('leaves a hole where the record has one', () => {
    const bars = layoutTrack([at(0, 1, -1), at(23, 1, -1)], START, END, 0.01);
    expect(bars).toHaveLength(2);
    // Nothing invented in between.
    expect(bars[1]!.x - bars[0]!.x).toBeGreaterThan(0.9);
  });

  it('scales bar height by Kp against its fixed 0-9 range', () => {
    const [bar] = layoutTrack([at(0, 9, null)], START, END, 0.01);
    expect(bar?.height).toBe(1);
    expect(layoutTrack([at(0, 4.5, null)], START, END, 0.01)[0]?.height).toBeCloseTo(0.5, 5);
  });

  it('does not let Dst drive height', () => {
    // Dst is unbounded below: one -589 nT hour would flatten every other bar in
    // the record, and that hour is exactly what you want to see in context.
    const [quiet] = layoutTrack([at(0, 2, -589)], START, END, 0.01);
    const [same] = layoutTrack([at(0, 2, -5)], START, END, 0.01);
    expect(quiet?.height).toBe(same?.height);
  });

  it('gives a missing Kp no height rather than a default one', () => {
    expect(layoutTrack([at(0, null, -300)], START, END, 0.01)[0]?.height).toBe(0);
  });

  it('flags storm-level hours', () => {
    expect(layoutTrack([at(0, 5, null)], START, END, 0.01)[0]?.stormy).toBe(true);
    expect(layoutTrack([at(0, 4, null)], START, END, 0.01)[0]?.stormy).toBe(false);
  });

  it('drops samples outside the window', () => {
    const outside: SpaceWeatherSample = { timeUtc: '2019-06-01T00:00:00.000Z', kp: 5, dst: null };
    expect(layoutTrack([outside, at(3, 1, null)], START, END, 0.01)).toHaveLength(1);
  });

  it('ignores an unparseable timestamp instead of drawing it at zero', () => {
    const broken: SpaceWeatherSample = { timeUtc: 'not a date', kp: 5, dst: null };
    expect(layoutTrack([broken], START, END, 0.01)).toHaveLength(0);
  });

  it('returns nothing for a zero-length window', () => {
    expect(layoutTrack([at(0, 1, -1)], START, START, 0.01)).toEqual([]);
  });
});

describe('bucketsForWidth', () => {
  it('asks for about one bucket per two pixels', () => {
    expect(bucketsForWidth(480)).toBe(240);
  });

  it('never asks for zero buckets', () => {
    expect(bucketsForWidth(0)).toBe(1);
    expect(bucketsForWidth(1)).toBe(1);
  });
});

describe('peakOf', () => {
  it('takes the highest Kp and the most negative Dst', () => {
    const peak = peakOf([at(0, 3, -20), at(1, 7, -5), at(2, 2, -300)]);
    expect(peak.kp).toBe(7);
    expect(peak.dst).toBe(-300);
  });

  it('reports null for an index with no data at all', () => {
    // Distinguishes "quiet" from "not measured", which an empty track cannot.
    const peak = peakOf([at(0, null, -20)]);
    expect(peak.kp).toBeNull();
    expect(peak.dst).toBe(-20);
  });

  it('handles an empty series', () => {
    expect(peakOf([])).toEqual({ kp: null, dst: null });
  });
});
