import { describe, expect, it } from 'vitest';
import {
  NGL_STATION_ID,
  fetchNglSeries,
  fetchNglStationPage,
  parseMidasVelocities,
  parseNglDate,
  parseNglStationList,
  parseNglStationPage,
  parseNglTenv3,
} from './ngl-gnss';

/**
 * Fixture-based, not live, like the other adapters: the parsers were run
 * against the real files once (2026-10-15) and a network test would make the
 * suite non-deterministic. Every line below is copied from the lab's own
 * files, including their spacing.
 */

const STATION_LIST = `Sta  Lat(deg)   Long(deg) Hgt(m)  X(m)           Y(m)         Z(m)          Dtbeg      Dtend      Dtmod      NumSol StaOrigName
P595  35.6976   242.5972  644.437 -2386904.4870 -4604247.9134  3701367.0753 2005-10-22 2026-10-03 2026-10-12   7624
MN__  47.9181   106.9509 1285.664 -1248821.2564  4097255.5756  4711728.6259 2016-07-30 2021-02-06 2025-09-28   1290
00NA -12.4666   130.8440  104.851 -4073662.2759  4712064.7454 -1367874.5096 2008-03-27 2018-09-25 2025-09-25   3185
`;

// Ridgecrest: the M6.4 was 2019-07-04 17:33 UTC, the M7.1 2019-07-06 03:19.
const TENV3 = `site YYMMMDD yyyy.yyyy __MJD week d reflon _e0(m) __east(m) ____n0(m) _north(m) u0(m) ____up(m) _ant(m) sig_e(m) sig_n(m) sig_u(m) __corr_en __corr_eu __corr_nu _latitude(deg) _longitude(deg) __height(m)
P595 19JUL03 2019.5017 58667 2060 3 -117.4   -256 -0.864433   3951985  0.009837   644  0.417598  0.0083 0.000680 0.000800 0.002698 -0.008319  0.026693 -0.089933  35.6975593951 -117.4028380710   644.41760
P595 19JUL04 2019.5044 58668 2060 4 -117.4   -256 -0.856548   3951985  0.010214   644  0.415929  0.0083 0.000697 0.000826 0.002799 -0.023148  0.029191 -0.105496  35.6975593985 -117.4028379839   644.41593
P595 19JUL05 2019.5072 58669 2060 5 -117.4   -256 -0.756423   3951985  0.014325   644  0.436150  0.0083 0.000672 0.000791 0.002659 -0.007807 -0.008890 -0.106149  35.6975594356 -117.4028368776   644.43615
P595 19JUL06 2019.5099 58670 2060 6 -117.4   -256 -0.242908   3951985 -0.237781   644  0.474351  0.0083 0.000715 0.000834 0.002817  0.017991 -0.038244 -0.054452  35.6975571634 -117.4028312038   644.47435
P595 19JUL07 2019.5127 58671 2061 0 -117.4   -256 -0.240248   3951985 -0.240171   644  0.472857  0.0083 0.000679 0.000806 0.002719 -0.023640 -0.005343 -0.110868  35.6975571419 -117.4028311744   644.47286
`;

const MIDAS = `P595 MIDAS5 2005.8070 2024.7420 18.9350  6908  6515  10844  -0.018814  -0.002481  -0.000707  0.000163 0.000142 0.000401   -256.6010   3951985.0373  644.4279 0.079 0.053 0.056 0.002166 0.001911 0.005390   7  35.6975594464 -117.4028361565   644.42365
`;

const STATION_PAGE = `<h2>DOI link for this station: <a href="https://doi.org/10.7283/T5C24TDR" target="_blank"><u>https://doi.org/10.7283/T5C24TDR</u></a></h2>
<table style="text-align:center" cellpadding="5">
<tr> <th>Station ID</th> <th>Date<br>(YYMMMDD)</th> <th>Equipment Change Type/<br>or Event ID</th> <th>Earthquake<br>Magnitude</th> <th>Distance<br>(km)</th> </tr>
<tr><td>P595</td><td>25MAR19</td> <td>Antenna_Type_Changed</td> <td>-</td> <td>-</td> </tr>
<tr><td>P595</td><td>25MAR19</td> <td>Receiver_Make_and_Model_Changed</td> <td>-</td> <td>-</td> </tr>
<tr><td>P595</td><td>19JUL06</td> <td><a href="https://earthquake.usgs.gov/earthquakes/eventpage/ci38457511">ci38457511</a></td> <td>7.1</td> <td>19.5</td></tr>
</table>`;

const DAY = 86_400_000;

function response(body: string, status = 200): Response {
  return new Response(body, { status, statusText: status === 200 ? 'OK' : 'Not Found' });
}

describe('parseNglDate', () => {
  it("reads the lab's YYMMMDD as midnight UTC", () => {
    expect(parseNglDate('19JUL06')).toBe(Date.UTC(2019, 6, 6));
  });

  it('pivots two-digit years at 80, since GPS records start in the 1990s', () => {
    expect(parseNglDate('95JAN01')).toBe(Date.UTC(1995, 0, 1));
    expect(parseNglDate('26OCT03')).toBe(Date.UTC(2026, 9, 3));
  });

  it('refuses a day the month does not have, rather than rolling it over', () => {
    expect(parseNglDate('19FEB31')).toBeNull();
    expect(parseNglDate('19FOO01')).toBeNull();
    expect(parseNglDate('-')).toBeNull();
  });
});

describe('parseNglStationList', () => {
  const stations = parseNglStationList(STATION_LIST);

  it('skips the header and reads every station', () => {
    expect(stations.map((s) => s.station)).toEqual(['P595', 'MN__', '00NA']);
  });

  it('keeps ids with underscores — 18 of the real list have one', () => {
    expect(NGL_STATION_ID.test('MN__')).toBe(true);
    expect(stations.some((s) => s.station === 'MN__')).toBe(true);
  });

  it('wraps a 0-360 longitude into −180..180', () => {
    // Read as written, P595 would sit in the middle of Asia's longitudes.
    expect(stations[0]?.longitude).toBeCloseTo(-117.4028, 4);
  });

  it("reads the record's first and last day", () => {
    expect(stations[0]?.beginMs).toBe(Date.UTC(2005, 9, 22));
    expect(stations[0]?.endMs).toBe(Date.UTC(2026, 9, 3));
  });

  it('drops a row whose numbers do not read rather than placing it at 0,0', () => {
    const bad = 'XXXX  nan  12.0 1 1 1 1 2005-01-01 2026-01-01 2026-01-01 10\n';
    expect(parseNglStationList(bad)).toEqual([]);
  });
});

describe('parseNglTenv3', () => {
  const positions = parseNglTenv3(TENV3);

  it('reads one position per day, dated from the MJD', () => {
    expect(positions).toHaveLength(5);
    expect(positions[0]?.dayMs).toBe(Date.UTC(2019, 6, 3));
    expect(positions[4]?.dayMs).toBe(Date.UTC(2019, 6, 7));
  });

  it('adds the integer metres back onto the remainder', () => {
    expect(positions[0]?.eastM).toBeCloseTo(-256.864433, 6);
    expect(positions[0]?.northM).toBeCloseTo(3951985.009837, 6);
    expect(positions[0]?.upM).toBeCloseTo(644.417598, 6);
  });

  it('shows Ridgecrest: ~0.6 m east and ~0.25 m south across the M7.1', () => {
    // The check that the columns are the right ones — a parser reading the
    // sigma columns instead would produce millimetres of nothing.
    const before = positions[1];
    const after = positions[4];
    expect(after && before && (after.eastM - before.eastM) * 1000).toBeCloseTo(616.3, 0);
    expect(after && before && (after.northM - before.northM) * 1000).toBeCloseTo(-250.4, 0);
  });

  it('sorts lines that arrive out of order', () => {
    const lines = TENV3.trim().split('\n');
    const shuffled = [lines[0], lines[3], lines[1], lines[5], lines[2], lines[4]].join('\n');
    expect(parseNglTenv3(shuffled).map((p) => p.dayMs)).toEqual(positions.map((p) => p.dayMs));
  });

  it('spaces days exactly one day apart', () => {
    for (let i = 1; i < positions.length; i += 1) {
      expect((positions[i]?.dayMs ?? 0) - (positions[i - 1]?.dayMs ?? 0)).toBe(DAY);
    }
  });
});

describe('parseMidasVelocities', () => {
  it('reads east, north and up in metres per year from columns 9-11', () => {
    expect(parseMidasVelocities(MIDAS).get('P595')).toEqual({
      eastMPerYr: -0.018814,
      northMPerYr: -0.002481,
      upMPerYr: -0.000707,
    });
  });
});

describe('parseNglStationPage', () => {
  const page = parseNglStationPage(STATION_PAGE, 'P595');

  it('finds the data DOI', () => {
    expect(page.doi).toBe('https://doi.org/10.7283/T5C24TDR');
  });

  it('tells equipment changes from quakes, oldest first', () => {
    // `25MAR19` is 2025 March 19 — year first. Read day-first it would put
    // this antenna change three months before Ridgecrest, which is exactly
    // the kind of coincidence the window is there to rule out.
    expect(page.steps).toEqual([
      { dayMs: Date.UTC(2019, 6, 6), kind: 'earthquake', detail: 'ci38457511', magnitude: 7.1, distanceKm: 19.5 },
      { dayMs: Date.UTC(2025, 2, 19), kind: 'equipment', detail: 'Antenna_Type_Changed', magnitude: null, distanceKm: null },
      { dayMs: Date.UTC(2025, 2, 19), kind: 'equipment', detail: 'Receiver_Make_and_Model_Changed', magnitude: null, distanceKm: null },
    ]);
  });

  it("ignores another station's rows", () => {
    expect(parseNglStationPage(STATION_PAGE, 'P580').steps).toEqual([]);
  });

  it('gives no DOI and no steps for a page without them', () => {
    expect(parseNglStationPage('<html></html>', 'P595')).toEqual({ doi: null, steps: [] });
  });
});

describe('fetching', () => {
  it('asks for the IGS20 series and parses it', async () => {
    const urls: string[] = [];
    const fake = ((url: string) => {
      urls.push(url);
      return Promise.resolve(response(TENV3));
    }) as unknown as typeof fetch;
    const positions = await fetchNglSeries('P595', fake);
    expect(urls).toEqual(['https://geodesy.unr.edu/gps_timeseries/IGS20/tenv3/IGS20/P595.tenv3']);
    expect(positions).toHaveLength(5);
  });

  it('treats a 404 as a missing station, not a failed service', async () => {
    const fake = (() => Promise.resolve(response('', 404))) as unknown as typeof fetch;
    await expect(fetchNglSeries('P595', fake)).resolves.toBeNull();
  });

  it('throws on any other failure, so "no station" and "unreachable" stay apart', async () => {
    const fake = (() => Promise.resolve(new Response('', { status: 503 }))) as unknown as typeof fetch;
    await expect(fetchNglSeries('P595', fake)).rejects.toThrow(/503/);
  });

  it('refuses an id that is not one before it reaches a URL', async () => {
    const fake = (() => Promise.reject(new Error('should not fetch'))) as unknown as typeof fetch;
    await expect(fetchNglSeries('../x', fake)).rejects.toThrow(/Not a station id/);
    await expect(fetchNglStationPage('P5/95', fake)).rejects.toThrow(/Not a station id/);
  });
});
