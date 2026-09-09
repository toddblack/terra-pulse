import { describe, expect, it } from 'vitest';
import {
  nearestPointIndex,
  polylinePoints,
  samplePointCount,
  sampleTidalStress,
  shearHeight,
  TIDAL_PERIOD_HOURS,
  TIDAL_SHEAR_MAX_PA,
  TIDAL_TRACK_MAX_POINTS,
  TIDAL_TRACK_MAX_WINDOW_HOURS,
  type FaultPlane,
} from './tidal-stress-track';

/**
 * A real geometry rather than a synthetic one: the Mount Diablo Thrust's own
 * dip and rake from the vendored GEM record, at its first trace vertex. Used
 * because its measured 48-hour series is quoted in `tidal-stress-track.ts`'s
 * own scale note, so a change that shifts these numbers is visible against
 * something written down.
 */
const PLANE: FaultPlane = {
  latitudeDeg: 37.8,
  longitudeDeg: -121.9,
  strikeDeg: 130,
  dipDeg: 38,
  rakeDeg: 90,
};

const HOUR = 3_600_000;
const START = Date.UTC(2026, 0, 1);

describe('sampleTidalStress', () => {
  it('is signed, not folded to a magnitude', () => {
    // The whole reason this row exists as a curve. Taking Math.abs() would
    // double the apparent frequency of a semidiurnal tide — see the module
    // doc comment.
    const { points } = sampleTidalStress(PLANE, START, START + 48 * HOUR);
    expect(points.some((p) => p.shearPa > 0)).toBe(true);
    expect(points.some((p) => p.shearPa < 0)).toBe(true);
  });

  it('oscillates at a tidal period', () => {
    // A physics check on the sampling, not on the stress chain itself (that is
    // cross-checked against the Python reference in tidal-stress.test.ts). If
    // the instants fed to the ephemeris were wrong — a unit slip, a stale
    // epoch — the spacing of the maxima is where it would show.
    const days = 10;
    const { points } = sampleTidalStress(PLANE, START, START + days * 24 * HOUR);

    const maximaHours: number[] = [];
    for (let i = 1; i < points.length - 1; i += 1) {
      const previous = points[i - 1]?.shearPa ?? 0;
      const current = points[i]?.shearPa ?? 0;
      const next = points[i + 1]?.shearPa ?? 0;
      if (current > previous && current >= next) {
        maximaHours.push(((points[i]?.timeMs ?? 0) - START) / HOUR);
      }
    }

    expect(maximaHours.length).toBeGreaterThan(10);
    const gaps: number[] = [];
    for (let i = 1; i < maximaHours.length; i += 1) {
      gaps.push((maximaHours[i] ?? 0) - (maximaHours[i - 1] ?? 0));
    }
    const meanGap = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;

    // The band spans the principal semidiurnal (M2, 12.42 h) and diurnal
    // (K1, 23.93 h) constituents — which of them dominates depends on the
    // site's latitude and the plane's orientation, so the test allows either
    // rather than pinning a value this geometry happens to produce.
    expect(meanGap).toBeGreaterThan(TIDAL_PERIOD_HOURS - 2.5);
    expect(meanGap).toBeLessThan(26);
  });

  it('shows the spring/neap cycle rather than a constant amplitude', () => {
    // The measured justification for a fixed domain: peak daily shear swings
    // ~2.4x across a month. A per-window domain would flatten exactly this.
    const springish = sampleTidalStress(PLANE, START, START + 2 * 24 * HOUR);
    let quietest = Infinity;
    let loudest = 0;
    for (let day = 0; day < 30; day += 1) {
      const from = START + day * 24 * HOUR;
      const { peakPa } = sampleTidalStress(PLANE, from, from + 24 * HOUR);
      if (peakPa < quietest) quietest = peakPa;
      if (peakPa > loudest) loudest = peakPa;
    }
    expect(springish.peakPa).toBeGreaterThan(0);
    expect(loudest / quietest).toBeGreaterThan(1.8);
  });

  it('refuses a window too long to resolve the tide', () => {
    const tooLong = sampleTidalStress(
      PLANE,
      START,
      START + (TIDAL_TRACK_MAX_WINDOW_HOURS + 1) * HOUR,
    );
    expect(tooLong.tooLong).toBe(true);
    expect(tooLong.points).toHaveLength(0);

    // And draws right up to the limit, so the boundary is a real one rather
    // than an off-by-one that quietly costs the last legible day.
    const atLimit = sampleTidalStress(PLANE, START, START + TIDAL_TRACK_MAX_WINDOW_HOURS * HOUR);
    expect(atLimit.tooLong).toBe(false);
    expect(atLimit.points.length).toBeGreaterThan(0);
  });

  it('returns nothing for an empty or inverted window', () => {
    expect(sampleTidalStress(PLANE, START, START).points).toHaveLength(0);
    expect(sampleTidalStress(PLANE, START, START - HOUR).points).toHaveLength(0);
    // Not the "too long" refusal — an inverted window is a different problem
    // and must not tell the reader the window is too wide.
    expect(sampleTidalStress(PLANE, START, START - HOUR).tooLong).toBe(false);
  });

  it('spans the window exactly, endpoints included', () => {
    const end = START + 12 * HOUR;
    const { points } = sampleTidalStress(PLANE, START, end);
    expect(points[0]?.x).toBe(0);
    expect(points[points.length - 1]?.x).toBe(1);
    expect(points[0]?.timeMs).toBe(START);
    expect(points[points.length - 1]?.timeMs).toBe(end);
  });
});

describe('samplePointCount', () => {
  it('caps at the point budget on the longest window', () => {
    expect(samplePointCount(TIDAL_TRACK_MAX_WINDOW_HOURS * HOUR)).toBe(TIDAL_TRACK_MAX_POINTS);
  });

  it('keeps at least two points on a very short window', () => {
    expect(samplePointCount(60_000)).toBe(2);
  });

  it('resolves the tidal period many times over at the cap', () => {
    // The claim the cap rests on: even at the widest allowed window there are
    // well over Nyquist's two samples per cycle.
    const spacingHours = TIDAL_TRACK_MAX_WINDOW_HOURS / TIDAL_TRACK_MAX_POINTS;
    expect(TIDAL_PERIOD_HOURS / spacingHours).toBeGreaterThan(8);
  });
});

describe('shearHeight', () => {
  it('puts zero stress at the middle of the row', () => {
    expect(shearHeight(0)).toBe(0.5);
  });

  it('is symmetric about zero', () => {
    expect(shearHeight(500) - 0.5).toBeCloseTo(0.5 - shearHeight(-500), 12);
  });

  it('clamps beyond full scale rather than escaping the plot', () => {
    expect(shearHeight(TIDAL_SHEAR_MAX_PA * 3)).toBe(1);
    expect(shearHeight(-TIDAL_SHEAR_MAX_PA * 3)).toBe(0);
  });
});

describe('nearestPointIndex', () => {
  it('is -1 when there is nothing to point at', () => {
    expect(nearestPointIndex([], 0.5)).toBe(-1);
  });

  it('resolves the ends and the middle', () => {
    const { points } = sampleTidalStress(PLANE, START, START + 24 * HOUR);
    expect(nearestPointIndex(points, 0)).toBe(0);
    expect(nearestPointIndex(points, 1)).toBe(points.length - 1);
    // An even sample count has no exact middle, so either neighbour is right.
    const middle = (points.length - 1) / 2;
    expect(Math.abs(nearestPointIndex(points, 0.5) - middle)).toBeLessThanOrEqual(0.5);
  });

  it('stays in range for a fraction outside the track', () => {
    const { points } = sampleTidalStress(PLANE, START, START + 24 * HOUR);
    expect(nearestPointIndex(points, -0.4)).toBe(0);
    expect(nearestPointIndex(points, 1.4)).toBe(points.length - 1);
  });
});

describe('polylinePoints', () => {
  it('flips y so the curve is drawn the way the row is read', () => {
    // shearHeight measures up from the bottom; SVG's origin is top-left. A
    // missing flip would draw the tide upside down and look entirely plausible.
    const high = polylinePoints([{ x: 0, shearPa: TIDAL_SHEAR_MAX_PA, timeMs: 0 }]);
    const low = polylinePoints([{ x: 0, shearPa: -TIDAL_SHEAR_MAX_PA, timeMs: 0 }]);
    expect(high).toBe('0.000,0.000');
    expect(low).toBe('0.000,100.000');
  });

  it('emits one pair per sample', () => {
    const { points } = sampleTidalStress(PLANE, START, START + 6 * HOUR);
    expect(polylinePoints(points).split(' ')).toHaveLength(points.length);
  });
});
