import { describe, expect, it } from 'vitest';
import {
  gcmtCombinedCandidates,
  gcmtCombinedUrl,
  gcmtMonthlyUrl,
  parseNdk,
  parseNdkWithSkips,
} from './gcmt-mechanisms';

/**
 * Real blocks from `jan76_dec25.ndk`, chosen because each one breaks a
 * different naive parse. Copied verbatim — the whole point of a fixed-width
 * format is that the spacing is the data.
 */
const TOHOKU = [
  'PDE  2011/03/11 05:46:23.0  38.32  142.37  24.4 7.9 7.9 NEAR EAST COAST OF HONSH',
  'M201103110546A   B:  0    0   0 S:  0    0   0 M:100  271 300 CMT: 1 TRIHD: 70.0',
  'CENTROID:     69.8 0.2  37.52 0.01  143.05 0.02  20.0  0.0 FIX  S-20110311234057',
  '29  1.730 0.006 -0.281 0.005 -1.450 0.005  2.120 0.068  4.550 0.065 -0.657 0.004',
  'V10   5.305 55 295   0.014  0 205  -5.319 35 115   5.312 203 10   88  25 80   90',
].join('\n');

/** Seconds published as `60.0`, meaning the next minute. */
const ROLLOVER = [
  'PDE  1998/09/27 00:57:60.0  61.57 -149.66  34.8 5.0 4.2 SOUTHERN ALASKA         ',
  'B092798A         B: 23   32  45 S:  0    0   0 M:  0    0   0 CMT: 1 BOXHD:  1.0',
  'CENTROID:      1.7 0.6  61.60 0.11 -150.08 0.11  64.1  9.7 FREE O-00000000000000',
  '23 -1.635 0.305 -0.425 0.513  2.060 0.317  2.167 0.366  1.830 0.316  0.551 0.383',
  'V10   3.360 28 297   0.170 20  38  -3.530 55 158   3.450 347 24 -144 223 76  -70',
].join('\n');

/** Centroid time shift and its error run together: `1.060.0`. */
const COLLIDING_CENTROID = [
  'PDE  1996/11/20 19:42:56.1  10.30  127.43  33.0 5.6 5.3 PHILIPPINE ISLANDS REGIO',
  'B112096E         B: 35   58  45 S:  0    0   0 M:  0    0   0 CMT: 1 BOXHD: 22.0',
  'CENTROID:      1.060.0  10.47 0.03  127.42 0.03  15.0  0.0 BDY  O-00000000000000',
  '24 -4.983 0.133 -0.092 0.153  5.075 0.173 -0.433 0.443  0.715 0.469 -2.898 0.141',
  'V10   6.430  4 246  -1.390  2 156  -5.050 86  45   5.740 338 41  -88 154 49  -92',
].join('\n');

describe('parseNdk', () => {
  it('reads a solution into the shared shape', () => {
    const [event] = parseNdk(TOHOKU);
    expect(event).toBeDefined();
    expect(event!.id).toBe('M201103110546A');
    // Line 1's hypocentre, which is what H6 registers and what the join to this
    // app's own catalogue matches against.
    expect(event!.timeUtc).toBe('2011-03-11T05:46:23.000Z');
    expect(event!.latitude).toBeCloseTo(38.32, 5);
    expect(event!.longitude).toBeCloseTo(142.37, 5);
    expect(event!.depthKm).toBeCloseTo(24.4, 5);
    expect(event!.referenceCatalog).toBe('PDE');
  });

  it('computes Mw from the scalar moment in dyne-cm', () => {
    // 5.312e29 dyne-cm, giving Mw 9.08 against GCMT's published 9.1.
    //
    // Two ways to get this wrong, both of which return a believable number.
    // The scalar moment sits at columns 50-56, *after* the three eigenvalues —
    // taking the first eigenvalue instead reads 5.305e29 and lands within 0.001
    // of the right magnitude, so it cannot be caught by eye. And the N-m form
    // of Kanamori's relation would give 7.88, a plausible magnitude for the
    // largest Japanese earthquake on record.
    const [event] = parseNdk(TOHOKU);
    expect(event!.scalarMomentDyneCm).toBeCloseTo(5.312e29, -26);
    expect(event!.magnitude).toBeCloseTo(9.08, 2);
  });

  it('keeps both nodal planes exactly as published', () => {
    const [event] = parseNdk(TOHOKU);
    expect(event!.nodalPlane1).toEqual({ strike: 203, dip: 10, rake: 88 });
    expect(event!.nodalPlane2).toEqual({ strike: 25, dip: 80, rake: 90 });
  });

  it('rolls a :60.0 seconds field into the next minute rather than dropping it', () => {
    // 44 records across the catalogue publish seconds as 60.0. `Date.parse`
    // rejects them outright, so a parser that trusts it loses real events —
    // silently, because there is no error to notice.
    const [event] = parseNdk(ROLLOVER);
    expect(event).toBeDefined();
    expect(event!.timeUtc).toBe('1998-09-27T00:58:00.000Z');
  });

  it('reads the centroid by column when its fields run together', () => {
    // `1.060.0` is a time shift of 1.0 with a standard error of 60.0 s and no
    // space between them. Splitting on whitespace shifts every later field
    // left, so latitude reads the latitude *error* and the event lands at
    // (0.03, 0.03) — in the Gulf of Guinea, 14,000 km from the Philippines.
    const [event] = parseNdk(COLLIDING_CENTROID);
    expect(event!.centroidLatitude).toBeCloseTo(10.47, 5);
    expect(event!.centroidLongitude).toBeCloseTo(127.42, 5);
    expect(event!.centroidDepthKm).toBeCloseTo(15, 5);
    // And the centroid must land near its own hypocentre, which is the check
    // that caught this in the first place.
    expect(Math.abs(event!.centroidLatitude - event!.latitude)).toBeLessThan(1);
    expect(Math.abs(event!.centroidLongitude - event!.longitude)).toBeLessThan(1);
  });

  it('returns events oldest first regardless of file order', () => {
    const events = parseNdk([TOHOKU, ROLLOVER, COLLIDING_CENTROID].join('\n'));
    expect(events.map((e) => e.id)).toEqual(['B112096E', 'B092798A', 'M201103110546A']);
  });

  it('skips a block whose nodal planes are out of range instead of storing it', () => {
    // A dip of 130 degrees means the columns have drifted. Storing it would put
    // a nonsense fault orientation into a stress calculation, which produces a
    // plausible number rather than an error.
    const corrupt = COLLIDING_CENTROID.split('\n');
    corrupt[4] = corrupt[4]!.replace('338 41  -88', '338 130 -88');
    const { mechanisms, skipped } = parseNdkWithSkips(corrupt.join('\n'));
    expect(mechanisms).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('refuses a non-string payload rather than parsing undefined', () => {
    expect(() => parseNdk({ events: [] })).toThrow(/expected the catalogue as text/);
  });

  it('ignores trailing blank lines', () => {
    expect(parseNdk(`${TOHOKU}\n\n\n`)).toHaveLength(1);
  });
});

describe('catalogue URLs', () => {
  it('derives the combined-file name from the clock, newest first', () => {
    // The name carries the last complete year it contains, so it changes every
    // January. Hard-coding one fails silently — the old file keeps being served,
    // so the catalogue just stops gaining years.
    const candidates = gcmtCombinedCandidates(new Date('2026-08-21T00:00:00Z'));
    expect(candidates[0]).toBe('jan76_dec25');
    expect(candidates).toEqual(['jan76_dec25', 'jan76_dec24', 'jan76_dec23']);
  });

  it('rolls the candidate name over at the turn of the year', () => {
    expect(gcmtCombinedCandidates(new Date('2027-01-02T00:00:00Z'))[0]).toBe('jan76_dec26');
  });

  it('pads the two-digit year past 2100', () => {
    // `jan76_dec01`, not `jan76_dec1`. Worth pinning because the padding is
    // invisible for every year this decade.
    expect(gcmtCombinedCandidates(new Date('2102-05-01T00:00:00Z'))[0]).toBe('jan76_dec01');
  });

  it('builds the combined and monthly URLs', () => {
    expect(gcmtCombinedUrl('jan76_dec25')).toBe(
      'https://www.ldeo.columbia.edu/~gcmt/projects/CMT/catalog/jan76_dec25.ndk.gz',
    );
    expect(gcmtMonthlyUrl(2026, 1)).toBe(
      'https://www.ldeo.columbia.edu/~gcmt/projects/CMT/catalog/NEW_MONTHLY/2026/jan26.ndk',
    );
    expect(gcmtMonthlyUrl(2026, 12)).toContain('dec26.ndk');
  });

  it('refuses a month outside 1-12', () => {
    expect(() => gcmtMonthlyUrl(2026, 13)).toThrow(/no month/);
  });
});
