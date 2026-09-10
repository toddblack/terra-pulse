/**
 * Aftershock forecasting — the Reasenberg-Jones model, registered as **M1** in
 * `HYPOTHESES.md` on 2026-09-09.
 *
 * This is `PROJECT_PLAN.md` §5.9's model half. The *observed* half — what the
 * catalogue actually recorded after a mainshock — is `aftershocks.ts` beside
 * this file, and the two answer deliberately different questions:
 * `aftershocks.ts` reports history, this one reports an expectation.
 *
 * ## This is model output and must never be drawn like an observation
 *
 * Registered as a **model**, not a hypothesis: it produces no p-value and
 * contributes **nothing** to the FDR test matrix. That is not a loophole — a
 * significance test asks "could chance have done this?", and this asks "what
 * does an established empirical law imply?". Padding the matrix denominator
 * with things that were never tests would weaken every correction already
 * applied to the nineteen that were.
 *
 * The obligation that replaces FDR is honest labelling. Every surface that
 * shows these numbers has to mark them as model output, the way the
 * `magnetopause` layer marks itself `(model)`.
 *
 * ## The law
 *
 * The rate of aftershocks of magnitude ≥ `M`, per day, at time `t` days after
 * a mainshock of magnitude `Mm`:
 *
 *     λ(t, M) = 10^(a + b(Mm − M)) / (t + c)^p
 *
 * Omori-Utsu decay in time, Gutenberg-Richter in magnitude. Integrating over a
 * window gives an expected count, which is what a forecast reports.
 */

/**
 * Global generic parameters, fixed at registration.
 *
 * From **Page et al. (2016)**, Table 2's all-region stacked fit — 935 sequences
 * at Mmain ≥ 6.0, corrected for time-dependent catalogue incompleteness.
 *
 * **Not Reasenberg & Jones' own `a = −1.67`, deliberately.** Page et al. record
 * that the original fit used only sequences with enough data, which
 * overestimates mean productivity — and that researchers informally correct it
 * to −1.85 (Felzer et al., 2003). Registering the classic value would have been
 * registering a number its own literature calls biased. `b = 1.0` is the
 * paper's stated assumption, consistent with its measured 1.03 for the NEIC
 * catalogue and 1.01 ± 0.01 for the subduction regions that dominate the global
 * dataset.
 *
 * **These are global.** Page et al.'s per-tectonic-regime values differ by
 * nearly an order of magnitude in productivity — subduction is a = −2.98
 * against a = −2.04 for some active non-subduction regions — but using them
 * needs the García et al. (2012) regionalization, which this app does not
 * vendor. Assigning a regime by proximity to a Slab2 trench would be inventing
 * a classification the source does not sanction. See M1's entry for the full
 * reasoning; changing any of these values means registering M1b, not editing
 * this file.
 */
/**
 * Annotated `number` rather than left as literal types on purpose. These are
 * *registered values that a future M1b could change*, not compile-time
 * constants — and narrowing `RJ_P` to `0.92` makes the `p === 1` guard below
 * unreachable in TypeScript's view, which is the wrong lesson to encode: that
 * branch is the degenerate case where the Omori integral becomes a logarithm,
 * and it should survive someone registering a new value.
 */
export const RJ_A: number = -1.97;
export const RJ_B: number = 1.0;
export const RJ_P: number = 0.92;
/** Omori offset, **days**. */
export const RJ_C_DAYS: number = 0.018;

/**
 * Smallest mainshock this is offered for, matching §5.9 and the shared
 * analysis floor. Below it the forecast is a fraction of an event per week —
 * "expected aftershocks: 0.02/day" on a small quake is noise wearing a number.
 */
export const FORECAST_MIN_MAINSHOCK_MAGNITUDE = 5.0;

/**
 * The magnitude bins the forecast reports, registered as **M1b**.
 *
 * **M1 registered a single M ≥ 5.0 and that made the panel useless for the
 * events people actually select.** An M5.5 expects 0.015 M5+ aftershocks in
 * 24 hours, so every cell rendered "0–0" and "<0.1" — right, and
 * indistinguishable from a broken feature. The expected count only reaches one
 * event around M6.3+, which is a few dozen earthquakes a year globally.
 *
 * Binning is where the information is. On a live USGS forecast for an M5.3 the
 * one-week row reads **M3+ 17.3%** against **M5+ 0.2%** — same sequence, same
 * model, and only the smaller bins say anything at all.
 *
 * **M3.0 and M4.0 are below this app's own catalogue completeness**, which M1
 * gave as the reason for the M5.0 floor. That reasoning still holds for
 * *checking*: those two rows can never be compared against the observed-
 * sequence panel. They are registered anyway because a forecast is model
 * output rather than a catalogue claim, and USGS publishes M3+ for the same
 * reason.
 */
export const FORECAST_MAGNITUDE_BINS = [3.0, 4.0, 5.0, 6.0, 7.0] as const;

/**
 * The smallest bin that this app's own catalogue could verify.
 *
 * Used to mark the rows a reader must not try to check against the observed
 * sequence above them. Not a model parameter — it describes the *catalogue*,
 * not the forecast.
 */
export const FORECAST_VERIFIABLE_MAGNITUDE = 5.0;

/** The registered forward windows, in hours (M1b: 24 h, 7 d, 30 d). */
export const FORECAST_WINDOWS_HOURS = [24, 24 * 7, 24 * 30] as const;

const MS_PER_DAY = 86_400_000;

/**
 * Expected number of events of magnitude ≥ `targetMagnitude` between
 * `fromDays` and `toDays` after the mainshock.
 *
 * The closed-form integral of λ:
 *
 *     N = 10^(a + b(Mm − M)) · [(t₂+c)^(1−p) − (t₁+c)^(1−p)] / (1 − p)
 *
 * `p = 0.92`, so `1 − p` is 0.08 and never zero; the `p === 1` case is guarded
 * anyway, because it is the one value that turns this integral into a
 * logarithm and a future M1b could legitimately register it.
 */
export function expectedAftershocks(
  mainshockMagnitude: number,
  targetMagnitude: number,
  fromDays: number,
  toDays: number,
): number {
  if (!(toDays > fromDays)) return 0;

  const productivity = 10 ** (RJ_A + RJ_B * (mainshockMagnitude - targetMagnitude));
  const from = Math.max(0, fromDays) + RJ_C_DAYS;
  const to = toDays + RJ_C_DAYS;

  const decay =
    RJ_P === 1
      ? Math.log(to / from)
      : (to ** (1 - RJ_P) - from ** (1 - RJ_P)) / (1 - RJ_P);

  return productivity * decay;
}

/**
 * A 95% Poisson prediction interval on a count with mean `lambda`.
 *
 * **An interval, never a point estimate** — §5.9's requirement, and the reason
 * is that these counts are small and genuinely random. "3 expected" reads as a
 * prediction; "0 to 7" is what the model actually says.
 *
 * Computed exactly rather than by a normal approximation. The recurrence runs
 * in **log space** — `log pmf(k) = log pmf(k−1) + log λ − log k` from
 * `log pmf(0) = −λ` — which matters because a large mainshock gives λ in the
 * hundreds, where `exp(−λ)` underflows to zero and a multiplicative recurrence
 * started there would return all zeros. In log space those terms are genuinely
 * negligible and exponentiate to zero correctly.
 */
export function poissonInterval(lambda: number): { low: number; high: number } {
  if (!Number.isFinite(lambda) || lambda <= 0) return { low: 0, high: 0 };

  // Comfortably past the upper tail: ten standard deviations plus a floor for
  // the small-lambda case, where sqrt is tiny but the distribution still has
  // reach.
  const kMax = Math.ceil(lambda + 10 * Math.sqrt(lambda) + 20);

  let logPmf = -lambda;
  let cumulative = 0;
  let low: number | null = null;

  for (let k = 0; k <= kMax; k += 1) {
    if (k > 0) logPmf += Math.log(lambda) - Math.log(k);
    cumulative += Math.exp(logPmf);
    if (low === null && cumulative >= 0.025) low = k;
    if (cumulative >= 0.975) return { low: low ?? 0, high: k };
  }

  return { low: low ?? 0, high: kMax };
}

export interface ForecastWindow {
  /** Length of the forward window, hours. */
  hours: number;
  /** Expected count of M ≥ `targetMagnitude` events. */
  expected: number;
  /** 95% Poisson prediction interval on that count. */
  low: number;
  high: number;
  /**
   * Probability of **at least one** such event in the window.
   *
   * The same registered quantity as `expected`, read a different way — for a
   * Poisson count, `P(N ≥ 1) = 1 − e^(−λ)`. Not a new parameter and not a new
   * model; it is what makes a small forecast legible. Most eligible mainshocks
   * are M5-6, where the expected count of M5+ aftershocks is a few hundredths
   * and a table of "0-0" and "<0.1" reads as a broken panel rather than as
   * "almost certainly none".
   */
  chanceOfAny: number;
}

/** `P(N ≥ 1)` for a Poisson count with mean `expected`. */
export function probabilityOfAtLeastOne(expected: number): number {
  return 1 - Math.exp(-Math.max(0, expected));
}

/*
 * There was a `FORECAST_COUNT_READABLE_ABOVE` here — a display threshold that
 * swapped a table of counts for a sentence of probabilities when the expected
 * count fell below one. **M1b deleted the problem rather than the symptom.**
 * Binning by magnitude means every row already reports a probability, so there
 * is no longer a reading that goes illegible and no threshold to tune.
 */

/** One magnitude bin's forecast across every registered window. */
export interface ForecastRow {
  /** The bin's lower edge — the row reads "M{magnitude}+". */
  magnitude: number;
  /**
   * This app's own catalogue is complete at or above
   * `FORECAST_VERIFIABLE_MAGNITUDE`, so rows below it cannot be checked
   * against the observed-sequence panel. Carried here rather than recomputed
   * in the UI, so one definition decides which rows get the caveat.
   */
  verifiable: boolean;
  windows: ForecastWindow[];
}

export interface AftershockForecast {
  rows: ForecastRow[];
  /**
   * Probability that at least one *later* event equals or exceeds the
   * mainshock, over the longest registered window — i.e. that the mainshock
   * was a foreshock.
   *
   * **This is the number people misread**, and §5.9 requires it never appear
   * as a bare percentage. It is small, it is real, and it is the single most
   * screenshot-able figure this app produces.
   *
   * A property of the model worth knowing: with `b` fixed, `b(Mm − M)` is zero
   * when `M = Mm`, so the expected count of events at least as large as the
   * mainshock is `10^a` times the decay integral — **the same for every
   * mainshock magnitude**. A forecast for an M5.2 and an M8.2 give the same
   * foreshock probability. That is what the model says, not a bug, and it is a
   * good reason to show the framing rather than the figure alone.
   */
  probabilityOfLarger: number;
  /** Days since the mainshock at the moment the forecast was made. */
  elapsedDays: number;
}

/**
 * The forecast for a mainshock, from `now` forward over the registered windows.
 *
 * Forecasts from **now**, not from the mainshock: the aftershocks between the
 * mainshock and now have already happened and are the observed panel's
 * subject. Asking "how many more?" is the only question a forecast can answer
 * about an event in the past.
 */
export function forecastAftershocks(
  mainshockMagnitude: number,
  mainshockTimeMs: number,
  nowMs: number,
): AftershockForecast {
  const elapsedDays = Math.max(0, (nowMs - mainshockTimeMs) / MS_PER_DAY);

  const rows = FORECAST_MAGNITUDE_BINS.map((magnitude) => ({
    magnitude,
    verifiable: magnitude >= FORECAST_VERIFIABLE_MAGNITUDE,
    windows: FORECAST_WINDOWS_HOURS.map((hours) => {
      const expected = expectedAftershocks(
        mainshockMagnitude,
        magnitude,
        elapsedDays,
        elapsedDays + hours / 24,
      );
      const { low, high } = poissonInterval(expected);
      return { hours, expected, low, high, chanceOfAny: probabilityOfAtLeastOne(expected) };
    }),
  }));

  const longestDays = Math.max(...FORECAST_WINDOWS_HOURS) / 24;
  const expectedLarger = expectedAftershocks(
    mainshockMagnitude,
    mainshockMagnitude,
    elapsedDays,
    elapsedDays + longestDays,
  );

  return {
    rows,
    probabilityOfLarger: probabilityOfAtLeastOne(expectedLarger),
    elapsedDays,
  };
}

/**
 * How long after a mainshock a forecast is still worth showing.
 *
 * §5.9: "only inside a window where the decay is still meaningful."
 * Omori decay means the rate a year on is a small fraction of day one, and a
 * forecast of 0.01 events is a number pretending to be information. One year
 * is generous and keeps the cutoff a round, obviously-arbitrary line rather
 * than one tuned to make some particular event qualify.
 */
export const FORECAST_MAX_ELAPSED_DAYS = 365;

/** Whether a forecast should be offered for this event at all. */
export function isForecastEligible(
  magnitude: number,
  mainshockTimeMs: number,
  nowMs: number,
): boolean {
  if (magnitude < FORECAST_MIN_MAINSHOCK_MAGNITUDE) return false;
  const elapsedDays = (nowMs - mainshockTimeMs) / MS_PER_DAY;
  // A future-dated event is a clock problem, not a forecastable mainshock.
  return elapsedDays >= 0 && elapsedDays <= FORECAST_MAX_ELAPSED_DAYS;
}
