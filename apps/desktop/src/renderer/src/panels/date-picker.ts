import { compareCalendarDays, type CalendarDay } from '@terra-pulse/schema';

/**
 * The calendar's arithmetic, kept apart from the component that draws it.
 *
 * Pure and DOM-free so it can be tested here, where there is no jsdom — the
 * same split `event-list-window.ts` and `phase-rose.ts` make. Everything is
 * plain calendar arithmetic on year/month/day numbers: no `Date` is read for
 * "today", so nothing in here depends on the machine's time zone.
 */

/** Which of the picker's three steps is showing. */
export type PickerView = 'year' | 'month' | 'day';

export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one. `month` is 1-12, so
  // passing it unshifted as a 0-based month already names the next one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * A month laid out in weeks, Sunday first, padded with `null` so the first
 * day lands under its weekday.
 *
 * Always whole weeks, so the grid below it does not have a ragged last row.
 */
export function monthGrid(year: number, month: number): (number | null)[] {
  const leading = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const cells: (number | null)[] = Array.from({ length: leading }, () => null);
  for (let day = 1; day <= daysInMonth(year, month); day += 1) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/** The first year of the decade a year belongs to: 1989 → 1980. */
export function decadeOf(year: number): number {
  return Math.floor(year / 10) * 10;
}

/** Every decade touching `[firstYear, lastYear]`, oldest first. */
export function decadesBetween(firstYear: number, lastYear: number): number[] {
  const decades: number[] = [];
  for (let decade = decadeOf(firstYear); decade <= lastYear; decade += 10) decades.push(decade);
  return decades;
}

/** Whether any day of a year falls inside `[min, max]`. */
export function yearInBounds(year: number, min: CalendarDay, max: CalendarDay): boolean {
  return year >= min.year && year <= max.year;
}

/** Whether any day of a month falls inside `[min, max]`. */
export function monthInBounds(
  year: number,
  month: number,
  min: CalendarDay,
  max: CalendarDay,
): boolean {
  const index = year * 12 + month;
  return index >= min.year * 12 + min.month && index <= max.year * 12 + max.month;
}

export function dayInBounds(day: CalendarDay, min: CalendarDay, max: CalendarDay): boolean {
  return compareCalendarDays(day, min) >= 0 && compareCalendarDays(day, max) <= 0;
}

/** The month before or after, rolling the year. `step` is -1 or 1. */
export function shiftMonth(
  year: number,
  month: number,
  step: -1 | 1,
): { year: number; month: number } {
  const index = year * 12 + (month - 1) + step;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/**
 * Where the picker should open.
 *
 * - **With a value**, on that value's month: the reader is adjusting a date
 *   they already picked, and it is one click from there.
 * - **With a hint** (the other end of the range), on the hint's month. Having
 *   just picked 11 March 2011 as the start, the end is almost always nearby.
 * - **With neither**, on the year step — year, then month, then day, which is
 *   the only order that reaches 1989 from 2026 without paging through 440
 *   months.
 */
export function openingView(
  value: CalendarDay | null,
  hint: CalendarDay | null,
  max: CalendarDay,
): { view: PickerView; year: number; month: number } {
  const anchor = value ?? hint;
  if (anchor !== null) return { view: 'day', year: anchor.year, month: anchor.month };
  return { view: 'year', year: max.year, month: max.month };
}

/**
 * The two ends after one of them was changed.
 *
 * The end's calendar does not offer days before the start, so only one case
 * can put them out of order: moving the start past the end. The end then
 * follows it, giving a one-day range the reader extends from there. Refusing
 * the pick instead would make moving a range later a two-step chore in the
 * wrong order — end first, then start.
 */
export function withFrom(
  from: CalendarDay,
  to: CalendarDay | null,
): { from: CalendarDay; to: CalendarDay | null } {
  if (to !== null && compareCalendarDays(from, to) > 0) return { from, to: from };
  return { from, to };
}
