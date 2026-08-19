import { describe, expect, it } from 'vitest';
import {
  H4C_BASELINE_WINDOW_DAYS,
  H4C_DECLUSTERING,
  H4C_EFFECTIVE_START_YEAR,
  H4C_ITERATIONS,
  H4C_LAG_WINDOWS_HOURS,
  H4C_NULL_MODEL,
  H4C_Q,
  H4C_REQUESTED_START_UTC,
  H4C_SEED,
  H4C_TAIL,
  H4C_TARGET_MIN_MAGNITUDE,
  H4C_TRIGGERS,
  REGISTERED_MATRIX_TESTS,
} from './hypotheses';
import { KP_STORM_THRESHOLD, DST_STORM_THRESHOLD } from './space-weather';
import { ARCHIVE_START_YEAR } from './archive';

describe('H4c registered constants (HYPOTHESES.md)', () => {
  it('"Elevated planetary geomagnetic activity is followed by an elevated global M5.0+ rate"', () => {
    expect(H4C_TARGET_MIN_MAGNITUDE).toBe(5.0);
  });

  it('"Trigger threshold: Kp >= 6 or Dst <= -100 nT (registered as two separate trigger definitions)"', () => {
    expect(H4C_TRIGGERS).toHaveLength(2);
    const kp = H4C_TRIGGERS.find((t) => t.series === 'kp');
    const dst = H4C_TRIGGERS.find((t) => t.series === 'dst');
    expect(kp).toMatchObject({ comparison: '>=', threshold: 6 });
    expect(dst).toMatchObject({ comparison: '<=', threshold: -100 });
  });

  it('"Episode definition" (completed 2026-08-18): no minimum run duration', () => {
    for (const trigger of H4C_TRIGGERS) {
      expect(trigger.minConsecutiveHours).toBe(1);
    }
  });

  it('"Lag windows: 0-24h, 24-48h, 48-72h (3 windows)"', () => {
    expect(H4C_LAG_WINDOWS_HOURS).toEqual([
      [0, 24],
      [24, 48],
      [48, 72],
    ]);
  });

  it('produces 6 tests (2 trigger definitions x 3 lags), matching "Tests in family: 6"', () => {
    expect(H4C_TRIGGERS.length * H4C_LAG_WINDOWS_HOURS.length).toBe(6);
  });

  it('declustering is Gardner-Knopoff, per the shared parameters table', () => {
    expect(H4C_DECLUSTERING).toBe('gardner-knopoff');
  });

  it('"Baseline window" (completed 2026-08-18): +/-182.625 days', () => {
    expect(H4C_BASELINE_WINDOW_DAYS).toBe(365.25);
  });

  it('"Null model" (completed 2026-08-18): uniform-redraw', () => {
    expect(H4C_NULL_MODEL).toBe('uniform-redraw');
  });

  it('"Tail" (completed 2026-08-18): one-sided upper', () => {
    expect(H4C_TAIL).toBe('upper');
  });

  it('Monte Carlo iterations: 10,000, per the shared parameters table', () => {
    expect(H4C_ITERATIONS).toBe(10_000);
  });

  it('FDR q = 0.05, per the shared parameters table', () => {
    expect(H4C_Q).toBe(0.05);
  });

  it('"Time range: 1963-01-01 onward"', () => {
    expect(H4C_REQUESTED_START_UTC).toBe('1963-01-01T00:00:00.000Z');
  });

  it('the effective floor matches the archive\'s own completeness boundary, not an independent guess', () => {
    expect(H4C_EFFECTIVE_START_YEAR).toBe(ARCHIVE_START_YEAR);
    expect(H4C_EFFECTIVE_START_YEAR).toBe(1970);
  });

  it('registered matrix size is 19 unblocked tests (H1b 4 + H2b 2 + H3b 4 + H4c 6 + H4b 2 + H5 1)', () => {
    expect(REGISTERED_MATRIX_TESTS).toBe(19);
  });

  it('is seeded for reproducibility', () => {
    expect(Number.isInteger(H4C_SEED)).toBe(true);
  });
});

describe('registered constants stay independent of display thresholds', () => {
  // Same separation this codebase already enforces for KP_STORM_THRESHOLD
  // (display, Kp>=5) vs H4c's registered Kp>=6, and FAST_WIND_THRESHOLD vs
  // H3b's registered speed threshold: a display constant drifting into an
  // analysis constant is exactly the free-parameter-after-the-fact
  // non-negotiable #3 forbids, even when the numbers happen to coincide.
  it('the registered Kp trigger (6) differs from the display threshold (5) — proof they are not the same constant', () => {
    const kpTrigger = H4C_TRIGGERS.find((t) => t.series === 'kp');
    expect(kpTrigger?.threshold).not.toBe(KP_STORM_THRESHOLD);
    expect(KP_STORM_THRESHOLD).toBe(5);
    expect(kpTrigger?.threshold).toBe(6);
  });

  it('the registered Dst trigger numerically coincides with the display threshold, which is exactly why it must be declared independently', () => {
    // Unlike Kp (6 vs 5), Dst's registered trigger and display threshold are
    // both -100 — the one case where a numeric mismatch can't prove
    // independence, so hypotheses.ts declares its own literal here rather
    // than importing DST_STORM_THRESHOLD. See hypotheses.ts's own source:
    // it has no import from space-weather.ts.
    const dstTrigger = H4C_TRIGGERS.find((t) => t.series === 'dst');
    expect(dstTrigger?.threshold).toBe(DST_STORM_THRESHOLD);
  });
});
