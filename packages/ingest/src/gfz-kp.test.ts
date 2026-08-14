import { describe, expect, it } from 'vitest';
import { parseGfzKp } from './gfz-kp';

/**
 * Real lines, copied verbatim from GFZ's own files rather than synthesised.
 *
 * The OMNI test builds its rows in code because OMNI's row is 55 mostly
 * irrelevant fields wide. GFZ's is 28 and readable, and copying the real thing
 * means the column map is checked against the actual file rather than against
 * my reading of the format description — which is exactly where a fixed-width
 * parser goes wrong.
 */
const HEADER = [
  '# PURPOSE: This file distributes the geomagnetic planetary three-hour index Kp',
  '#YYY MM DD  days  days_m  Bsr dB    Kp1    Kp2    Kp3    Kp4    Kp5    Kp6    Kp7    Kp8  ap1  ap2  ap3  ap4  ap5  ap6  ap7  ap8    Ap  SN F10.7obs F10.7adj D',
].join('\n');

/** The first day of the record. */
const FIRST_DAY =
  '1932 01 01     0     0.5 1352 10  3.333  2.667  2.333  2.667  3.333  2.667  3.333  3.333   18   12    9   12   18   12   18   18    15  22     -1.0     -1.0 2';

/** The March 1989 Quebec storm — the same ground truth OMNI was checked on. */
const QUEBEC_13 =
  '1989 03 13 20891 20891.5 2126  3  6.000  7.667  8.667  8.333  8.333  8.333  8.667  9.000   80  179  300  236  236  236  300  400   246 210    256.0    253.0 2';
const QUEBEC_14 =
  '1989 03 14 20892 20892.5 2126  4  9.000  7.667  7.667  5.667  5.000  5.333  7.667  7.333  400  179  179   67   48   56  179  154   158 235    266.7    263.8 2';

/** A partial day from the nowcast file: the final interval hasn't happened. */
const TODAY_SO_FAR =
  '2026 08 14 34559 34559.5 2632  9  2.667  2.333  2.667  2.333  2.000  1.333  1.333 -1.000   12    9   12    9    7    5    5   -1    -1 108     -1.0     -1.0 0';

describe('parseGfzKp', () => {
  it('reads Kp in exact thirds, not OMNI2 tenths', () => {
    const samples = parseGfzKp(`${HEADER}\n${FIRST_DAY}`);

    // GFZ publishes 3.333 for "3+". OMNI writes the same value as the integer
    // 33, which divides to 3.3. This is the publisher, so thirds are kept.
    expect(samples[0]?.kp).toBe(3.333);
    expect(samples[0]?.timeUtc).toBe('1932-01-01T00:00:00.000Z');
  });

  it('keeps integer Kp exact, which is what every threshold sits on', () => {
    // The two conventions disagree by at most 0.033 and agree exactly on the
    // integers. KP_STORM_THRESHOLD is 5 and H4's registered trigger is 6, so a
    // database still holding OMNI-era rows is imprecise but never misclassified.
    const kp = parseGfzKp(QUEBEC_13).map((sample) => sample.kp);
    expect(kp).toContain(9);
    expect(kp).toContain(6);
    expect(kp.every((value) => value !== null && value >= 0 && value <= 9)).toBe(true);
  });

  it('expands each three-hour interval into its three hours', () => {
    const samples = parseGfzKp(FIRST_DAY);

    // Eight intervals x three hours. Dst is hourly, so the table is keyed by the
    // hour; writing only interval starts would leave two hours in three empty
    // and make an unbroken record look full of gaps.
    expect(samples).toHaveLength(24);
    expect(samples.at(-1)?.timeUtc).toBe('1932-01-01T23:00:00.000Z');

    // All three hours of the first interval carry that interval's value.
    expect(samples.slice(0, 3).map((s) => s.kp)).toEqual([3.333, 3.333, 3.333]);
    expect(samples[3]?.kp).toBe(2.667);
  });

  it('places the Quebec storm where the documented values put it', () => {
    const byTime = new Map(
      parseGfzKp(`${QUEBEC_13}\n${QUEBEC_14}`).map((s) => [s.timeUtc, s.kp]),
    );

    // Kp 9 on the evening of the 13th (the eighth interval, 21-24 UT) running
    // straight into Kp 9 on the first interval of the 14th — alongside which
    // OMNI records Dst -589 nT at 01:00.
    expect(byTime.get('1989-03-13T21:00:00.000Z')).toBe(9);
    expect(byTime.get('1989-03-14T00:00:00.000Z')).toBe(9);
    expect(byTime.get('1989-03-14T02:00:00.000Z')).toBe(9);
    // And back down by the fourth interval, so this isn't matching everything.
    expect(byTime.get('1989-03-14T09:00:00.000Z')).toBe(5.667);
  });

  it('drops an undetermined interval instead of storing -1', () => {
    const samples = parseGfzKp(TODAY_SO_FAR);

    // Seven intervals determined, one not: 21 hours, not 24. Read as data, -1
    // would be a Kp below the bottom of the scale — and unlike OMNI's 99, it
    // would at least be obvious. It is still not a measurement.
    expect(samples).toHaveLength(21);
    expect(samples.every((sample) => sample.kp !== null && sample.kp >= 0)).toBe(true);
    expect(samples.at(-1)?.timeUtc).toBe('2026-08-14T20:00:00.000Z');
  });

  it('never invents a Dst', () => {
    // GFZ publishes Kp, ap, sunspot number and F10.7 — no Dst. That comes from
    // Kyoto via OMNI, and a null here is what lets COALESCE keep it.
    expect(parseGfzKp(QUEBEC_14).every((sample) => sample.dst === null)).toBe(true);
  });

  it('skips the preamble, blank lines and anything not 28 fields wide', () => {
    const text = [HEADER, '', '1932 01 01 truncated row', FIRST_DAY].join('\n');
    expect(parseGfzKp(text)).toHaveLength(24);
  });

  it('handles month and year rollover through UTC rather than day arithmetic', () => {
    // Day-of-month plus hour, via Date.UTC — so December 31 rolls into January
    // without the file needing an ordinal day, and leap years need no case.
    const newYearsEve = FIRST_DAY.replace('1932 01 01', '1932 12 31');
    expect(parseGfzKp(newYearsEve).at(-1)?.timeUtc).toBe('1932-12-31T23:00:00.000Z');

    const leapDay = FIRST_DAY.replace('1932 01 01', '2024 02 29');
    expect(parseGfzKp(leapDay)[0]?.timeUtc).toBe('2024-02-29T00:00:00.000Z');
  });
});
