import type {
  MagnetometerProduct,
  MagnetometerSample,
  MagnetometerSeries,
  MagnetometerStation,
  StationDisturbance,
} from '@terra-pulse/schema';

/**
 * Ground magnetometers, from the USGS geomagnetism web service.
 *
 * ## Why USGS and not INTERMAGNET, when INTERMAGNET has four times the stations
 *
 * INTERMAGNET lists **138** open observatories against USGS's ~30, and its data
 * is free too. It is the wrong shape for a *live* layer: it serves one station
 * and one **whole day** per request, 75 KB each, so a refresh across its network
 * is 138 requests and 10 MB. USGS takes an arbitrary time range, returns the
 * horizontal component directly, and costs ~2.7 KB per station-hour — about
 * 105 KB for the whole network.
 *
 * It is also not merely a US network: it serves Kakioka (Japan), Guam, Hermanus
 * (South Africa) and the Canadian chain, so the live view is sparse but not
 * parochial.
 *
 * INTERMAGNET *would* have been the right source for an archive, where
 * day-at-a-time requests are the granularity a backfill wants — but **H4b, the
 * only thing that wanted one, was withdrawn unrun on 2026-08-20**, so no
 * magnetometer archive is planned and this adapter is the whole of the app's
 * magnetometer story. `SOURCES.md` keeps the measured INTERMAGNET service shape
 * in case that is ever revisited.
 *
 * ## What is measured
 *
 * The **range of the horizontal component over the window**, in nT — the
 * largest value minus the smallest. Quiet sites sit at a few nT an hour; a
 * storm drives hundreds. This is the quantity K-indices are derived from, and
 * it is deliberately *not* converted into one: the K scale is quasi-logarithmic
 * and each observatory has its own conversion table, so a K would be neither
 * comparable across stations nor averageable — the same trap Kp already poses.
 * A range in nT is a measurement anyone can compare.
 */
const OBSERVATORIES_URL = 'https://geomag.usgs.gov/ws/observatories/';

const DATA_URL = 'https://geomag.usgs.gov/ws/data/';

/**
 * Stations whose name marks them as a test rig.
 *
 * The service lists several alongside the real thing — `BDT`/`TST` share
 * Boulder's exact coordinates with `BOU`. Drawn on a globe they stack
 * invisibly on top of a real station and report a different disturbance, which
 * is worse than being absent.
 */
function isTestStation(name: string): boolean {
  return /\btest\b/i.test(name);
}

interface ObservatoryFeature {
  id?: unknown;
  geometry?: { coordinates?: unknown } | null;
  properties?: { name?: unknown; agency?: unknown } | null;
}

/** The station list — positions and names, no readings. */
export async function fetchMagnetometerStations(
  fetchImpl: typeof fetch = fetch,
): Promise<MagnetometerStation[]> {
  const response = await fetchImpl(OBSERVATORIES_URL);
  if (!response.ok) {
    throw new Error(
      `USGS observatories: HTTP ${String(response.status)} ${response.statusText}`,
    );
  }
  return parseStations(await response.json());
}

/** Split out from the fetch so it can be tested against a fixture. */
export function parseStations(payload: unknown): MagnetometerStation[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('USGS observatories: expected a FeatureCollection');
  }
  const features = (payload as { features?: unknown }).features;
  if (!Array.isArray(features)) {
    throw new Error('USGS observatories: no features');
  }

  const stations: MagnetometerStation[] = [];

  for (const raw of features as ObservatoryFeature[]) {
    const code = raw.id;
    const name = raw.properties?.name;
    const coordinates = raw.geometry?.coordinates;
    // One listed observatory has null geometry. A station with no position
    // cannot be drawn, and defaulting it to (0,0) would put it in the Atlantic.
    if (typeof code !== 'string' || typeof name !== 'string' || !Array.isArray(coordinates)) {
      continue;
    }
    if (isTestStation(name)) continue;

    const [longitude, latitude] = coordinates as unknown[];
    if (typeof longitude !== 'number' || typeof latitude !== 'number') continue;

    stations.push({
      code,
      name,
      // The service reports longitude 0-360; the globe wants -180 to 180.
      // Boulder arrives as 254.8 and belongs at -105.2.
      longitude: longitude > 180 ? longitude - 360 : longitude,
      latitude,
      agency: typeof raw.properties?.agency === 'string' ? raw.properties.agency : null,
    });
  }

  return stations;
}

/**
 * The disturbance at one station over a window.
 *
 * Returns null when the station reported nothing usable — a real and frequent
 * case, since observatories drop out for maintenance and telemetry gaps. Null
 * is drawn as "no reading", never as "quiet": a station that is offline during
 * a storm is exactly the one a reader must not mistake for calm.
 */
export async function fetchStationDisturbance(
  code: string,
  startUtc: Date,
  endUtc: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<StationDisturbance | null> {
  const query = new URLSearchParams({
    id: code,
    format: 'json',
    // The horizontal component directly, rather than deriving it from X and Y —
    // the service already publishes it, and the two would disagree at the
    // stations that report in HDZ rather than XYZ.
    elements: 'H',
    sampling_period: '60',
    starttime: startUtc.toISOString(),
    endtime: endUtc.toISOString(),
  });

  const response = await fetchImpl(`${DATA_URL}?${query.toString()}`);
  // A station with no data for the window answers 4xx rather than an empty
  // series, so this is an ordinary outcome and not an error to propagate.
  if (!response.ok) return null;

  return parseDisturbance(code, await response.json());
}

/** Split out from the fetch so it can be tested against a fixture. */
export function parseDisturbance(code: string, payload: unknown): StationDisturbance | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const body = payload as { times?: unknown; values?: unknown };

  if (!Array.isArray(body.times) || !Array.isArray(body.values)) return null;
  const channel = (body.values as { values?: unknown }[])[0];
  if (!channel || !Array.isArray(channel.values)) return null;

  const readings = (channel.values as unknown[]).filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  // One sample has no range. Reporting 0 would be indistinguishable from a
  // perfectly steady hour, which is a claim a single reading cannot support.
  if (readings.length < 2) return null;

  let low = readings[0]!;
  let high = readings[0]!;
  for (const value of readings) {
    if (value < low) low = value;
    if (value > high) high = value;
  }

  const times = body.times as unknown[];
  const last = times.at(-1);

  return {
    code,
    rangeNt: high - low,
    samples: readings.length,
    observedAtUtc: typeof last === 'string' ? last : new Date().toISOString(),
  };
}

/**
 * The year from which `variation` starts being the product that answers, and
 * `definitive` stops.
 *
 * Measured at Boulder: `definitive` returns real values through 2013 and
 * nothing from 2014; `variation` answers at 2010 and after. They overlap
 * around 2010-2013, so the boundary is a choice inside that overlap rather
 * than a cliff. 2014 is where `definitive` demonstrably stops.
 *
 * This only decides which product is **tried first**. Everything falls back, so
 * a wrong guess here costs one extra request, never a wrong answer — which is
 * the point, because the coverage is not monotonic enough for any rule to be
 * right every time (2015 answers from neither of the two obvious candidates).
 */
const VARIATION_FROM_YEAR = 2014;

/**
 * Products to try, best guess first.
 *
 * Ordered rather than filtered: nothing is ruled out, because the measured
 * coverage has holes that no date rule predicts. See `MagnetometerProduct`.
 */
export function productOrderFor(startUtc: Date): MagnetometerProduct[] {
  return startUtc.getUTCFullYear() >= VARIATION_FROM_YEAR
    ? ['variation', 'adjusted', 'quasi-definitive', 'definitive']
    : ['definitive', 'quasi-definitive', 'variation', 'adjusted'];
}

/**
 * One station's horizontal-component trace over a window, or null if no
 * product covers it.
 *
 * Tries each product until one returns real numbers. Usually one request; at
 * worst four, which is the price of an era the guess got wrong. **Only
 * `sampling_period=60` is usable** — measured, `3600` returns an array of
 * nulls rather than hourly means, so a long window cannot be thinned at the
 * source and has to be refused by the caller instead.
 */
export async function fetchStationSeries(
  code: string,
  startUtc: Date,
  endUtc: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<MagnetometerSeries | null> {
  for (const product of productOrderFor(startUtc)) {
    const query = new URLSearchParams({
      id: code,
      format: 'json',
      type: product,
      elements: 'H',
      sampling_period: '60',
      starttime: startUtc.toISOString(),
      endtime: endUtc.toISOString(),
    });

    let response: Response;
    try {
      response = await fetchImpl(`${DATA_URL}?${query.toString()}`);
    } catch {
      // A transport failure on one product says nothing about the others, and
      // the whole point of the loop is that most of them will not answer.
      continue;
    }
    if (!response.ok) continue;

    const samples = parseSeries(await response.json());
    // The load-bearing check: an uncovered era returns 200 with all-null
    // values, so "did it parse" is not the question — "did it contain
    // measurements" is.
    if (samples && samples.length >= 2) return { code, product, samples };
  }

  return null;
}

/** Split out from the fetch so it can be tested against a fixture. */
export function parseSeries(payload: unknown): MagnetometerSample[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const body = payload as { times?: unknown; values?: unknown };
  if (!Array.isArray(body.times) || !Array.isArray(body.values)) return null;

  const channel = (body.values as { values?: unknown }[])[0];
  if (!channel || !Array.isArray(channel.values)) return null;

  const times = body.times as unknown[];
  const values = channel.values as unknown[];
  const samples: MagnetometerSample[] = [];

  for (let i = 0; i < times.length; i += 1) {
    const value = values[i];
    const time = times[i];
    // Nulls are dropped rather than carried as gaps: a magnetometer trace is
    // drawn as a line, and the caller needs to know where it genuinely has
    // measurements. Dropping keeps `samples.length` an honest count, which is
    // what distinguishes an uncovered era from a real one.
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (typeof time !== 'string') continue;
    const timeMs = Date.parse(time);
    if (!Number.isFinite(timeMs)) continue;
    samples.push({ timeMs, hNt: value });
  }

  return samples;
}
