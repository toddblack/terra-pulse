import { describe, expect, it } from 'vitest';
import { ARCHIVE_SPANS } from './archive';
import {
  DATE_RANGE_DENSE_MAX_DAYS,
  calendarDayOf,
  calendarDayStartMs,
  compareCalendarDays,
  dateRangeFromDays,
  dateRangeHours,
  magnitudeFloorsForRange,
  minMagnitudeForRange,
} from './date-range';
import { COVERAGE_TIERS, MAGNITUDE_FLOORS } from './earthquake';

const NOW = Date.UTC(2026, 9, 13, 15, 30, 0);
const DAY = 24 * 3_600_000;

function range(from: [number, number, number], to: [number, number, number]) {
  const made = dateRangeFromDays(
    { year: from[0], month: from[1], day: from[2] },
    { year: to[0], month: to[1], day: to[2] },
    NOW,
  );
  if (made === null) throw new Error('expected a range');
  return made;
}

describe('calendar days', () => {
  it('are UTC days, whatever the machine is set to', () => {
    // 23:30 UTC on the 11th is already the 12th in Tokyo and still the 11th in
    // Los Angeles. The catalogue is in UTC, so the day is too.
    const lateOnThe11th = Date.UTC(2011, 2, 11, 23, 30);
    expect(calendarDayOf(lateOnThe11th)).toEqual({ year: 2011, month: 3, day: 11 });
  });

  it('round-trip through their own midnight', () => {
    const day = { year: 1989, month: 10, day: 17 };
    expect(calendarDayOf(calendarDayStartMs(day))).toEqual(day);
  });

  it('compare in calendar order', () => {
    const earlier = { year: 2011, month: 3, day: 11 };
    const later = { year: 2011, month: 4, day: 1 };
    expect(compareCalendarDays(earlier, later)).toBeLessThan(0);
    expect(compareCalendarDays(later, earlier)).toBeGreaterThan(0);
    expect(compareCalendarDays(earlier, { ...earlier })).toBe(0);
  });
});

describe('dateRangeFromDays', () => {
  it('includes the last day', () => {
    // "To the 31st" has the 31st in it. Ending at the 31st's midnight would
    // silently drop a whole day of every range anyone picked.
    const march = range([2011, 3, 1], [2011, 3, 31]);
    expect(march.startMs).toBe(Date.UTC(2011, 2, 1));
    expect(march.endMs).toBe(Date.UTC(2011, 3, 1));
    expect(dateRangeHours(march)).toBe(31 * 24);
  });

  it('makes a one-day range from the same day twice', () => {
    const tohoku = range([2011, 3, 11], [2011, 3, 11]);
    expect(dateRangeHours(tohoku)).toBe(24);
  });

  it('stops at the present when the last day is today', () => {
    // Otherwise the scrubber would offer a playhead in hours that have not
    // happened yet.
    const thisMonth = range([2026, 10, 1], [2026, 10, 13]);
    expect(thisMonth.endMs).toBe(NOW);
  });

  it('refuses days in the wrong order', () => {
    expect(
      dateRangeFromDays({ year: 2011, month: 4, day: 1 }, { year: 2011, month: 3, day: 1 }, NOW),
    ).toBeNull();
  });

  it('refuses a range that would be empty', () => {
    // Tomorrow, clamped to now, ends before it starts.
    const tomorrow = { year: 2026, month: 10, day: 14 };
    expect(dateRangeFromDays(tomorrow, tomorrow, NOW)).toBeNull();
  });
});

describe('minMagnitudeForRange', () => {
  it('offers the archive floor for a month in the past', () => {
    expect(minMagnitudeForRange(range([2011, 3, 1], [2011, 3, 31]), NOW)).toBe(4.5);
  });

  it('allows a whole calendar year at the archive floor, leap years included', () => {
    // 2011 is the busiest year on record at M4.5+ (9,584 marks) and is the
    // case the limit was sized on. 2012 is the same request one day longer —
    // a limit of 365 days would send it to M5.5+ for no reason anyone could
    // guess from the screen.
    expect(minMagnitudeForRange(range([2011, 1, 1], [2011, 12, 31]), NOW)).toBe(4.5);
    expect(minMagnitudeForRange(range([2012, 1, 1], [2012, 12, 31]), NOW)).toBe(4.5);
  });

  it('raises the floor once a range is longer than a year', () => {
    // Two years at M4.5+ is 16,798 marks and five is 39,531 — past the widest
    // view the app draws at all.
    const twoYears = range([2010, 1, 1], [2011, 12, 31]);
    expect(dateRangeHours(twoYears)).toBeGreaterThan(DATE_RANGE_DENSE_MAX_DAYS * 24);
    expect(minMagnitudeForRange(twoYears, NOW)).toBe(5.5);
  });

  it('never goes below what a decade-long archive span is drawn at', () => {
    // The 10y span and a 10-year date range are the same amount of globe.
    const decade = range([1990, 1, 1], [1999, 12, 31]);
    const tenYearSpan = ARCHIVE_SPANS.find((span) => span.years === 10);
    expect(minMagnitudeForRange(decade, NOW)).toBe(tenYearSpan?.minMagnitude);
  });

  it('offers the small floors only while the rolling cache still holds them', () => {
    // M1+ is kept for a week and M2.5+ for thirty days, then pruned. A range
    // that starts inside one of those windows can use its floor.
    expect(minMagnitudeForRange(range([2026, 10, 10], [2026, 10, 12]), NOW)).toBe(1);
    expect(minMagnitudeForRange(range([2026, 9, 20], [2026, 10, 1]), NOW)).toBe(2.5);
  });

  it('goes by where the range starts, not where it ends', () => {
    // Ends yesterday, starts two months back. The recent end is in the rolling
    // cache; the start is not, and below M4.5 most of the range would be empty
    // with nothing to say why.
    expect(minMagnitudeForRange(range([2026, 8, 1], [2026, 10, 12]), NOW)).toBe(4.5);
  });

  it('agrees with the live tiers at their own edges', () => {
    // A range exactly as long as a tier, ending now, is that tier's view and
    // must not be offered a lower floor than the tier itself.
    for (const tier of COVERAGE_TIERS) {
      const asRange = { startMs: NOW - tier.windowHours * 3_600_000, endMs: NOW };
      expect(minMagnitudeForRange(asRange, NOW)).toBeLessThanOrEqual(tier.minMagnitude);
    }
    const justPastAWeek = { startMs: NOW - 7 * DAY - 1, endMs: NOW };
    expect(minMagnitudeForRange(justPastAWeek, NOW)).toBe(2.5);
  });
});

describe('magnitudeFloorsForRange', () => {
  it('is every offered floor at or above the range minimum', () => {
    const floors = magnitudeFloorsForRange(range([2011, 3, 1], [2011, 3, 31]), NOW);
    expect(floors).toEqual(MAGNITUDE_FLOORS.filter((floor) => floor >= 4.5));
  });

  it('never comes back empty', () => {
    const everything = range([1900, 1, 1], [2026, 10, 13]);
    expect(magnitudeFloorsForRange(everything, NOW).length).toBeGreaterThan(0);
  });
});
