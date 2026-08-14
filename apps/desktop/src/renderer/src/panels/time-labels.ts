/**
 * Relative and absolute time labels, for the whole app.
 *
 * ## Why this is one module rather than a helper per panel
 *
 * It used to be five. The event list, the hover tooltip, the legend's freshness
 * line, the large-event banner and the missed-events digest each grew their own,
 * with their own ladders and their own abbreviations — so the same elapsed time
 * could read "5d ago" in one place and "120 hr ago" in another, and the scrubber
 * rendered a 130-year archive span as **"47483d ago"**, which is true and
 * useless.
 *
 * The rule they now share: **one number and one unit, never compound.** The
 * label exists to be read at a glance and compared down a column of 26 list
 * rows; "2mo ago" does that and "1y 2mo 3d ago" does not. Precision is available
 * elsewhere — the inspector prints the exact UTC timestamp — so this is
 * deliberately the imprecise, fast-to-read view.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** Average, because the unit is approximate by design. */
const MONTH_MS = 30.44 * DAY_MS;
const YEAR_MS = 365.25 * DAY_MS;

/**
 * A duration as a single rounded unit: `45s`, `12m`, `3h`, `5d`, `3w`, `7mo`,
 * `4y`.
 *
 * Seconds appear only below a minute, where "0m" would be worse than useless on
 * an event that just landed.
 *
 * The thresholds cross at the point the smaller unit stops being readable
 * rather than at the exact conversion: days run to 14 before becoming weeks
 * (nobody thinks in "2w" for 8 days), and weeks run to 8 before becoming
 * months.
 */
export function formatDuration(millis: number): string {
  const ms = Math.max(0, millis);

  if (ms < MINUTE_MS) return `${String(Math.floor(ms / 1000))}s`;
  if (ms < HOUR_MS) return `${String(Math.floor(ms / MINUTE_MS))}m`;
  if (ms < DAY_MS) return `${String(Math.floor(ms / HOUR_MS))}h`;
  if (ms < 14 * DAY_MS) return `${String(Math.floor(ms / DAY_MS))}d`;
  if (ms < 8 * WEEK_MS) return `${String(Math.round(ms / WEEK_MS))}w`;
  if (ms < YEAR_MS) return `${String(Math.round(ms / MONTH_MS))}mo`;

  const years = ms / YEAR_MS;
  // One decimal below a decade, where 1.4 and 1.9 years are still distinct to a
  // reader; whole years above it, where the fraction is noise.
  return `${years < 10 ? years.toFixed(1) : String(Math.round(years))}y`;
}

/** The same, suffixed. `formatAgo(0)` is "just now", not "0s ago". */
export function formatAgo(millis: number): string {
  if (millis < MINUTE_MS) return millis < 5_000 ? 'just now' : `${formatDuration(millis)} ago`;
  return `${formatDuration(millis)} ago`;
}

/** How long ago an ISO instant was, or null if it can't be parsed. */
export function formatAgoFrom(iso: string | null, nowMs: number): string | null {
  if (iso === null) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return formatAgo(nowMs - parsed);
}

/**
 * An instant, at a resolution matched to the span being viewed.
 *
 * A clock time is meaningless on a 130-year axis and a bare year is useless on a
 * 24-hour one, so the *window* picks the format rather than the instant.
 */
export function formatInstant(timeMs: number, windowMs: number): string {
  const date = new Date(timeMs);

  if (windowMs >= 20 * YEAR_MS) return String(date.getUTCFullYear());
  if (windowMs >= 2 * YEAR_MS) {
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
  }
  if (windowMs >= 7 * DAY_MS) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Evenly spaced tick positions across a window, as `{ fraction, label }`.
 *
 * Fractions rather than pixels, so the caller positions them in percentages and
 * they survive a resize with no recomputation.
 */
export function axisTicks(
  startMs: number,
  endMs: number,
  count = 5,
): { fraction: number; label: string }[] {
  const span = endMs - startMs;
  if (span <= 0 || count < 2) return [];

  return Array.from({ length: count }, (_, i) => {
    const fraction = i / (count - 1);
    return { fraction, label: formatInstant(startMs + span * fraction, span) };
  });
}
