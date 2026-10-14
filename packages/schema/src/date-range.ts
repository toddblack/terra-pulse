import {
  ARCHIVE_ANALYSIS_MIN_MAGNITUDE,
  ARCHIVE_MIN_MAGNITUDE,
  DEEP_ARCHIVE_START_YEAR,
} from './archive';
import { COVERAGE_TIERS, MAGNITUDE_FLOORS } from './earthquake';

/**
 * A date range picked on the calendar — a fixed span of the catalogue, as
 * opposed to a window that ends at the present.
 *
 * Every other view here is "the last N hours up to now" (`windowHours`). This
 * one has both ends pinned, so it can sit anywhere in the record: March 2011,
 * the autumn of 1989, the whole of 1960.
 */
export interface DateRange {
  /** Inclusive. 00:00 UTC on the first day. */
  startMs: number;
  /** Exclusive. 00:00 UTC on the day after the last one, or "now" if sooner. */
  endMs: number;
}

/** One calendar day, in UTC. `month` is 1-12. */
export interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * The earliest day the calendar offers: where the deep archive starts.
 *
 * Nothing is stored before it, so an earlier date could only ever draw an
 * empty globe.
 */
export const DATE_RANGE_FIRST_YEAR = DEEP_ARCHIVE_START_YEAR;

/**
 * The longest range that may be drawn at the archive's own floor, M4.5+.
 *
 * **A calendar year, and it is 366 days so a leap year still counts.** This is
 * the same limit `ARCHIVE_SPANS` puts on its `1y` view, for the same measured
 * reason — every view is sized to one mark budget. Counted on the real
 * catalogue at M4.5+, busiest window of each length:
 *
 *     1 year    9,584   (2011)
 *     2 years  16,798
 *     3 years  24,376
 *     5 years  39,531   <- past the widest view the app draws at all (27,029)
 *
 * Longer ranges start at M5.5+, where even the whole record is affordable: the
 * busiest decade is 5,439 marks.
 */
export const DATE_RANGE_DENSE_MAX_DAYS = 366;

/** 00:00 UTC on a calendar day, as epoch ms. */
export function calendarDayStartMs(day: CalendarDay): number {
  return Date.UTC(day.year, day.month - 1, day.day);
}

/** The UTC calendar day an instant falls on. */
export function calendarDayOf(timeMs: number): CalendarDay {
  const date = new Date(timeMs);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/** Negative, zero or positive as `a` is before, the same as, or after `b`. */
export function compareCalendarDays(a: CalendarDay, b: CalendarDay): number {
  return calendarDayStartMs(a) - calendarDayStartMs(b);
}

/**
 * The range covering `from` through `to`, **both days included**.
 *
 * "To the 11th" means the 11th is in it, so the end is the start of the 12th.
 *
 * Clamped to `nowMs`, so a range ending today stops at the present instead of
 * reaching into hours that have not happened — the scrubber would otherwise
 * offer a playhead in the future. That makes a range ending today a snapshot:
 * it does not grow as the day goes on. The live windows are what follow the
 * clock.
 *
 * Returns `null` when the days are out of order or the range would be empty.
 */
export function dateRangeFromDays(
  from: CalendarDay,
  to: CalendarDay,
  nowMs: number,
): DateRange | null {
  const startMs = calendarDayStartMs(from);
  const endMs = Math.min(calendarDayStartMs(to) + MS_PER_DAY, nowMs);
  if (!(endMs > startMs)) return null;
  return { startMs, endMs };
}

/** A range's length in hours — the unit the playback ladder and the trail use. */
export function dateRangeHours(range: DateRange): number {
  return (range.endMs - range.startMs) / MS_PER_HOUR;
}

/**
 * The lowest magnitude a date range may be drawn at.
 *
 * Two separate limits, and the stricter wins:
 *
 * 1. **What is stored.** Small events are kept only in the rolling cache —
 *    M1+ for a week, M2.5+ for thirty days — and pruned after that. A range
 *    that starts inside one of those windows can use its floor; anything
 *    reaching further back exists at the archive's M4.5+ and nothing below.
 *    The tiers are read from `COVERAGE_TIERS`, the same constant ingest loops,
 *    so this cannot offer a floor that was never fetched.
 * 2. **The mark budget.** See `DATE_RANGE_DENSE_MAX_DAYS`.
 *
 * A range inside a live tier needs no budget check of its own: it cannot be
 * longer than the tier it sits in, and that tier already ships as a view.
 *
 * Before 1970 the archive holds only M7.5+, so a range there is sparse at any
 * floor. That is not handled by raising the floor — the `all` view does not
 * either — but by the panel saying so.
 */
export function minMagnitudeForRange(range: DateRange, nowMs: number): number {
  const storedFloors = COVERAGE_TIERS.filter(
    (tier) => range.startMs >= nowMs - tier.windowHours * MS_PER_HOUR,
  ).map((tier) => tier.minMagnitude);
  if (storedFloors.length > 0) return Math.min(...storedFloors);

  return range.endMs - range.startMs <= DATE_RANGE_DENSE_MAX_DAYS * MS_PER_DAY
    ? ARCHIVE_MIN_MAGNITUDE
    : ARCHIVE_ANALYSIS_MIN_MAGNITUDE;
}

/** Floors meaningful for a date range — the counterpart of `magnitudeFloorsForWindow`. */
export function magnitudeFloorsForRange(range: DateRange, nowMs: number): readonly number[] {
  const floor = minMagnitudeForRange(range, nowMs);
  return MAGNITUDE_FLOORS.filter((magnitude) => magnitude >= floor);
}
