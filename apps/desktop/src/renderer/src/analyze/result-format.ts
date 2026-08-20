/**
 * Formatting rules the Analyze results panel must never violate — pulled
 * out into pure functions so they're testable without mounting the panel,
 * and so no formatting decision gets reinvented ad hoc at a call site.
 */

/**
 * Never "p = 0". The engine's permutation p-value is bounded below by
 * `1 / (iterations + 1)` — with 10,000 permutations that's 1/10001 — so a
 * result more extreme than every draw prints as a bound the sample size can
 * actually support, not a false-precision zero.
 */
export function formatPValue(p: number): string {
  if (!Number.isFinite(p) || p < 0.0001) return 'p < 0.0001';
  return `p = ${p.toFixed(4)}`;
}

/** `—` for a non-finite ratio (zero exposure) rather than "NaN×" or "Infinity×". */
export function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${ratio.toFixed(2)}×`;
}

/**
 * The test statistic's *value*, formatted for whatever it actually is. The
 * column header carries the name, so this deliberately does not repeat it.
 *
 * `AnalysisTestResult.ratio` carries whatever statistic the null histogram was
 * built from, because the histogram's guide line is drawn from that field —
 * so a hypothesis whose statistic is not a ratio has nowhere else to put it.
 * H5's is a one-sided Kolmogorov-Smirnov D⁺, which the `×` suffix would
 * misreport as a multiplier: `0.07×` reads as "7% of the baseline rate" rather
 * than "a supremum CDF difference of 0.07".
 *
 * Three decimals when labelled, two when it is a ratio: a KS D lives in [0,1]
 * and its interesting range is small, so two decimals collapses distinguishable
 * values onto the same string.
 *
 * A `null` label means it genuinely is an observed/expected ratio.
 */
export function formatStatistic(value: number, label: string | null): string {
  if (label === null) return formatRatio(value);
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(3);
}

export function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}
