import type { GnssDailyPosition, GnssStep, GnssVelocity } from '@terra-pulse/schema';

/**
 * The Nevada Geodetic Laboratory's GPS products, read as published.
 *
 * Four plain-text sources, all keyless over HTTPS and checked live with Node's
 * `fetch` on 2026-10-15 (plain `http://` drops the connection):
 *
 * - **The station list** (`DataHoldings.txt`, 2.8 MB): 23,826 stations with
 *   position and the first and last day of each record.
 * - **One station's daily positions** (`<STA>.tenv3`, ~1.5 MB for twenty
 *   years): one line per day, east/north/up in metres. In the IGS20 frame; the
 *   older `tenv3/IGS14/` path answers 404.
 * - **Every station's steady velocity** (`midas.IGS14.txt`, 5 MB): the MIDAS
 *   trend. There is no IGS20 velocity file yet. The two frames' velocities
 *   differ by well under a millimetre a year, which over the longest span the
 *   window offers is a fraction of a millimetre.
 * - **One station's page** (~20 KB of HTML): the original data's DOI and the
 *   lab's table of known steps — equipment changes and nearby quakes. The
 *   master step file holds the same rows for every station at 7.4 MB, so the
 *   page is read instead.
 *
 * Terms: supplied as-is; the lab asks that Blewitt, Hammond & Kreemer (2018)
 * be cited along with each station's own data DOI. See `SOURCES.md`.
 */
const BASE = 'https://geodesy.unr.edu';
export const NGL_STATION_LIST_URL = `${BASE}/NGLStationPages/DataHoldings.txt`;
export const NGL_MIDAS_URL = `${BASE}/velocities/midas.IGS14.txt`;
export const nglSeriesUrl = (station: string) =>
  `${BASE}/gps_timeseries/IGS20/tenv3/IGS20/${station}.tenv3`;
export const nglStationPageUrl = (station: string) =>
  `${BASE}/NGLStationPages/stations/${station}.sta`;

/**
 * A station id as the lab writes them: four capitals, digits or underscores.
 *
 * Checked before an id goes into a URL. The underscore is not a guess: 18 of
 * the 23,826 ids in the live list carry one (`MN__`, `HN_0`), and a pattern
 * without it dropped them. Every id matches this one.
 */
export const NGL_STATION_ID = /^[A-Z0-9_]{4}$/;

const DAY_MS = 86_400_000;

/** Modified Julian Day 40587 is 1970-01-01. */
const MJD_UNIX_EPOCH = 40587;

export interface NglStationRecord {
  station: string;
  latitude: number;
  /** −180 to 180. The file writes some longitudes 0-360. */
  longitude: number;
  /** Midnight UTC of the first day in the record. */
  beginMs: number;
  /** Midnight UTC of the last day in the record. */
  endMs: number;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * The lab's `YYMMMDD` date (`19JUL06`) as midnight UTC, or null.
 *
 * Two-digit years pivot at 80: GPS records start in the 1990s, so `95` is 1995
 * and `26` is 2026. The station pages use this form; the station list uses ISO
 * dates and the series carry MJD, so it is only needed for steps.
 */
export function parseNglDate(text: string): number | null {
  const match = /^(\d{2})([A-Z]{3})(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const month = MONTHS.indexOf(match[2] ?? '');
  if (month < 0) return null;
  const yy = Number(match[1]);
  const year = yy >= 80 ? 1900 + yy : 2000 + yy;
  const day = Number(match[3]);
  const ms = Date.UTC(year, month, day);
  // Date.UTC rolls `31FEB` into March rather than refusing it.
  return new Date(ms).getUTCDate() === day ? ms : null;
}

/**
 * The station list.
 *
 * Columns: id, latitude, longitude, height, X, Y, Z, first day, last day,
 * last processed, solution count, original name. A row whose numbers or dates
 * do not read is dropped, never coerced — a station placed at 0,0 would be
 * "nearest" to quakes in the Gulf of Guinea.
 */
export function parseNglStationList(text: string): NglStationRecord[] {
  const stations: NglStationRecord[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const station = fields[0] ?? '';
    if (!NGL_STATION_ID.test(station)) continue; // the header row, or noise
    const latitude = Number(fields[1]);
    let longitude = Number(fields[2]);
    const beginMs = Date.parse(`${fields[7] ?? ''}T00:00:00Z`);
    const endMs = Date.parse(`${fields[8] ?? ''}T00:00:00Z`);
    if (![latitude, longitude, beginMs, endMs].every(Number.isFinite)) continue;
    if (Math.abs(latitude) > 90) continue;
    if (longitude > 180) longitude -= 360;
    if (longitude < -180) longitude += 360;
    stations.push({ station, latitude, longitude, beginMs, endMs });
  }
  return stations;
}

/**
 * One station's daily positions, oldest first.
 *
 * The `tenv3` columns used: 3 MJD, 7-8 east (integer metres, then the
 * remainder), 9-10 north, 11-12 up. The integer part is split off to keep
 * precision in the file's fixed-width text; the sum is the position.
 *
 * Days come from the MJD, not the decimal year, which is rounded.
 */
export function parseNglTenv3(text: string): GnssDailyPosition[] {
  const positions: GnssDailyPosition[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 13 || !NGL_STATION_ID.test(fields[0] ?? '')) continue;
    const mjd = Number(fields[3]);
    const eastM = Number(fields[7]) + Number(fields[8]);
    const northM = Number(fields[9]) + Number(fields[10]);
    const upM = Number(fields[11]) + Number(fields[12]);
    if (![mjd, eastM, northM, upM].every(Number.isFinite) || !Number.isInteger(mjd)) continue;
    positions.push({ dayMs: (mjd - MJD_UNIX_EPOCH) * DAY_MS, eastM, northM, upM });
  }
  // The file is in order already; sorted anyway because everything downstream
  // slices by time and an out-of-order line would be silently mis-sliced.
  positions.sort((a, b) => a.dayMs - b.dayMs);
  return positions;
}

/**
 * Every station's MIDAS velocity, metres per year, keyed by station id.
 *
 * Columns 9-11 (1-based) are the east, north and up velocities, per the lab's
 * `midas.readme.txt`.
 */
export function parseMidasVelocities(text: string): Map<string, GnssVelocity> {
  const velocities = new Map<string, GnssVelocity>();
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const station = fields[0] ?? '';
    if (!NGL_STATION_ID.test(station) || fields.length < 11) continue;
    const eastMPerYr = Number(fields[8]);
    const northMPerYr = Number(fields[9]);
    const upMPerYr = Number(fields[10]);
    if (![eastMPerYr, northMPerYr, upMPerYr].every(Number.isFinite)) continue;
    velocities.set(station, { eastMPerYr, northMPerYr, upMPerYr });
  }
  return velocities;
}

export interface NglStationPage {
  doi: string | null;
  steps: GnssStep[];
}

/**
 * The DOI and the steps table off a station's page.
 *
 * HTML, so this reads only the two things it needs by pattern: the first
 * `doi.org` link, and rows of the steps table, which have the station's id in
 * their first cell. A row that does not read is skipped. A page with no table
 * gives no steps, which is a station with nothing known — the caller treats a
 * page that could not be *fetched* differently.
 */
export function parseNglStationPage(html: string, station: string): NglStationPage {
  const doiMatch = /https:\/\/doi\.org\/[^"'<\s]+/.exec(html);
  const doi = doiMatch ? doiMatch[0] : null;

  const steps: GnssStep[] = [];
  const row =
    /<tr>\s*<td>\s*([A-Z0-9_]{4})\s*<\/td>\s*<td>\s*(\d{2}[A-Z]{3}\d{2})\s*<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>/g;
  for (const match of html.matchAll(row)) {
    if (match[1] !== station) continue;
    const dayMs = parseNglDate(match[2] ?? '');
    if (dayMs === null) continue;
    const detail = (match[3] ?? '').replace(/<[^>]*>/g, '').trim();
    if (detail === '') continue;
    const magnitude = Number((match[4] ?? '').trim());
    const distanceKm = Number((match[5] ?? '').trim());
    const isQuake = Number.isFinite(magnitude) && (match[4] ?? '').trim() !== '-';
    steps.push({
      dayMs,
      kind: isQuake ? 'earthquake' : 'equipment',
      detail,
      magnitude: isQuake ? magnitude : null,
      distanceKm: isQuake && Number.isFinite(distanceKm) ? distanceKm : null,
    });
  }
  steps.sort((a, b) => a.dayMs - b.dayMs);
  return { doi, steps };
}

async function fetchText(url: string, what: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`${what}: HTTP ${String(response.status)} ${response.statusText}`);
  }
  return response.text();
}

export async function fetchNglStationList(fetchImpl: typeof fetch = fetch): Promise<NglStationRecord[]> {
  return parseNglStationList(await fetchText(NGL_STATION_LIST_URL, 'NGL station list', fetchImpl));
}

export async function fetchMidasVelocities(
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, GnssVelocity>> {
  return parseMidasVelocities(await fetchText(NGL_MIDAS_URL, 'NGL MIDAS velocities', fetchImpl));
}

/**
 * One station's whole record. Null on a 404: the station list can name a
 * station whose series has been withdrawn, and that is a missing station, not
 * a failed service.
 */
export async function fetchNglSeries(
  station: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GnssDailyPosition[] | null> {
  if (!NGL_STATION_ID.test(station)) throw new Error(`Not a station id: ${station}`);
  const response = await fetchImpl(nglSeriesUrl(station));
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`NGL series ${station}: HTTP ${String(response.status)} ${response.statusText}`);
  }
  return parseNglTenv3(await response.text());
}

export async function fetchNglStationPage(
  station: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NglStationPage> {
  if (!NGL_STATION_ID.test(station)) throw new Error(`Not a station id: ${station}`);
  return parseNglStationPage(
    await fetchText(nglStationPageUrl(station), `NGL station page ${station}`, fetchImpl),
    station,
  );
}
