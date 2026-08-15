import type { SpaceWeatherSample } from '@terra-pulse/schema';

/**
 * The live tail for solar wind speed and IMF Bz — SWPC's propagated real-time
 * stream, seven days at one-minute cadence.
 *
 * OMNI is the historical source but lags by weeks to months, so without this the
 * wind series would stop somewhere short of today. Between them: OMNI from 1963,
 * this for the last week.
 *
 * ## Why the *propagated* product and not the raw L1 stream
 *
 * SWPC publishes both. `json/rtsw/rtsw_wind_1m.json` is the raw measurement at
 * the spacecraft, 1.5 million km upstream; this one is that measurement
 * time-shifted to the **bow shock nose**.
 *
 * OMNI is shifted to the bow shock nose too — that is a defining property of the
 * dataset, not an incidental one. Filling the recent gap with the raw stream
 * would mean the same column held measurements referenced to two different
 * places, changing meaning partway along the series with nothing to mark the
 * seam. Exactly the trap that keeps SWPC's modelled Dst and NOAA's estimated Kp
 * out of this app.
 *
 * The shift is not small: measured at **59.4 minutes** on a 362 km/s wind, and
 * it scales inversely with speed. At hourly resolution that is a whole bucket.
 */
const SWPC_SOLAR_WIND_URL =
  'https://services.swpc.noaa.gov/products/geospace/propagated-solar-wind.json';

/**
 * The last hour only, ~6.5 KB, in the identical format.
 *
 * The seven-day file is **1.19 MB**; polling that every fifteen minutes would be
 * 114 MB a day to collect fifteen minutes of new rows. This one covers sixty
 * minutes, so a fifteen-minute poll overlaps four times over and cannot skip an
 * hour even if several polls fail in a row.
 *
 * Same split as the Kp adapter's archive-versus-nowcast pair, for the same
 * reason.
 */
const SWPC_SOLAR_WIND_LATEST_URL =
  'https://services.swpc.noaa.gov/products/geospace/propagated-solar-wind-1-hour.json';

/**
 * The columns this adapter needs, looked up **by name** from the payload's own
 * header row rather than by position.
 *
 * The product leads with `["time_tag","speed","density",...]`, so the mapping is
 * in the response and there is no reason to hard-code offsets that a future
 * column insertion would silently shift. The OMNI adapter has to use positions
 * because its format is a bare fixed-width table with no header.
 *
 * `bz` is **GSM**: verified against SWPC's own `solar-wind-mag-field.json`,
 * which names its frame explicitly, agreeing to its rounding at the same minute.
 * GSM is also what the Geospace model this product feeds is driven by.
 */
const COLUMN_PROPAGATED_TIME = 'propagated_time_tag';
const COLUMN_SPEED = 'speed';
const COLUMN_DENSITY = 'density';
const COLUMN_BZ = 'bz';

/** Fetches the last seven days of propagated solar wind. */
export async function fetchRecentSolarWind(
  fetchImpl: typeof fetch = fetch,
): Promise<SpaceWeatherSample[]> {
  return fetchSolarWind(SWPC_SOLAR_WIND_URL, fetchImpl, 'seven-day');
}

/** Fetches the last hour, for the poll. */
export async function fetchLatestSolarWind(
  fetchImpl: typeof fetch = fetch,
): Promise<SpaceWeatherSample[]> {
  return fetchSolarWind(SWPC_SOLAR_WIND_LATEST_URL, fetchImpl, 'one-hour');
}

async function fetchSolarWind(
  url: string,
  fetchImpl: typeof fetch,
  label: string,
): Promise<SpaceWeatherSample[]> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(
      `SWPC solar wind ${label}: HTTP ${String(response.status)} ${response.statusText}`,
    );
  }
  return parseSwpcSolarWind(await response.json());
}

/**
 * Reduces the one-minute stream to hourly samples.
 *
 * Split out from the fetch so it can be tested against a fixture rather than the
 * network, like every other adapter here.
 *
 * ## The hourly value is a mean, and here that is correct
 *
 * `downsampleSpaceWeather` refuses to average Kp, because Kp is
 * quasi-logarithmic and the mean of two Kp values is not a physical quantity.
 * Speed and Bz are ordinary linear measurements, so their mean *is* meaningful —
 * and more to the point, OMNI's own hourly values are averages of high-resolution
 * data. Taking an extreme here would make the recent week disagree in kind with
 * every hour before it.
 *
 * ## The newest hour is partial, and is emitted anyway
 *
 * It averages however many minutes have arrived. The next poll overwrites it
 * with a fuller average — `insertSpaceWeather` coalesces on a non-null value —
 * so it converges within the poll interval. Withholding it instead would cost up
 * to an hour of freshness on a feed whose whole purpose is the live edge.
 */
export function parseSwpcSolarWind(payload: unknown): SpaceWeatherSample[] {
  if (!Array.isArray(payload) || payload.length < 2) {
    throw new Error('SWPC solar wind: expected a header row and at least one record');
  }

  const header = payload[0] as unknown;
  if (!Array.isArray(header)) throw new Error('SWPC solar wind: missing header row');

  const timeIndex = header.indexOf(COLUMN_PROPAGATED_TIME);
  const speedIndex = header.indexOf(COLUMN_SPEED);
  const densityIndex = header.indexOf(COLUMN_DENSITY);
  const bzIndex = header.indexOf(COLUMN_BZ);
  // Density is not required: it is carried for the magnetopause work, and a
  // feed without it should still yield the speed H3 is registered against.
  if (timeIndex < 0 || speedIndex < 0 || bzIndex < 0) {
    throw new Error(
      `SWPC solar wind: header is missing a required column (${COLUMN_PROPAGATED_TIME}, ${COLUMN_SPEED}, ${COLUMN_BZ})`,
    );
  }

  interface Bucket {
    speed: number[];
    density: number[];
    bz: number[];
  }
  const hours = new Map<string, Bucket>();

  for (const entry of payload.slice(1) as unknown[]) {
    if (!Array.isArray(entry)) continue;
    // `Array.isArray` narrows an unknown to `any[]`, which would make every
    // cell read an implicit any. Re-typing keeps the guards below meaningful.
    const row = entry as readonly unknown[];

    const hour = hourStart(row[timeIndex]);
    if (hour === null) continue;

    let bucket = hours.get(hour);
    if (!bucket) {
      bucket = { speed: [], density: [], bz: [] };
      hours.set(hour, bucket);
    }

    // Nulls are ordinary in this feed when an instrument drops out. They are
    // skipped per field rather than per row, so a minute with a good speed and
    // no magnetometer still contributes its speed.
    const speed = row[speedIndex];
    if (typeof speed === 'number' && Number.isFinite(speed)) bucket.speed.push(speed);

    const density = row[densityIndex];
    if (typeof density === 'number' && Number.isFinite(density)) bucket.density.push(density);

    const bz = row[bzIndex];
    if (typeof bz === 'number' && Number.isFinite(bz)) bucket.bz.push(bz);
  }

  const samples: SpaceWeatherSample[] = [];
  for (const [timeUtc, bucket] of hours) {
    const windSpeed = mean(bucket.speed);
    const density = mean(bucket.density);
    const bzGsm = mean(bucket.bz);
    if (windSpeed === null && density === null && bzGsm === null) continue;

    samples.push({
      timeUtc,
      // This product carries neither, and a zero would be a measurement.
      kp: null,
      dst: null,
      windSpeed,
      density,
      bzGsm,
    });
  }

  // The map preserves insertion order, which follows the feed — but the feed's
  // ordering is not a documented guarantee and the propagation shift varies with
  // wind speed, so rows can arrive slightly out of order near a speed change.
  samples.sort((a, b) => a.timeUtc.localeCompare(b.timeUtc));
  return samples;
}

/** The containing UTC hour as an ISO instant, or null if unparseable. */
function hourStart(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) total += value;
  // Rounded to a tenth: the feed reports to that precision, and a full-precision
  // mean would imply the instrument resolves more than it does.
  return Math.round((total / values.length) * 10) / 10;
}
