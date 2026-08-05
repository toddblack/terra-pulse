import { describe, expect, it } from 'vitest';
import {
  barHeightPercents,
  formatElapsed,
  formatRate,
  formatWindow,
  formatYearRanges,
} from './sequence-format';

describe('formatElapsed', () => {
  it.each([
    { hours: 0.25, expected: '15 min' },
    { hours: 1, expected: '1 h' },
    { hours: 30, expected: '30 h' },
    { hours: 24 * 5, expected: '5 d' },
    { hours: 24 * 120, expected: '4 mo' },
    { hours: 24 * 900, expected: '2.5 y' },
  ])('renders $hours hours as $expected', ({ hours, expected }) => {
    expect(formatElapsed(hours)).toBe(expected);
  });

  it('escalates units rather than printing an absurd number in one', () => {
    // The failure this exists to prevent: a two-year-later aftershock reported
    // as "17520 h", or a same-hour one as "0.0 y".
    expect(formatElapsed(24 * 730)).not.toMatch(/\bh\b/);
    expect(formatElapsed(0.5)).not.toMatch(/\by\b/);
  });

  it('says so rather than guessing on nonsense input', () => {
    expect(formatElapsed(Number.NaN)).toBe('unknown');
    expect(formatElapsed(-5)).toBe('unknown');
  });
});

describe('formatWindow', () => {
  it('uses days for a short window', () => {
    expect(formatWindow(40, 24)).toBe('40 km · 24 d');
  });

  it('uses months in between', () => {
    expect(formatWindow(47, 268)).toBe('47 km · 9 mo');
  });

  it('uses years for the long windows large events get', () => {
    expect(formatWindow(70.7, 918)).toBe('71 km · 2.5 y');
  });
});

describe('formatYearRanges', () => {
  it('is empty for no gaps', () => {
    expect(formatYearRanges([])).toBe('');
  });

  it('renders a single year alone', () => {
    expect(formatYearRanges([1987])).toBe('1987');
  });

  it('collapses consecutive years into a range', () => {
    expect(formatYearRanges([2020, 2021, 2022])).toBe('2020–2022');
  });

  it('keeps disjoint groups separate', () => {
    expect(formatYearRanges([1985, 1986, 1990])).toBe('1985–1986, 1990');
  });

  it('sorts before collapsing', () => {
    expect(formatYearRanges([1990, 1985, 1986])).toBe('1985–1986, 1990');
  });

  it('renders a two-year run as a range, not a pair', () => {
    expect(formatYearRanges([2021, 2022])).toBe('2021–2022');
  });
});

describe('barHeightPercents', () => {
  it('scales relative to the busiest bin', () => {
    expect(barHeightPercents([10, 5, 0, 0, 0])).toEqual([100, 50, 0, 0, 0]);
  });

  it('keeps an empty sequence at zero rather than dividing by zero', () => {
    expect(barHeightPercents([0, 0, 0, 0, 0])).toEqual([0, 0, 0, 0, 0]);
  });

  /**
   * Tohoku as a rate: 182/day falling to 0.32/day. Without a floor the last bin
   * is 0.18% of the first and renders as nothing, so the strip would claim the
   * sequence had stopped when it was still producing an event every three days.
   */
  it('gives any non-zero rate a visible sliver', () => {
    const heights = barHeightPercents([182, 39.3, 8.9, 1.5, 0.32]);
    expect(heights[0]).toBe(100);
    expect(heights[4]).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < heights.length; i += 1) {
      expect(heights[i]).toBeLessThanOrEqual(heights[i - 1] as number);
    }
  });

  it('never lifts a genuinely empty bin off the baseline', () => {
    // The floor must not turn "nothing happened" into a visible bar.
    expect(barHeightPercents([100, 0])[1]).toBe(0);
  });

  it('passes a not-yet-elapsed bin through as null, distinct from zero', () => {
    // The strip renders these differently: a zero is a measured quiet period,
    // a null is a period that has not happened.
    expect(barHeightPercents([10, 0, null])).toEqual([100, 0, null]);
    expect(barHeightPercents([null, null])).toEqual([null, null]);
  });

  it('ignores nulls when picking the busiest bin', () => {
    expect(barHeightPercents([null, 4, 2])).toEqual([null, 100, 50]);
  });
});

describe('formatRate', () => {
  it.each([
    { perDay: 182, expected: '182/day' },
    { perDay: 39.3, expected: '39/day' },
    { perDay: 1.5, expected: '1.5/day' },
    { perDay: 0.32, expected: '0.32/day' },
    { perDay: 0, expected: '0/day' },
  ])('renders $perDay as $expected', ({ perDay, expected }) => {
    expect(formatRate(perDay)).toBe(expected);
  });

  it('switches to a monthly figure rather than printing leading zeroes', () => {
    // "0.01/day" is unreadable; "0.3/mo" is the same fact.
    expect(formatRate(0.01)).toBe('0.3/mo');
  });

  it('distinguishes a bin that has not elapsed from one with no events', () => {
    expect(formatRate(null)).toBe('not yet elapsed');
    expect(formatRate(0)).toBe('0/day');
  });
});
