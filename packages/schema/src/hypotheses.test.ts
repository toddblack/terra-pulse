import { describe, expect, it } from 'vitest';
import {
  H2B_DECLUSTERING,
  H2B_ITERATIONS,
  H2B_LAG_WINDOWS_HOURS,
  H2B_NULL_MODEL,
  H2B_Q,
  H2B_REQUESTED_START_UTC,
  H2B_SEED,
  H2B_SPATIAL_SPLIT_DEGREES,
  H2B_TAIL,
  H2B_TARGET_MIN_MAGNITUDE,
  H3B_BASELINE_WINDOW_DAYS,
  H3B_DECLUSTERING,
  H3B_ITERATIONS,
  H3B_LAG_WINDOWS_HOURS,
  H3B_NULL_MODEL,
  H3B_Q,
  H3B_REQUESTED_START_UTC,
  H3B_SEED,
  H3B_TAIL,
  H3B_TARGET_MIN_MAGNITUDE,
  H3B_TRIGGERS,
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
import { KP_STORM_THRESHOLD, DST_STORM_THRESHOLD, FAST_WIND_THRESHOLD } from './space-weather';
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

describe('H3b registered constants (HYPOTHESES.md)', () => {
  it('"Coronal hole high-speed stream arrivals are followed by an elevated global M5.0+ rate"', () => {
    expect(H3B_TARGET_MIN_MAGNITUDE).toBe(5.0);
  });

  it('"Trigger definition: Stream onset = sustained speed > 500 km/s for >= 6h"', () => {
    expect(H3B_TRIGGERS).toHaveLength(1);
    expect(H3B_TRIGGERS[0]).toMatchObject({
      series: 'wind_speed',
      comparison: '>=',
      threshold: 500,
      minConsecutiveHours: 6,
    });
  });

  it('"Lag windows: 0-24h, 24-48h, 48-72h, 3-5d (4 windows)"', () => {
    expect(H3B_LAG_WINDOWS_HOURS).toEqual([
      [0, 24],
      [24, 48],
      [48, 72],
      [72, 120],
    ]);
  });

  it('produces 4 tests (1 trigger x 4 lags), matching "Tests in family: 4"', () => {
    expect(H3B_TRIGGERS.length * H3B_LAG_WINDOWS_HOURS.length).toBe(4);
  });

  it('declustering is Gardner-Knopoff, per the shared parameters table', () => {
    expect(H3B_DECLUSTERING).toBe('gardner-knopoff');
  });

  it('"Baseline window" (completed 2026-08-19): the same registered mitigation as H4c\'s', () => {
    expect(H3B_BASELINE_WINDOW_DAYS).toBe(H4C_BASELINE_WINDOW_DAYS);
  });

  it('"Null model" (completed 2026-08-19): uniform-redraw', () => {
    expect(H3B_NULL_MODEL).toBe('uniform-redraw');
  });

  it('"Tail" (completed 2026-08-19): one-sided upper', () => {
    expect(H3B_TAIL).toBe('upper');
  });

  it('Monte Carlo iterations and q match the shared parameters table', () => {
    expect(H3B_ITERATIONS).toBe(10_000);
    expect(H3B_Q).toBe(0.05);
  });

  it('"Time range: 1995-01-01 onward"', () => {
    expect(H3B_REQUESTED_START_UTC).toBe('1995-01-01T00:00:00.000Z');
  });

  it('1995 already clears the archive completeness boundary, unlike H4c\'s 1963', () => {
    expect(new Date(H3B_REQUESTED_START_UTC).getUTCFullYear()).toBeGreaterThan(ARCHIVE_START_YEAR);
  });

  it('is seeded for reproducibility, and not the same seed as H4c', () => {
    expect(Number.isInteger(H3B_SEED)).toBe(true);
    expect(H3B_SEED).not.toBe(H4C_SEED);
  });
});

describe('H3b registered trigger stays independent of the display threshold', () => {
  it('the registered wind-speed trigger (500) numerically coincides with FAST_WIND_THRESHOLD, which is exactly why it must be declared independently', () => {
    // Same situation as H4c's Dst trigger vs DST_STORM_THRESHOLD: a numeric
    // match can't prove independence, so hypotheses.ts declares its own
    // literal here rather than importing FAST_WIND_THRESHOLD.
    expect(H3B_TRIGGERS[0]?.threshold).toBe(FAST_WIND_THRESHOLD);
  });
});

describe('H2b registered constants (HYPOTHESES.md)', () => {
  it('"Any H1b effect is stronger on the hemisphere facing the Sun at CME arrival time than on the far hemisphere"', () => {
    expect(H2B_TARGET_MIN_MAGNITUDE).toBe(5.0);
  });

  it('"Spatial split: Subsolar longitude at arrival +/-90 vs. complement"', () => {
    expect(H2B_SPATIAL_SPLIT_DEGREES).toBe(90);
  });

  it('"Lag windows: 0-24h, 24-48h from arrival (2 windows)"', () => {
    expect(H2B_LAG_WINDOWS_HOURS).toEqual([
      [0, 24],
      [24, 48],
    ]);
  });

  it('produces 2 tests (1 trigger definition x 2 lags), matching "Tests in family: 2"', () => {
    expect(H2B_LAG_WINDOWS_HOURS.length).toBe(2);
  });

  it('declustering is Gardner-Knopoff, per the shared parameters table', () => {
    expect(H2B_DECLUSTERING).toBe('gardner-knopoff');
  });

  it('"Null model" (completed 2026-08-19): uniform-redraw', () => {
    expect(H2B_NULL_MODEL).toBe('uniform-redraw');
  });

  it('"Tail" (completed 2026-08-19): one-sided upper', () => {
    expect(H2B_TAIL).toBe('upper');
  });

  it('Monte Carlo iterations and q match the shared parameters table', () => {
    expect(H2B_ITERATIONS).toBe(10_000);
    expect(H2B_Q).toBe(0.05);
  });

  it('"Time range: 2014-01-01 onward"', () => {
    expect(H2B_REQUESTED_START_UTC).toBe('2014-01-01T00:00:00.000Z');
  });

  it('is seeded for reproducibility, and not the same seed as H4c or H3b', () => {
    expect(Number.isInteger(H2B_SEED)).toBe(true);
    expect(H2B_SEED).not.toBe(H4C_SEED);
    expect(H2B_SEED).not.toBe(H3B_SEED);
  });
});
