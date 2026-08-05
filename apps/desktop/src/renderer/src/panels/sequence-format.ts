/**
 * Presentation helpers for the observed-sequence panel.
 *
 * Pure and free of React, on the same reasoning as `earthquake-encoding.ts`:
 * the wording is the part most likely to be quietly wrong, and it should be
 * testable without rendering anything.
 */

/**
 * A duration since the mainshock, in the largest unit that stays readable.
 *
 * Aftershock sequences span minutes to years, so a single unit is wrong at one
 * end or the other: "0.0004 years" and "8,760 hours" describe the same panel
 * badly in opposite directions.
 */
export function formatElapsed(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return 'unknown';
  if (hours < 1) {
    const minutes = Math.round(hours * 60);
    return `${minutes} min`;
  }
  if (hours < 48) return `${Math.round(hours)} h`;
  const days = hours / 24;
  if (days < 60) return `${Math.round(days)} d`;
  const months = days / 30.44;
  if (months < 24) return `${Math.round(months)} mo`;
  return `${(days / 365.25).toFixed(1)} y`;
}

/** The Gardner-Knopoff window as a phrase, e.g. "71 km · 2.5 y". */
export function formatWindow(radiusKm: number, windowDays: number): string {
  const distance = `${Math.round(radiusKm)} km`;
  const span =
    windowDays < 90
      ? `${Math.round(windowDays)} d`
      : windowDays < 365
        ? `${Math.round(windowDays / 30.44)} mo`
        : `${(windowDays / 365.25).toFixed(1)} y`;
  return `${distance} · ${span}`;
}

/**
 * Collapses a year list into ranges: [2021, 2022, 2025] → "2021–2022, 2025".
 *
 * An M9's window spans three calendar years and a long gap in the archive could
 * name a dozen, which as a comma list would be longer than the panel and read
 * as noise rather than as a caveat.
 */
export function formatYearRanges(years: readonly number[]): string {
  if (years.length === 0) return '';
  const sorted = [...years].sort((a, b) => a - b);

  const ranges: string[] = [];
  let start = sorted[0] as number;
  let previous = start;

  for (const year of sorted.slice(1)) {
    if (year === previous + 1) {
      previous = year;
      continue;
    }
    ranges.push(start === previous ? `${start}` : `${start}–${previous}`);
    start = year;
    previous = year;
  }
  ranges.push(start === previous ? `${start}` : `${start}–${previous}`);

  return ranges.join(', ');
}

/**
 * Bar heights as percentages of the busiest bin.
 *
 * Takes **rates**, not counts — see `SequenceBin.perDay` for why plotting raw
 * counts across log-spaced bins shows Omori decay running backwards.
 *
 * Relative, not absolute: the interesting thing is the *shape* of the decay,
 * and a sequence of 4 and a sequence of 1,134 both need to show it.
 *
 * A `null` rate — a bin that hasn't elapsed yet — returns `null`, so the strip
 * can leave the slot visibly unmeasured instead of drawing a zero-height bar
 * that would claim a quiet period.
 */
export function barHeightPercents(rates: readonly (number | null)[]): (number | null)[] {
  const busiest = Math.max(0, ...rates.map((rate) => rate ?? 0));
  if (busiest === 0) return rates.map((rate) => (rate === null ? null : 0));

  return rates.map((rate) => {
    if (rate === null) return null;
    if (rate === 0) return 0;
    // A non-zero bin always gets a visible sliver. Without the floor, Tohoku's
    // 0.32/day beside its 182/day first bin is 0.18% and renders as nothing —
    // reading as "no aftershocks then", the opposite of what happened.
    return Math.max(4, (rate / busiest) * 100);
  });
}

/**
 * A rate for display: "182/day", "1.5/day", "0.3/day".
 *
 * Rates in a sequence span three orders of magnitude, so a fixed precision is
 * wrong at one end — "182.0/day" is noise and "0/day" is a lie about a bin that
 * had events in it.
 */
export function formatRate(perDay: number | null): string {
  if (perDay === null) return 'not yet elapsed';
  if (perDay === 0) return '0/day';
  if (perDay >= 10) return `${Math.round(perDay)}/day`;
  if (perDay >= 1) return `${perDay.toFixed(1)}/day`;
  if (perDay >= 0.1) return `${perDay.toFixed(2)}/day`;
  // Below ~1 event per 10 days, a per-day figure is all leading zeroes.
  return `${(perDay * 30.44).toFixed(1)}/mo`;
}
