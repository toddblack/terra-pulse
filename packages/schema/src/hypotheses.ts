/**
 * H4c's registered parameters, as typed constants — the structural half of
 * non-negotiable #3 ("no free parameters chosen after seeing results").
 *
 * Main assembles the analysis engine's request from **only** these values
 * (`apps/desktop/src/main/ipc/analysis.ts`); the renderer sends nothing but a
 * hypothesis id (`analysis:run`). There is no IPC channel through which the
 * UI can alter a threshold, a lag window, or the magnitude floor — that is
 * what makes "no free parameters" true of the code, not just of intent.
 *
 * Every value here is transcribed from `HYPOTHESES.md`'s H4c entry, including
 * the five fields completed 2026-08-18 (episode definition, baseline window,
 * null model, tail, effective span) before the first run. If that entry ever
 * changes, it must change as a new registered entry (rule 3) — H4c becomes
 * H4d — and this file follows, it does not lead.
 */

import { ARCHIVE_START_YEAR } from './archive';

/** HYPOTHESES.md H4c: "Elevated planetary geomagnetic activity is followed
 * by an elevated global M5.0+ rate." */
export const H4C_TARGET_MIN_MAGNITUDE = 5.0;

export interface H4cTriggerDefinition {
  id: string;
  series: 'kp' | 'dst';
  comparison: '>=' | '<=';
  threshold: number;
  minConsecutiveHours: number;
}

/**
 * HYPOTHESES.md H4c: "Trigger threshold: Kp >= 6 or Dst <= -100 nT
 * (registered as two separate trigger definitions)." `minConsecutiveHours: 1`
 * per the completed "Episode definition" field — H4c registers no minimum
 * duration, unlike H3b's six-hour requirement.
 */
export const H4C_TRIGGERS: readonly H4cTriggerDefinition[] = [
  { id: 'kp>=6', series: 'kp', comparison: '>=', threshold: 6, minConsecutiveHours: 1 },
  { id: 'dst<=-100', series: 'dst', comparison: '<=', threshold: -100, minConsecutiveHours: 1 },
];

/** HYPOTHESES.md H4c: "Lag windows: 0-24h, 24-48h, 48-72h (3 windows)." */
export const H4C_LAG_WINDOWS_HOURS: readonly (readonly [number, number])[] = [
  [0, 24],
  [24, 48],
  [48, 72],
];

/** HYPOTHESES.md, shared parameters table: "Declustering: Gardner-Knopoff windowing." */
export const H4C_DECLUSTERING = 'gardner-knopoff' as const;

/**
 * HYPOTHESES.md H4c, "Baseline window" (completed 2026-08-18): "±182.625
 * days (one year total) centred on each trigger, not pooled across the
 * record" — H1b's own registered mitigation for the same measured problem
 * (M5.0+ events/decade rise 36% from the 1970s to the 2010s).
 */
export const H4C_BASELINE_WINDOW_DAYS = 365.25;

/** HYPOTHESES.md H4c, "Null model" (completed 2026-08-18). */
export const H4C_NULL_MODEL = 'uniform-redraw' as const;

/** HYPOTHESES.md H4c, "Tail" (completed 2026-08-18): one-sided upper. */
export const H4C_TAIL = 'upper' as const;

/** HYPOTHESES.md, shared parameters table: "Null distribution: Monte Carlo
 * permutation, 10,000 iterations." */
export const H4C_ITERATIONS = 10_000;

/** HYPOTHESES.md, shared parameters table: "Multiple-comparison correction:
 * Benjamini-Hochberg FDR, q = 0.05." */
export const H4C_Q = 0.05;

/**
 * HYPOTHESES.md H4c: "Time range: 1963-01-01 onward — the span where *both*
 * indices exist." The engine truncates this further to
 * `ARCHIVE_START_YEAR` (1970) for the M5.0+ target catalogue's own
 * completeness bound — see the "Effective span" field completed
 * 2026-08-18 — and reports that truncation in the result rather than
 * silently narrowing it here.
 */
export const H4C_REQUESTED_START_UTC = '1963-01-01T00:00:00.000Z';

/**
 * HYPOTHESES.md "Total Test Matrix": 19 unblocked registered tests
 * (H1b 4 + H2b 2 + H3b 4 + H4c 6 + H4b 2 + H5 1). H6's 2 are deferred to
 * Phase 5; H4b's 2 are blocked (no magnetometer table exists yet) — neither
 * changes this number, since the document's own "Total" of 21 already
 * counts them. This is the conservative denominator the full-matrix FDR
 * correction uses until more of the matrix is actually run.
 */
export const REGISTERED_MATRIX_TESTS = 19;

/** Seeded so a run is reproducible; echoed back in every result. */
export const H4C_SEED = 20260818;

/** Confirms the engine's target floor matches where the app's own archive
 * becomes globally complete, rather than a value chosen independently of it. */
export const H4C_EFFECTIVE_START_YEAR = ARCHIVE_START_YEAR;
