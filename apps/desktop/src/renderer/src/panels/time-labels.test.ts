import { describe, expect, it } from 'vitest';
import {
  axisTicks,
  formatAgo,
  formatAgoFrom,
  formatDateRange,
  formatDuration,
  formatInstant,
  formatRangePlayhead,
  formatUtcDay,
} from './time-labels';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const YEAR = 365.25 * DAY;

describe('formatDuration', () => {
  it('never emits more than one unit', () => {
    // The rule the whole module exists for: one number, one unit, readable at a
    // glance and comparable down a column of list rows.
    const samples = [0, 30 * SECOND, 90 * MINUTE, 3 * DAY, 20 * DAY, 100 * DAY, 5 * YEAR];
    for (const ms of samples) {
      expect(formatDuration(ms)).toMatch(/^[\d.]+(s|m|h|d|w|mo|y)$/);
    }
  });

  it('walks the ladder', () => {
    expect(formatDuration(45 * SECOND)).toBe('45s');
    expect(formatDuration(12 * MINUTE)).toBe('12m');
    expect(formatDuration(3 * HOUR)).toBe('3h');
    expect(formatDuration(5 * DAY)).toBe('5d');
    expect(formatDuration(21 * DAY)).toBe('3w');
    expect(formatDuration(200 * DAY)).toBe('7mo');
    expect(formatDuration(4 * YEAR)).toBe('4.0y');
  });

  it('keeps days past a fortnight, because nobody thinks in "2w" for 8 days', () => {
    expect(formatDuration(8 * DAY)).toBe('8d');
    expect(formatDuration(13 * DAY)).toBe('13d');
    expect(formatDuration(14 * DAY)).toBe('2w');
  });

  it('keeps weeks up to two months', () => {
    expect(formatDuration(7 * WEEK)).toBe('7w');
    expect(formatDuration(9 * WEEK)).toBe('2mo');
  });

  it('drops the decimal on years past a decade', () => {
    // 1.4 vs 1.9 years is something a reader tracks; 47.3 vs 47.8 is noise.
    expect(formatDuration(1.4 * YEAR)).toBe('1.4y');
    expect(formatDuration(47 * YEAR)).toBe('47y');
  });

  it('handles the span that started all this', () => {
    // A 130-year archive window used to render as "47483d ago".
    expect(formatDuration(130 * YEAR)).toBe('130y');
  });

  it('never returns a negative or NaN label', () => {
    expect(formatDuration(-5000)).toBe('0s');
    expect(formatDuration(0)).toBe('0s');
  });
});

describe('formatAgo', () => {
  it('says "just now" rather than "0s ago"', () => {
    expect(formatAgo(0)).toBe('just now');
    expect(formatAgo(3 * SECOND)).toBe('just now');
  });

  it('suffixes everything else', () => {
    expect(formatAgo(30 * SECOND)).toBe('30s ago');
    expect(formatAgo(5 * DAY)).toBe('5d ago');
  });
});

describe('formatAgoFrom', () => {
  const now = Date.parse('2026-08-14T12:00:00.000Z');

  it('measures back from the given instant', () => {
    expect(formatAgoFrom('2026-08-14T09:00:00.000Z', now)).toBe('3h ago');
  });

  it('returns null for a null or unparseable input, rather than a wrong label', () => {
    expect(formatAgoFrom(null, now)).toBeNull();
    expect(formatAgoFrom('not a date', now)).toBeNull();
  });

  it('handles a future timestamp without going negative', () => {
    // Clock skew and revised events both produce these.
    expect(formatAgoFrom('2026-08-14T13:00:00.000Z', now)).toBe('just now');
  });
});

describe('formatInstant', () => {
  const t = Date.parse('1989-03-14T01:00:00.000Z');

  it('shows only the year on a multi-decade axis', () => {
    expect(formatInstant(t, 130 * YEAR)).toBe('1989');
  });

  it('shows month and year on a multi-year axis', () => {
    expect(formatInstant(t, 5 * YEAR)).toMatch(/1989/);
  });

  it('shows a clock time on a short axis', () => {
    // A bare year is useless on a 24-hour axis, which is why the window picks
    // the format rather than the instant.
    expect(formatInstant(t, 12 * HOUR)).toMatch(/\d/);
    expect(formatInstant(t, 12 * HOUR)).not.toBe('1989');
  });
});

describe('axisTicks', () => {
  const start = Date.parse('2020-01-01T00:00:00.000Z');
  const end = Date.parse('2021-01-01T00:00:00.000Z');

  it('spans the window end to end', () => {
    const ticks = axisTicks(start, end, 5);
    expect(ticks).toHaveLength(5);
    expect(ticks[0]?.fraction).toBe(0);
    expect(ticks[4]?.fraction).toBe(1);
  });

  it('returns fractions, so ticks survive a resize', () => {
    for (const tick of axisTicks(start, end, 4)) {
      expect(tick.fraction).toBeGreaterThanOrEqual(0);
      expect(tick.fraction).toBeLessThanOrEqual(1);
    }
  });

  it('refuses a degenerate window rather than dividing by zero', () => {
    expect(axisTicks(start, start, 5)).toEqual([]);
    expect(axisTicks(start, end, 1)).toEqual([]);
  });
});

describe('date range labels', () => {
  const MARCH_1 = Date.UTC(2011, 2, 1);
  const APRIL_1 = Date.UTC(2011, 3, 1);

  it('names a day in UTC, not in the machine\'s zone', () => {
    // 00:00 UTC on 1 March is still 28 February across the Americas. The day
    // was picked on a UTC calendar and has to read back as the same day.
    expect(formatUtcDay(MARCH_1)).toBe(
      new Date(MARCH_1).toLocaleDateString(undefined, {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
    );
    expect(formatUtcDay(MARCH_1)).toContain('2011');
    expect(formatUtcDay(MARCH_1)).toContain('1');
  });

  it('labels a range by its last day, not the midnight after it', () => {
    // March's range ends at 00:00 on 1 April. Printing that would read as a
    // range that includes April.
    const label = formatDateRange(MARCH_1, APRIL_1);
    expect(label).toContain(formatUtcDay(Date.UTC(2011, 2, 31)));
    expect(label).not.toContain(formatUtcDay(APRIL_1));
  });

  it('prints the year once when both ends share it', () => {
    const label = formatDateRange(MARCH_1, APRIL_1);
    expect(label.match(/2011/g)).toHaveLength(1);
  });

  it('prints both years when they differ', () => {
    const label = formatDateRange(Date.UTC(1989, 9, 1), Date.UTC(1990, 1, 1));
    expect(label).toContain('1989');
    expect(label).toContain('1990');
  });

  it('prints one date for a one-day range', () => {
    const tohoku = Date.UTC(2011, 2, 11);
    expect(formatDateRange(tohoku, tohoku + 24 * 3_600_000)).toBe(formatUtcDay(tohoku));
  });

  it('shows the time of day only while an hour is a visible distance', () => {
    const quake = Date.UTC(2011, 2, 11, 5, 46);

    const month = formatRangePlayhead(quake, MARCH_1, APRIL_1);
    const decade = formatRangePlayhead(quake, MARCH_1 - 3650 * DAY, APRIL_1);

    expect(month).toContain('05:46');
    expect(decade).not.toContain('05:46');
    // Both say which clock they are on.
    expect(month).toContain('UTC');
    expect(decade).toContain('UTC');
  });

  it('names the range, not an instant, when the playhead rests at the end', () => {
    // The end of March's range is 00:00 on 1 April. Printed as an instant it
    // names a day outside the range that was picked.
    const atEnd = formatRangePlayhead(APRIL_1, MARCH_1, APRIL_1);
    expect(atEnd).toBe(formatDateRange(MARCH_1, APRIL_1));
    expect(atEnd).not.toContain(formatUtcDay(APRIL_1));
  });
});
