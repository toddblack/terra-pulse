/**
 * Registered hypothesis parameters, as typed constants — the structural half
 * of non-negotiable #3 ("no free parameters chosen after seeing results").
 *
 * Main assembles the analysis engine's request from **only** these values
 * (`apps/desktop/src/main/ipc/analysis.ts`); the renderer sends nothing but a
 * hypothesis id (`analysis:run`). There is no IPC channel through which the
 * UI can alter a threshold, a lag window, or the magnitude floor — that is
 * what makes "no free parameters" true of the code, not just of intent.
 *
 * Every value here is transcribed from `HYPOTHESES.md`. If a registered entry
 * ever changes, it must change as a new registered entry (rule 3) — this file
 * follows the document, it does not lead.
 */

import { ARCHIVE_START_YEAR } from './archive';

/** Shared shape for a threshold trigger, across every hypothesis that
 * registers one this way (H4c, H3b so far). */
export interface TriggerDefinition {
  id: string;
  series: 'kp' | 'dst' | 'wind_speed';
  comparison: '>=' | '<=';
  threshold: number;
  minConsecutiveHours: number;
}

/** HYPOTHESES.md H4c: "Elevated planetary geomagnetic activity is followed
 * by an elevated global M5.0+ rate." */
export const H4C_TARGET_MIN_MAGNITUDE = 5.0;

/**
 * HYPOTHESES.md H4c: "Trigger threshold: Kp >= 6 or Dst <= -100 nT
 * (registered as two separate trigger definitions)." `minConsecutiveHours: 1`
 * per the completed "Episode definition" field — H4c registers no minimum
 * duration, unlike H3b's six-hour requirement.
 */
export const H4C_TRIGGERS: readonly TriggerDefinition[] = [
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
 * HYPOTHESES.md "Total Test Matrix": 17 registered tests that have actually
 * been run (H1b 4 + H2b 2 + H3b 4 + H4c 6 + H5 1). H6's 2 are the difference
 * between this and the document's own "Total" of 19.
 *
 * **H6 stopped being *blocked* on 2026-08-21** — its registration was completed
 * against measured Global CMT data — but it is still unbuilt, so its 2 tests
 * are not yet in this denominator. **Raise this to 19 in the same change that
 * ships `h6.py`**, not before and not after: the correction has to cover every
 * test that has been run, and H6's own entry records that the move changes no
 * recorded value (0.0872 x 19 still exceeds 1).
 *
 * **This was 19 until 2026-08-20, when H4b was withdrawn unrun** and its 2
 * tests left the denominator. That is the same accounting H1, H2, H3 and H4
 * already got: rule 5 keeps a *run* family's tests in the correction forever,
 * but nothing was ever computed under H4b, so there is no result being
 * dropped. See its entry for the measured reasons.
 *
 * No recorded result changes as a consequence. The smallest raw p-value
 * anywhere in the matrix is H1b's 0.0872, and 0.0872 x 17 still exceeds 1, so
 * every adjusted value stays 1.0000 under either denominator — the five
 * completed runs did not need re-running.
 *
 * This is the conservative denominator the full-matrix FDR correction uses
 * until the rest of the matrix is actually run.
 */
export const REGISTERED_MATRIX_TESTS = 17;

/** Seeded so a run is reproducible; echoed back in every result. */
export const H4C_SEED = 20260818;

/** Confirms the engine's target floor matches where the app's own archive
 * becomes globally complete, rather than a value chosen independently of it. */
export const H4C_EFFECTIVE_START_YEAR = ARCHIVE_START_YEAR;

// ---------------------------------------------------------------------------
// H3b — coronal hole high-speed streams (HYPOTHESES.md, registered 2026-08-15,
// completed 2026-08-19). Built second, deliberately, to prove the pipeline
// built for H4c generalizes: only the trigger, lag windows and start year
// differ below — everything else (declustering, iterations, q,
// registered-matrix size) is the same registered choice reused, not
// reinvented, because it's the identical mitigation for the identical
// secular-drift problem.
// ---------------------------------------------------------------------------

/** HYPOTHESES.md H3b: "Coronal hole high-speed stream arrivals are followed
 * by an elevated global M5.0+ rate." */
export const H3B_TARGET_MIN_MAGNITUDE = 5.0;

/**
 * HYPOTHESES.md H3b: "Trigger definition: Stream onset = sustained speed >
 * 500 km/s for >= 6h." `minConsecutiveHours: 6` is the registered gap-handling
 * rule itself, not display emphasis — unlike `FAST_WIND_THRESHOLD` in
 * `space-weather.ts`, which numerically coincides at 500 but is declared
 * independently for exactly the reason `hypotheses.test.ts` pins.
 */
export const H3B_TRIGGERS: readonly TriggerDefinition[] = [
  { id: 'wind>500', series: 'wind_speed', comparison: '>=', threshold: 500, minConsecutiveHours: 6 },
];

/** HYPOTHESES.md H3b: "Lag windows: 0-24h, 24-48h, 48-72h, 3-5d (4 windows)." */
export const H3B_LAG_WINDOWS_HOURS: readonly (readonly [number, number])[] = [
  [0, 24],
  [24, 48],
  [48, 72],
  [72, 120],
];

export const H3B_DECLUSTERING = 'gardner-knopoff' as const;

/** HYPOTHESES.md H3b, "Baseline window" (completed 2026-08-19) — the same
 * registered mitigation as H4c's, reused for the identical secular-drift
 * reason, not shared code (the two hypothesis modules stay independent). */
export const H3B_BASELINE_WINDOW_DAYS = 365.25;

export const H3B_NULL_MODEL = 'uniform-redraw' as const;

export const H3B_TAIL = 'upper' as const;

export const H3B_ITERATIONS = 10_000;

export const H3B_Q = 0.05;

/**
 * HYPOTHESES.md H3b: "Time range: 1995-01-01 onward." Unlike H4c, this needs
 * no separate effective-span note — 1995 already sits inside the M5.0+
 * catalogue's own 1970-onward completeness window (see the "Effective span"
 * entry completed for H3b alongside H4c's).
 */
export const H3B_REQUESTED_START_UTC = '1995-01-01T00:00:00.000Z';

export const H3B_SEED = 20260819;

// ---------------------------------------------------------------------------
// H2b — hemispheric asymmetry at CME arrival (HYPOTHESES.md, registered
// 2026-08-17, completed 2026-08-19). A genuinely different test shape from
// H4c/H3b — no Poisson baseline, a hemispheric rate ratio instead of a
// lag-window one — which is exactly why it was chosen as the second
// hypothesis after H3b: it exercises a different part of the pipeline
// design, not just new parameters on the same shape.
// ---------------------------------------------------------------------------

/**
 * HYPOTHESES.md H2b: "Target set: Declustered M5.0+ global — inherited from
 * H1b by direct reference in this hypothesis's own statement." Same value as
 * every other hypothesis so far, declared independently per HYPOTHESES.md's
 * own note on why an inherited parameter still needs stating explicitly.
 */
export const H2B_TARGET_MIN_MAGNITUDE = 5.0;

/**
 * HYPOTHESES.md H2b, "Spatial split" (completed 2026-08-19): a longitude
 * band, not a 3D angular distance from the subsolar point — see that
 * entry's own note on why latitude never enters the classification.
 */
export const H2B_SPATIAL_SPLIT_DEGREES = 90;

/** HYPOTHESES.md H2b: "Lag windows: 0-24h, 24-48h from arrival (2 windows)." */
export const H2B_LAG_WINDOWS_HOURS: readonly (readonly [number, number])[] = [
  [0, 24],
  [24, 48],
];

export const H2B_DECLUSTERING = 'gardner-knopoff' as const;

/** HYPOTHESES.md H2b, "Null model" (completed 2026-08-19): arrival instants
 * redrawn uniformly without replacement from every hour in the analysis
 * span — there is no threshold/gap-handling rule here the way H4c/H3b have,
 * so (unlike theirs) every hour is an equally valid draw. */
export const H2B_NULL_MODEL = 'uniform-redraw' as const;

/** HYPOTHESES.md H2b, "Tail" (completed 2026-08-19): one-sided upper. */
export const H2B_TAIL = 'upper' as const;

export const H2B_ITERATIONS = 10_000;

export const H2B_Q = 0.05;

/**
 * HYPOTHESES.md H2b: "Time range: 2014-01-01 onward." The entry's own text
 * flags this as "the weakest claim here" — inherited by analogy from the
 * flare record's verified 2014 completeness, not independently checked for
 * WSA-ENLIL coverage.
 */
export const H2B_REQUESTED_START_UTC = '2014-01-01T00:00:00.000Z';

/** H3b was also completed 2026-08-19 — the trailing `01` keeps the two seeds
 * distinct rather than colliding on the same date. */
export const H2B_SEED = 2026081901;

// ---------------------------------------------------------------------------
// H1b — solar flares vs. global seismicity rate (HYPOTHESES.md, registered
// 2026-08-17, completed 2026-08-19). H4c's statistic with H2b's trigger
// delivery: the same moving-window Poisson baseline and lag-window ratio, but
// the triggers are a discrete catalogue of flares rather than episodes
// extracted from a thresholded series — which is why it needs neither a
// TriggerDefinition nor a gap-handling rule.
// ---------------------------------------------------------------------------

/** HYPOTHESES.md H1b: "Target set: Declustered M5.0+ global — unchanged from H1." */
export const H1B_TARGET_MIN_MAGNITUDE = 5.0;

/**
 * HYPOTHESES.md H1b: "Trigger set: Flares classified M1.0 or above."
 *
 * Applied in main, before the request is built, so the engine receives peak
 * instants rather than classes to re-derive the registered threshold from a
 * second time — the same rule that keeps `isDirectImpact` out of `h2b.py`.
 */
export const H1B_MIN_FLARE_CLASS = 'M' as const;
export const H1B_MIN_FLARE_MAGNITUDE = 1.0;

/** HYPOTHESES.md H1b: "Lag windows: 0-24h, 24-48h, 48-72h, 3-7d (4 windows)." */
export const H1B_LAG_WINDOWS_HOURS: readonly (readonly [number, number])[] = [
  [0, 24],
  [24, 48],
  [48, 72],
  [72, 168],
];

export const H1B_DECLUSTERING = 'gardner-knopoff' as const;

/**
 * HYPOTHESES.md H1b, "Baseline window" (completed 2026-08-19): ±182.625 days,
 * one year total, centred on each trigger.
 *
 * The same value H4c and H3b use, and this is the hypothesis whose own
 * measured secular drift (+36% per five decades at M5.0+) is the argument for
 * it — H3b's completion cites this entry, not the other way round.
 */
export const H1B_BASELINE_WINDOW_DAYS = 365.25;

/**
 * HYPOTHESES.md H1b, "Null model" (completed 2026-08-19): flare peak instants
 * redrawn uniformly without replacement from every hour in the span.
 *
 * Every hour, not an eligibility-masked subset. H4c and H3b exclude hours
 * where a qualifying threshold window could not have started; a flare
 * catalogue has no series behind it for such a rule to act on, so the pool is
 * unrestricted exactly as H2b's is.
 */
export const H1B_NULL_MODEL = 'uniform-redraw' as const;

/** HYPOTHESES.md H1b, "Tail" (completed 2026-08-19): one-sided upper. */
export const H1B_TAIL = 'upper' as const;

export const H1B_ITERATIONS = 10_000;

export const H1B_Q = 0.05;

/**
 * HYPOTHESES.md H1b: "Time range: 1996-01-01 onward."
 *
 * Needs no effective-span adjustment, unlike H4c's 1963: it already sits
 * inside the M5.0+ catalogue's own 1970 completeness bound, having been chosen
 * for a stricter solar-side reason (the GOES 1-7 flux scaling correction).
 */
export const H1B_REQUESTED_START_UTC = '1996-01-01T00:00:00.000Z';

export const H1B_SEED = 2026081902;

// ---------------------------------------------------------------------------
// H5 — antipodal triggering (HYPOTHESES.md, registered 2026-07-24, completed
// 2026-08-20). The only hypothesis here whose statistic is not a rate ratio:
// a one-sided Kolmogorov-Smirnov D-plus on a distance distribution.
//
// The values below duplicate `ANTIPODAL_*` in `antipodal.ts` rather than
// importing them, following the `KP_STORM_THRESHOLD` precedent: the Explore
// constant and the registered parameter stay independent declarations, tied
// together by a test. If Explore's display threshold is ever retuned, the
// registered parameter must not silently follow it.
// ---------------------------------------------------------------------------

/** HYPOTHESES.md H5: "Trigger set: Declustered M6.0+ global." */
export const H5_TRIGGER_MIN_MAGNITUDE = 6.0;

/** HYPOTHESES.md H5: "Target set: Declustered M5.0+ global." */
export const H5_TARGET_MIN_MAGNITUDE = 5.0;

/** HYPOTHESES.md H5: "Time window: 0-72h following the trigger." One window,
 * not a ladder — the no-fixed-radius design is what keeps this to one test. */
export const H5_WINDOW_HOURS: readonly [number, number] = [0, 72];

export const H5_DECLUSTERING = 'gardner-knopoff' as const;

/**
 * HYPOTHESES.md H5, "Null model" (completed 2026-08-20): trigger instants
 * redrawn uniformly from every hour in the span, **trigger locations and the
 * target catalogue both held fixed**.
 *
 * That fixity is what satisfies the registered "Completeness correction:
 * Mandatory" without a magnitude-of-completeness map: observed and null are
 * built from the same detected events, so detection bias cancels rather than
 * needing to be estimated. See the entry for why that is stricter than
 * weighting, not weaker.
 */
export const H5_NULL_MODEL = 'uniform-redraw' as const;

/** HYPOTHESES.md H5, "Tail" (completed 2026-08-20): upper — a larger D-plus
 * is more extreme. */
export const H5_TAIL = 'upper' as const;

/**
 * Bin width for the reference CDF, in km.
 *
 * Registered rather than tuned. At 100 km the reference has ~201 steps across
 * the 0-20,015 km domain, far finer than anything this data resolves:
 * epicentres carry location error of order 10 km, and the narrowest feature
 * the hypothesis predicts — the antipodal focus — is a few degrees across.
 */
export const H5_DISTANCE_BIN_KM = 100;

export const H5_ITERATIONS = 10_000;

export const H5_Q = 0.05;

/** HYPOTHESES.md H5, "Time range" (completed 2026-08-20): the M5.0+
 * catalogue's own global-completeness bound, same as H4c's effective start. */
export const H5_REQUESTED_START_UTC = '1970-01-01T00:00:00.000Z';

export const H5_SEED = 2026082001;
