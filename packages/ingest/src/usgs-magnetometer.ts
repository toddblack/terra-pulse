import type { MagnetometerStation, StationDisturbance } from '@terra-pulse/schema';

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
 * **INTERMAGNET remains the right source for the H4b archive**, where day-at-a-
 * time requests are exactly the granularity a backfill wants. Same split as the
 * earthquakes: a cheap rolling view and a deliberate archive, from sources
 * shaped for each.
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
