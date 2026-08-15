import { describe, expect, it } from 'vitest';
import type { SpaceWeatherBucket, SpaceWeatherSample } from '@terra-pulse/schema';
import {
  bucketsForWidth,
  GEOMAGNETIC_SPEC,
  layoutTrack,
  nearestBarIndex,
  peakOf,
  SOLAR_WIND_SPEC,
  ticksForWidth,
  trackTicks,
} from './space-weather-track';

const START = Date.UTC(2020, 0, 1);
const END = Date.UTC(2020, 0, 2);

const at = (hour: number, kp: number | null, dst: number | null): SpaceWeatherSample => ({
  timeUtc: new Date(Date.UTC(2020, 0, 1, hour)).toISOString(),
  kp,
  dst,
  // The track draws Kp and Dst; the wind fields ride the same rows.
  windSpeed: null,
  density: null,
  bzGsm: null,
});

/** A bucket at a given hour of 2020-01-01. */
const bucket = (
  hour: number,
  typicalKp: number | null,
  peakKp: number | null,
  peakDst: number | null = null,
  hours = 1,
  wind: { typical?: number | null; peak?: number | null; bz?: number | null } = {},
): SpaceWeatherBucket => ({
  timeUtc: new Date(Date.UTC(2020, 0, 1, hour)).toISOString(),
  typicalKp,
  peakKp,
  peakDst,
  typicalWindSpeed: wind.typical ?? null,
  peakWindSpeed: wind.peak ?? null,
  peakBzGsm: wind.bz ?? null,
  hours,
});

describe('layoutTrack', () => {
  it('positions a bar by its timestamp, not its index', () => {
    // The whole point. Gaps in the record are common — OMNI has them and a
    // partial backfill has whole missing years — and index-based spacing would
    // close those gaps silently, drawing a continuous record that doesn't exist.
    const bars = layoutTrack([bucket(0, 1, 1), bucket(18, 2, 2)], START, END, 0.01);
    expect(bars[0]?.x).toBeCloseTo(0, 5);
    expect(bars[1]?.x).toBeCloseTo(18 / 24, 5);
  });

  it('leaves a hole where the record has one', () => {
    const bars = layoutTrack([bucket(0, 1, 1), bucket(23, 1, 1)], START, END, 0.01);
    expect(bars).toHaveLength(2);
    // Nothing invented in between.
    expect(bars[1]!.x - bars[0]!.x).toBeGreaterThan(0.9);
  });

  it('scales both heights by Kp against its fixed 0-9 range', () => {
    const [bar] = layoutTrack([bucket(0, 4.5, 9)], START, END, 0.01);
    expect(bar?.peakHeight).toBe(1);
    expect(bar?.typicalHeight).toBeCloseTo(0.5, 5);
  });

  it('keeps the peak at or above the typical', () => {
    // They are the max and the median of the same set, so this cannot be
    // violated by real data — but a cap drawn below its bar would be a visible
    // nonsense, so it is worth pinning.
    const bars = layoutTrack(
      [bucket(0, 1, 9), bucket(1, 3, 3), bucket(2, null, null)],
      START,
      END,
      0.01,
    );
    expect(bars.every((bar) => bar.peakHeight >= bar.typicalHeight)).toBe(true);
  });

  it('does not let Dst drive either height', () => {
    // Dst is unbounded below: one -589 nT hour would flatten every other bar in
    // the record, and that hour is exactly what you want to see in context.
    const [quiet] = layoutTrack([bucket(0, 2, 2, -589)], START, END, 0.01);
    const [same] = layoutTrack([bucket(0, 2, 2, -5)], START, END, 0.01);
    expect(quiet?.typicalHeight).toBe(same?.typicalHeight);
    expect(quiet?.peakHeight).toBe(same?.peakHeight);
  });

  it('gives a missing Kp no height rather than a default one', () => {
    const [bar] = layoutTrack([bucket(0, null, null, -300)], START, END, 0.01);
    expect(bar?.typicalHeight).toBe(0);
    expect(bar?.peakHeight).toBe(0);
  });

  it('separates touching storm level from sitting at it', () => {
    // A brief storm inside a quiet interval marks the cap only; an interval
    // that spent most of itself disturbed turns the bar too.
    const [brief] = layoutTrack([bucket(0, 2, 6)], START, END, 0.01);
    expect(brief?.peakStormy).toBe(true);
    expect(brief?.typicalStormy).toBe(false);

    const [sustained] = layoutTrack([bucket(0, 6, 7)], START, END, 0.01);
    expect(sustained?.typicalStormy).toBe(true);
  });

  it('drops buckets outside the window', () => {
    const outside: SpaceWeatherBucket = {
      timeUtc: '2019-06-01T00:00:00.000Z',
      typicalKp: 5,
      peakKp: 5,
      peakDst: null,
      typicalWindSpeed: null,
      peakWindSpeed: null,
      peakBzGsm: null,
      hours: 1,
    };
    expect(layoutTrack([outside, bucket(3, 1, 1)], START, END, 0.01)).toHaveLength(1);
  });

  it('ignores an unparseable timestamp instead of drawing it at zero', () => {
    const broken: SpaceWeatherBucket = {
      timeUtc: 'not a date',
      typicalKp: 5,
      peakKp: 5,
      peakDst: null,
      typicalWindSpeed: null,
      peakWindSpeed: null,
      peakBzGsm: null,
      hours: 1,
    };
    expect(layoutTrack([broken], START, END, 0.01)).toHaveLength(0);
  });

  it('returns nothing for a zero-length window', () => {
    expect(layoutTrack([bucket(0, 1, 1)], START, START, 0.01)).toEqual([]);
  });
});

describe('layoutTrack with the solar wind spec', () => {
  it('sizes bars against the fixed 1000 km/s scale, not against Kp', () => {
    const bars = layoutTrack(
      [bucket(0, null, null, null, 1, { typical: 500, peak: 1000 })],
      START,
      END,
      0.01,
      SOLAR_WIND_SPEC,
    );
    expect(bars[0]?.typicalHeight).toBeCloseTo(0.5, 5);
    expect(bars[0]?.peakHeight).toBe(1);
  });

  it('clamps above the scale rather than overflowing the row', () => {
    // 1189 km/s is the fastest hour in the sampled record and sits above the
    // ceiling. Clipping 0.035% of hours is the documented price of the scale.
    const [bar] = layoutTrack(
      [bucket(0, null, null, null, 1, { typical: 1189, peak: 1189 })],
      START,
      END,
      0.01,
      SOLAR_WIND_SPEC,
    );
    expect(bar?.typicalHeight).toBe(1);
  });

  it('emphasises a fast stream at the display threshold', () => {
    const [brief] = layoutTrack(
      [bucket(0, null, null, null, 1, { typical: 380, peak: 620 })],
      START,
      END,
      0.01,
      SOLAR_WIND_SPEC,
    );
    // Touched fast, did not sit there — the cap marks it, the bar does not.
    expect(brief?.peakStormy).toBe(true);
    expect(brief?.typicalStormy).toBe(false);
  });

  it('carries the most southward Bz as the secondary, never the maximum', () => {
    // Southward is the geoeffective direction. Reporting the maximum would
    // headline the least interesting hour of every interval.
    const [bar] = layoutTrack(
      [bucket(0, null, null, null, 1, { typical: 400, peak: 400, bz: -18 })],
      START,
      END,
      0.01,
      SOLAR_WIND_SPEC,
    );
    expect(bar?.secondary).toBe(-18);
  });

  it('lands on the same x positions as the geomagnetic row', () => {
    // The two rows are read down a column, so a shared bucketing is the whole
    // point — different positions would compare different hours.
    const buckets = [bucket(0, 3, 5, -20, 1, { typical: 400, peak: 700 }), bucket(12, 2, 2)];
    const geo = layoutTrack(buckets, START, END, 0.01, GEOMAGNETIC_SPEC);
    const wind = layoutTrack(buckets, START, END, 0.01, SOLAR_WIND_SPEC);
    expect(wind.map((b) => b.x)).toEqual(geo.map((b) => b.x));
  });

  it('gives an unmeasured hour no height rather than a floor', () => {
    // Most of 1985-1994 has Dst and no wind. Zero height is what "not measured"
    // has to look like; a minimum bar would draw a slow wind that nobody saw.
    const [bar] = layoutTrack([bucket(0, 3, 5, -20)], START, END, 0.01, SOLAR_WIND_SPEC);
    expect(bar?.typicalHeight).toBe(0);
    expect(bar?.typical).toBeNull();
  });
});

describe('bucketsForWidth', () => {
  it('leaves a gap between adjacent intervals', () => {
    // One bucket per three pixels: a 2px mark and a 1px gap. Touching caps
    // would merge into a continuous line and read as a plotted series rather
    // than as one interval's worst hour.
    expect(bucketsForWidth(480)).toBe(160);
  });

  it('never asks for zero buckets', () => {
    expect(bucketsForWidth(0)).toBe(1);
    expect(bucketsForWidth(1)).toBe(1);
  });
});

describe('trackTicks', () => {
  it('lands on round calendar boundaries, not on even divisions of the window', () => {
    // A label reading "1994" is worth more than one reading "12 Mar 1994 04:17",
    // so the tick moves to the calendar rather than the window being divided up.
    const ticks = trackTicks(Date.UTC(2020, 0, 1, 5), Date.UTC(2020, 0, 3), 6);
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      const date = new Date(tick.timeUtc);
      expect(date.getUTCMinutes()).toBe(0);
      expect(date.getUTCSeconds()).toBe(0);
    }
  });

  it('coarsens all the way to the archive span', () => {
    // 130 years is the widest view the app offers. Hour ticks there would be a
    // million labels, so the ladder has to reach decades.
    const ticks = trackTicks(Date.UTC(1900, 0, 1), Date.UTC(2026, 7, 14), 6);
    expect(ticks.length).toBeLessThanOrEqual(24);
    expect(ticks.length).toBeGreaterThan(1);
    // Every label is a bare year at this width.
    expect(ticks.every((tick) => /^\d{4}$/.test(tick.label))).toBe(true);
    // And on round decades or wider.
    expect(ticks.every((tick) => Number(tick.label) % 10 === 0)).toBe(true);
  });

  it('uses hours for a short window and years for a long one', () => {
    const short = trackTicks(START + 3_600_000, START + 12 * 3_600_000, 5);
    expect(short.every((tick) => /^\d{2}:00$/.test(tick.label))).toBe(true);

    const long = trackTicks(Date.UTC(1990, 0, 1), Date.UTC(2020, 0, 1), 5);
    expect(long.every((tick) => /^\d{4}$/.test(tick.label))).toBe(true);
  });

  it('names the day at midnight instead of drawing a second 00:00', () => {
    // A 48-hour window drew "12:00 00:00 12:00 00:00" — two identical labels
    // with nothing to say which day either belonged to. That is worse than no
    // axis, because it looks like it answered.
    const ticks = trackTicks(Date.UTC(2020, 0, 1, 12), Date.UTC(2020, 0, 3, 12), 5);
    const labels = ticks.map((tick) => tick.label);

    // Now "12:00 · 2 Jan · 12:00 · 3 Jan · 12:00". The times still repeat, which
    // is right — they are bracketed by dated midnights, so every position is
    // identifiable. What must never happen is two *adjacent* ticks reading the
    // same, which is the case that leaves a span unlabelled in effect.
    expect(labels).toContain('2 Jan');
    expect(labels).toContain('3 Jan');
    expect(labels.every((label, i) => i === 0 || label !== labels[i - 1])).toBe(true);
  });

  it('keeps a week from collapsing to a single tick', () => {
    // The ladder used to jump 2 days to 7, so a seven-day window on a narrow
    // track got one tick: 7/2 overshoots a 3-tick budget and 7/7 is one label.
    expect(trackTicks(START, START + 7 * 86_400_000, 3).length).toBeGreaterThan(1);
  });

  it('anchors the end labels inward so neither hangs off the track', () => {
    // A centred label at x = 0 or x = 1 overhangs by half its width — measured
    // at up to 9px, which puts it under the panel edge.
    const ticks = trackTicks(Date.UTC(2020, 0, 1), Date.UTC(2020, 0, 5), 6);
    expect(ticks[0]?.anchor).toBe('start');
    expect(ticks[ticks.length - 1]?.anchor).toBe('end');
    expect(ticks.slice(1, -1).every((tick) => tick.anchor === 'middle')).toBe(true);
  });

  it('names the month when the window spans a year or so', () => {
    const ticks = trackTicks(Date.UTC(2025, 0, 1), Date.UTC(2026, 0, 1), 5);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.every((tick) => /^[A-Z][a-z]{2} \d{4}$/.test(tick.label))).toBe(true);
    // Month ticks sit on the 1st, which is the point of stepping by calendar.
    expect(ticks.every((tick) => new Date(tick.timeUtc).getUTCDate() === 1)).toBe(true);
  });

  it('steps months by calendar, so a quarter is Jan/Apr/Jul/Oct', () => {
    const ticks = trackTicks(Date.UTC(2025, 0, 1), Date.UTC(2026, 0, 2), 5);
    const months = ticks.map((tick) => new Date(tick.timeUtc).getUTCMonth());
    // Never 91.3-day intervals drifting off the boundaries.
    expect(months.every((month) => month % 3 === 0)).toBe(true);
  });

  it('places every tick inside the window as a fraction', () => {
    const ticks = trackTicks(Date.UTC(2001, 3, 7), Date.UTC(2009, 8, 19), 6);
    expect(ticks.every((tick) => tick.x >= 0 && tick.x <= 1)).toBe(true);
  });

  it('respects the tick budget rather than crowding the axis', () => {
    for (const maxTicks of [2, 3, 5, 8]) {
      const ticks = trackTicks(Date.UTC(2000, 0, 1), Date.UTC(2020, 0, 1), maxTicks);
      // The ladder is coarse-grained, so the count lands at or under budget
      // give or take one boundary at the edges.
      expect(ticks.length).toBeLessThanOrEqual(maxTicks + 1);
    }
  });

  it('returns nothing for a degenerate window', () => {
    expect(trackTicks(START, START, 5)).toEqual([]);
    expect(trackTicks(END, START, 5)).toEqual([]);
    expect(trackTicks(START, END, 0)).toEqual([]);
  });
});

describe('ticksForWidth', () => {
  it('asks for about one tick per 90 pixels', () => {
    expect(ticksForWidth(480)).toBe(5);
  });

  it('always asks for at least two', () => {
    // A single tick gives nothing to read a position against.
    expect(ticksForWidth(0)).toBe(2);
    expect(ticksForWidth(50)).toBe(2);
  });
});

describe('nearestBarIndex', () => {
  const bars = layoutTrack(
    [bucket(0, 1, 1), bucket(8, 2, 2), bucket(16, 3, 3)],
    START,
    END,
    1 / 3,
  );

  it('answers with the column under the pointer, not the mark beneath it', () => {
    // A bar is 2px wide. Requiring the pointer to land on one would leave most
    // of the track dead — the reader aims at a time.
    expect(nearestBarIndex(bars, 0.02)).toBe(0);
    expect(nearestBarIndex(bars, 0.5)).toBe(1);
    expect(nearestBarIndex(bars, 0.95)).toBe(2);
  });

  it('splits the difference at the boundary between two bars', () => {
    // Measured to each bar's middle, so neither claims extra ground.
    const first = bars[0]!;
    const second = bars[1]!;
    const midpoint =
      (first.x + first.width / 2 + (second.x + second.width / 2)) / 2;
    expect(nearestBarIndex(bars, midpoint - 0.01)).toBe(0);
    expect(nearestBarIndex(bars, midpoint + 0.01)).toBe(1);
  });

  it('still answers when the pointer is past either end', () => {
    expect(nearestBarIndex(bars, -5)).toBe(0);
    expect(nearestBarIndex(bars, 5)).toBe(2);
  });

  it('reports nothing to point at for an empty track', () => {
    expect(nearestBarIndex([], 0.5)).toBe(-1);
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
    expect(peakOf([])).toEqual({ kp: null, dst: null, windSpeed: null, bzGsm: null });
  });

  it('takes each quantity in its own disturbed direction', () => {
    // Kp and speed go up, Dst and Bz go down. Taking the maximum of the latter
    // two would headline the calmest hour of the window.
    const windy: SpaceWeatherSample[] = [
      { timeUtc: '2020-01-01T00:00:00.000Z', kp: 3, dst: -20, windSpeed: 400, density: 5, bzGsm: 4 },
      { timeUtc: '2020-01-01T01:00:00.000Z', kp: 7, dst: -5, windSpeed: 820, density: 2, bzGsm: -14 },
    ];
    expect(peakOf(windy)).toEqual({ kp: 7, dst: -20, windSpeed: 820, bzGsm: -14 });
  });
});
