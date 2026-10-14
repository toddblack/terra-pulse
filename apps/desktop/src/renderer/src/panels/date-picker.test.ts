import { describe, expect, it } from 'vitest';
import {
  dayInBounds,
  daysInMonth,
  decadeOf,
  decadesBetween,
  monthGrid,
  monthInBounds,
  openingView,
  shiftMonth,
  withFrom,
  yearInBounds,
} from './date-picker';

const MIN = { year: 1900, month: 1, day: 1 };
const TODAY = { year: 2026, month: 10, day: 13 };

describe('daysInMonth', () => {
  it('knows the month lengths', () => {
    expect(daysInMonth(2011, 3)).toBe(31);
    expect(daysInMonth(2011, 4)).toBe(30);
    expect(daysInMonth(2011, 12)).toBe(31);
  });

  it('handles February, including the century rule', () => {
    expect(daysInMonth(2011, 2)).toBe(28);
    expect(daysInMonth(2012, 2)).toBe(29);
    // 1900 is in range and is not a leap year; 2000 is. A calendar that got
    // this wrong would offer a 29 February 1900 that never happened.
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
  });
});

describe('monthGrid', () => {
  it('puts the first day under its weekday', () => {
    // 1 March 2011 was a Tuesday: two blanks, Sunday first.
    const grid = monthGrid(2011, 3);
    expect(grid.slice(0, 3)).toEqual([null, null, 1]);
  });

  it('holds every day once, in order', () => {
    const days = monthGrid(2011, 3).filter((cell) => cell !== null);
    expect(days).toEqual(Array.from({ length: 31 }, (_, index) => index + 1));
  });

  it('is always whole weeks', () => {
    for (let month = 1; month <= 12; month += 1) {
      expect(monthGrid(2011, month).length % 7).toBe(0);
    }
  });

  it('starts flush when the month begins on a Sunday', () => {
    // 1 May 2011 was a Sunday.
    expect(monthGrid(2011, 5)[0]).toBe(1);
  });
});

describe('decades', () => {
  it('names a decade by its first year', () => {
    expect(decadeOf(1989)).toBe(1980);
    expect(decadeOf(1980)).toBe(1980);
    expect(decadeOf(2026)).toBe(2020);
  });

  it('covers the whole record, oldest first', () => {
    const decades = decadesBetween(1900, 2026);
    expect(decades[0]).toBe(1900);
    expect(decades[decades.length - 1]).toBe(2020);
    expect(decades).toHaveLength(13);
  });
});

describe('bounds', () => {
  it('lets through years that hold any pickable day', () => {
    expect(yearInBounds(1900, MIN, TODAY)).toBe(true);
    expect(yearInBounds(2026, MIN, TODAY)).toBe(true);
    expect(yearInBounds(1899, MIN, TODAY)).toBe(false);
    // The rest of the 2020s is drawn — the decade is ten cells — but dead.
    expect(yearInBounds(2027, MIN, TODAY)).toBe(false);
  });

  it('stops the months at the current one', () => {
    expect(monthInBounds(2026, 10, MIN, TODAY)).toBe(true);
    expect(monthInBounds(2026, 11, MIN, TODAY)).toBe(false);
    expect(monthInBounds(2025, 11, MIN, TODAY)).toBe(true);
  });

  it('stops the days at today', () => {
    expect(dayInBounds({ year: 2026, month: 10, day: 13 }, MIN, TODAY)).toBe(true);
    expect(dayInBounds({ year: 2026, month: 10, day: 14 }, MIN, TODAY)).toBe(false);
  });

  it('holds the end date at or after the start', () => {
    // The To calendar is given the start as its minimum.
    const from = { year: 2011, month: 3, day: 11 };
    expect(dayInBounds({ year: 2011, month: 3, day: 10 }, from, TODAY)).toBe(false);
    expect(dayInBounds(from, from, TODAY)).toBe(true);
    // And the month before it is not offered at all.
    expect(monthInBounds(2011, 2, from, TODAY)).toBe(false);
    expect(monthInBounds(2011, 3, from, TODAY)).toBe(true);
  });
});

describe('shiftMonth', () => {
  it('steps within a year', () => {
    expect(shiftMonth(2011, 3, 1)).toEqual({ year: 2011, month: 4 });
    expect(shiftMonth(2011, 3, -1)).toEqual({ year: 2011, month: 2 });
  });

  it('rolls the year at either end', () => {
    expect(shiftMonth(2011, 12, 1)).toEqual({ year: 2012, month: 1 });
    expect(shiftMonth(2011, 1, -1)).toEqual({ year: 2010, month: 12 });
  });
});

describe('openingView', () => {
  it('starts a fresh pick on the year', () => {
    // Year, month, day — the order that reaches 1989 without paging through
    // four hundred months.
    expect(openingView(null, null, TODAY).view).toBe('year');
  });

  it('reopens on the month already picked', () => {
    const value = { year: 2011, month: 3, day: 11 };
    expect(openingView(value, null, TODAY)).toEqual({ view: 'day', year: 2011, month: 3 });
  });

  it('opens the empty end on the other end\'s month', () => {
    const start = { year: 2011, month: 3, day: 11 };
    expect(openingView(null, start, TODAY)).toEqual({ view: 'day', year: 2011, month: 3 });
  });

  it('prefers its own value to the hint', () => {
    const value = { year: 2011, month: 4, day: 1 };
    const hint = { year: 2011, month: 3, day: 11 };
    expect(openingView(value, hint, TODAY).month).toBe(4);
  });
});

describe('withFrom', () => {
  const end = { year: 2011, month: 3, day: 31 };

  it('leaves the end alone when the start is before it', () => {
    const start = { year: 2011, month: 3, day: 1 };
    expect(withFrom(start, end)).toEqual({ from: start, to: end });
  });

  it('drags the end along when the start moves past it', () => {
    // Moving a range later, start first. Refusing would force the reader to
    // move the end first, which is backwards.
    const later = { year: 2020, month: 1, day: 5 };
    expect(withFrom(later, end)).toEqual({ from: later, to: later });
  });

  it('has nothing to fix while there is no end yet', () => {
    const start = { year: 2011, month: 3, day: 1 };
    expect(withFrom(start, null)).toEqual({ from: start, to: null });
  });
});
