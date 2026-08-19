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

export function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}
