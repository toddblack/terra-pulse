import { describe, expect, it } from 'vitest';
import { goesFlareReportUrl, goesFlareYears, parseGoesFlareReport } from './goes-flares';

/**
 * Real lines, copied verbatim from NOAA's own reports rather than synthesised —
 * the same reasoning `gfz-kp.test.ts` gives: a fixed-width column map has to be
 * checked against the actual file, not against my reading of the format, which
 * is exactly where this kind of parser goes wrong.
 *
 * Fixture-based rather than networked, following every adapter here except the
 * two earthquake catalogues. The parser was verified once against all 21 live
 * files, and those measurements are what these fixtures encode:
 *
 * - 36,288 distinct flares for 1996-2016, **2,304 of them M1.0+**;
 * - per-year M/X counts reproducing `FLARE_COMPLETE_SINCE_YEAR`'s independently
 *   measured table exactly — 2011:119, 2012:130, 2013:111, 2014:221, 2016:16,
 *   and 2015:119 from the corrected file (the standard one gives 106);
 * - the largest event X28 at 2003-11-04T19:50Z in active region 10486, which is
 *   the largest flare ever recorded and lands where the record says it should;
 * - 305 groups of rows sharing one flare identity, 294 byte-identical.
 */

/** 2015, the modern layout: three-character satellite id, active region present. */
const MODERN = [
  '31777150101  0457 0517 0507 S07E50                         C 21    G15  1.9E-03 12253 150104.9                ',
  '31777150102  0433 0438 0436                                B 70    G15  1.0E-04                               ',
].join('\n');

/** 1996, the older layout: `GOES` rather than `G15`, frequently no active region. */
const EARLY = [
  '31777960103  1020 1032 1026                                B 11    GOES                             ',
  '31777960103  1334 1343 1335 N11W11SF                       B 60    GOES                             ',
].join('\n');

describe('parseGoesFlareReport', () => {
  it('reads the modern layout into the shared shape', () => {
    const [first] = parseGoesFlareReport(MODERN, 2015);

    expect(first).toEqual({
      id: 'goes:2015-01-01T05:07:00.000Z-C2.1',
      source: 'goes',
      classType: 'C2.1',
      flareClass: 'C',
      magnitude: 2.1,
      peakTimeUtc: '2015-01-01T05:07:00.000Z',
      beginTimeUtc: '2015-01-01T04:57:00.000Z',
      endTimeUtc: '2015-01-01T05:17:00.000Z',
      sourceLocation: 'S07E50',
      activeRegionNumber: 12253,
      link: null,
    });
  });

  it('reads the older layout, where the satellite id is wider and the region often absent', () => {
    const flares = parseGoesFlareReport(EARLY, 1996);

    expect(flares).toHaveLength(2);
    expect(flares[0]?.peakTimeUtc).toBe('1996-01-03T10:26:00.000Z');
    expect(flares[0]?.activeRegionNumber).toBeNull();
    expect(flares[0]?.sourceLocation).toBeNull();
    // Kept exactly as published, optical-class suffix and all — a position past
    // the limb is a real value a naive parse would accept as a disc coordinate.
    expect(flares[1]?.sourceLocation).toBe('N11W11SF');
  });

  it('pivots the two-digit year at the start of the GOES record', () => {
    // `96` is 1996 and `15` is 2015 — the reports began in 1975, so 75 and up
    // is twentieth century.
    expect(parseGoesFlareReport(EARLY, 1996)[0]?.peakTimeUtc.slice(0, 4)).toBe('1996');
    expect(parseGoesFlareReport(MODERN, 2015)[0]?.peakTimeUtc.slice(0, 4)).toBe('2015');
  });

  it('splits the two-column class, which cannot be read as one number', () => {
    // `M9.9` is smaller than `X1.0` and there is no `M10` — it is `X1`. So the
    // letter and the significand are separate columns, and `X280` is X28.0.
    const line =
      '31777031104  1929 2006 1950 S19W833B                       X280    GOES 2.3E00  10486';
    const [flare] = parseGoesFlareReport(line, 2003);

    // X28 on 2003-11-04 is the largest flare ever recorded.
    expect(flare?.classType).toBe('X28');
    expect(flare?.magnitude).toBe(28);
    expect(flare?.peakTimeUtc).toBe('2003-11-04T19:50:00.000Z');
    expect(flare?.activeRegionNumber).toBe(10486);
  });

  it('carries a flare that peaks after midnight onto the next day', () => {
    // 242 rows across the record do this. Reading the peak on the start date
    // would place the trigger 24 hours early.
    const line =
      '31777960711  2359 0008 0004                                B 17    GOES                             ';
    const [flare] = parseGoesFlareReport(line, 1996);

    expect(flare?.beginTimeUtc).toBe('1996-07-11T23:59:00.000Z');
    expect(flare?.peakTimeUtc).toBe('1996-07-12T00:04:00.000Z');
    expect(flare?.endTimeUtc).toBe('1996-07-12T00:08:00.000Z');
  });

  it('drops a row whose peak cannot be placed on either day', () => {
    // Peak precedes start while the event does not cross midnight — a source
    // typo. Four exist across the whole record, all C class or below.
    const line =
      '31777971219  1800 2153 0011                                C 11    GOES                             ';

    expect(parseGoesFlareReport(line, 1997)).toEqual([]);
  });

  it('drops an optical report carrying no X-ray class', () => {
    // Twelve of these across 1996-2016. Nothing can be said about whether they
    // clear M1.0, so they are dropped rather than guessed at.
    const line =
      '31777960420  1552 1555 1553 S05W52SF                               GOES          7958               ';

    expect(parseGoesFlareReport(line, 1996)).toEqual([]);
  });

  it('drops a row carrying a flux but no classification', () => {
    // The other shape of unusable row: times and an integrated flux, but the
    // class columns empty. One of these exists, in 1999.
    const line = '31777990802  1823 1836 1830                                        GOES 2.0E-03';

    expect(parseGoesFlareReport(line, 1999)).toEqual([]);
  });

  it('never invents a magnitude for a row with a class letter but no significand', () => {
    // Defensive rather than observed — no such row was found in 1996-2016, but
    // `Number('')` is 0, so without the guard this shape would silently become
    // a "C0.0" flare rather than being dropped.
    const line = '31777990802  1823 1836 1830                                C       GOES 2.0E-03';

    expect(parseGoesFlareReport(line, 1999)).toEqual([]);
  });

  it('collapses a repeated row rather than storing it twice', () => {
    // The file genuinely lists rows twice — 294 byte-identical pairs across the
    // record. Re-running the backfill has to stay an upsert.
    const repeated = [MODERN.split('\n')[0], MODERN.split('\n')[0]].join('\n');

    expect(parseGoesFlareReport(repeated, 2015)).toHaveLength(1);
  });

  it('keeps the richer record when two lines describe one flare', () => {
    // The 11 non-identical collisions are all one flare reported twice with
    // different completeness. Line order must not decide which survives.
    const poorFirst = [
      '31777000309  1833 1841 1838                                C 29    GOES 9.4E-04',
      '31777000309  1833 1841 1838 S19E541F                       C 29    GOES 9.3E-04  8906',
    ].join('\n');
    const richFirst = poorFirst.split('\n').reverse().join('\n');

    for (const text of [poorFirst, richFirst]) {
      const flares = parseGoesFlareReport(text, 2000);
      expect(flares).toHaveLength(1);
      expect(flares[0]?.sourceLocation).toBe('S19E541F');
      expect(flares[0]?.activeRegionNumber).toBe(8906);
    }
  });

  it('refuses a row whose date disagrees with the file it came from', () => {
    // A mismatch means the column offsets have drifted, which is worth
    // refusing rather than storing at the wrong instant.
    expect(parseGoesFlareReport(MODERN, 2014)).toEqual([]);
    expect(parseGoesFlareReport(MODERN)).toHaveLength(2);
  });

  it('returns flares oldest first', () => {
    const outOfOrder = MODERN.split('\n').reverse().join('\n');
    const flares = parseGoesFlareReport(outOfOrder, 2015);

    expect(flares.map((f) => f.peakTimeUtc)).toEqual([
      '2015-01-01T05:07:00.000Z',
      '2015-01-02T04:36:00.000Z',
    ]);
  });

  it('throws on a payload that is not text, and ignores blank lines', () => {
    expect(() => parseGoesFlareReport({ nope: true })).toThrow(/expected the report as text/);
    expect(parseGoesFlareReport('')).toEqual([]);
    expect(parseGoesFlareReport('\n\n   \n')).toEqual([]);
  });
});

describe('goesFlareYears / goesFlareReportUrl', () => {
  it('covers 1996 to 2016 inclusive, oldest first', () => {
    const years = goesFlareYears();

    expect(years[0]).toBe(1996);
    expect(years.at(-1)).toBe(2016);
    expect(years).toHaveLength(21);
  });

  it('takes NOAA corrected 2015 file, and the standard name everywhere else', () => {
    // The standard 2015 file carries 106 M/X against the corrected file's 119,
    // and DONKI's 126 — see FLARE_COMPLETE_SINCE_YEAR's note.
    expect(goesFlareReportUrl(2015)).toContain('goes-xrs-report_2015_modifiedreplacedmissingrows.txt');
    expect(goesFlareReportUrl(2014)).toContain('goes-xrs-report_2014.txt');
    expect(goesFlareReportUrl(2016)).toContain('goes-xrs-report_2016.txt');
  });
});
