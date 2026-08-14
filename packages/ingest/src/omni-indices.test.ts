import { describe, expect, it } from 'vitest';
import { hourFromDayOfYear, parseOmniHourly } from './omni-indices';

/**
 * A row in OMNI2's hourly layout — 55 whitespace-separated fields, with Kp*10
 * at index 38 and Dst at index 40.
 *
 * Fixture-based rather than networked. The parser was verified once against the
 * real 1989 file (8,760 samples, min Dst -589 nT at 1989-03-14T01:00Z, Kp 9 the
 * evening before, no fill values leaking); these encode that behaviour without
 * making the suite depend on NASA being up — the lesson the EMSC tests taught.
 */
function row(
  year: number,
  dayOfYear: number,
  hour: number,
  kp10: number,
  dst: number,
): string {
  const fields = new Array<string>(55).fill('0');
  fields[0] = String(year);
  fields[1] = String(dayOfYear);
  fields[2] = String(hour);
  fields[38] = String(kp10);
  fields[40] = String(dst);
  return fields.join(' ');
}

describe('parseOmniHourly', () => {
  it('reads Dst as nT', () => {
    const [sample] = parseOmniHourly(row(1989, 73, 1, 90, -589));
    expect(sample?.dst).toBe(-589);
    // The Quebec storm, which is what the column mapping was checked against.
    expect(sample?.timeUtc).toBe('1989-03-14T01:00:00.000Z');
  });

  it('never emits Kp, whatever OMNI has in that column', () => {
    // GFZ owns Kp now. This is not tidiness: insertSpaceWeather coalesces with
    // `excluded` winning, and the backfill fetches GFZ first and then loops the
    // OMNI years — so a value here would overwrite GFZ's exact thirds with
    // OMNI's rounded tenths for every hour from 1963 on, undoing the switch on
    // the very run that performed it.
    const withHighKp = parseOmniHourly(row(1989, 73, 1, 90, -589))[0];
    expect(withHighKp?.kp).toBeNull();

    const withLowKp = parseOmniHourly(row(2020, 1, 0, 3, -5))[0];
    expect(withLowKp?.kp).toBeNull();
  });

  it('treats the Dst fill value as absent, not as a measurement', () => {
    // A width-matched sentinel: 99999 in a five-digit field. Read as data it is
    // a +99999 nT excursion, which passes any plausibility check a chart
    // applies while being three orders of magnitude past the largest storm on
    // record.
    expect(parseOmniHourly(row(2020, 5, 3, 40, 99999))).toHaveLength(0);
    expect(parseOmniHourly(row(2020, 5, 4, 99, -22))[0]?.dst).toBe(-22);
  });

  it('drops an hour with no Dst, whatever its Kp column says', () => {
    // Nothing this adapter measures, so nothing to store — and a missing row
    // already means exactly that. Keeping them would bloat the table to record
    // an absence.
    expect(parseOmniHourly(row(2020, 5, 5, 99, 99999))).toHaveLength(0);
    expect(parseOmniHourly(row(2020, 5, 5, 40, 99999))).toHaveLength(0);
  });

  it('never emits a value outside the plausible range', () => {
    const samples = parseOmniHourly(
      [row(2020, 1, 0, 90, -100), row(2020, 1, 1, 99, 99999), row(2020, 1, 2, 0, 5)].join('\n'),
    );
    expect(samples.every((s) => s.kp === null)).toBe(true);
    expect(samples.every((s) => s.dst === null || Math.abs(s.dst) < 5000)).toBe(true);
  });

  it('skips headers and short lines rather than throwing', () => {
    const text = ['# a comment', '', '1963 1 0', row(1963, 1, 0, 20, -10)].join('\n');
    expect(parseOmniHourly(text)).toHaveLength(1);
  });

  it('parses a whole file into one sample per hour', () => {
    const lines: string[] = [];
    for (let day = 1; day <= 3; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) lines.push(row(2021, day, hour, 20, -8));
    }
    expect(parseOmniHourly(lines.join('\n'))).toHaveLength(72);
  });
});

describe('hourFromDayOfYear', () => {
  it('treats day 1 as January 1', () => {
    expect(hourFromDayOfYear(2020, 1, 0)).toBe('2020-01-01T00:00:00.000Z');
  });

  it('rolls over leap years without a special case', () => {
    // 2020 is a leap year, so day 60 is 29 February; 2021's day 60 is 1 March.
    expect(hourFromDayOfYear(2020, 60, 0)).toBe('2020-02-29T00:00:00.000Z');
    expect(hourFromDayOfYear(2021, 60, 0)).toBe('2021-03-01T00:00:00.000Z');
  });

  it('handles the last hour of the year', () => {
    expect(hourFromDayOfYear(2021, 365, 23)).toBe('2021-12-31T23:00:00.000Z');
  });
});
