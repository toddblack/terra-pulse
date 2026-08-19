import type { SpaceWeatherSample } from '@terra-pulse/schema';

/**
 * GOES X-ray flux — live only. See `SpaceWeatherSample.xrayFlux` for why
 * there is no historical ingest here yet.
 *
 * ## The long channel, by name, not by position
 *
 * SWPC's product carries **two** energy channels per timestamp — `0.05-0.4nm`
 * (short) and `0.1-0.8nm` (long) — as separate records rather than separate
 * fields. The long channel is what flare classification is defined on: each
 * letter (A/B/C/M/X) is one decade of exactly this quantity, so it's what
 * NOAA's own charts and every other space-weather source mean by "the" X-ray
 * flux. Filtered on the `energy` string rather than assumed by position or
 * array order, which the product does not document as stable.
 *
 * ## `flux`, not `observed_flux`
 *
 * The product publishes both: `observed_flux` is the raw instrument reading,
 * `flux` is that reading after `electron_correction` — a correction for
 * energetic particles hitting the detector, which is a real contamination
 * source and not a subtle one (measured live: `electron_contaminaton: true`
 * on a genuine record). `flux` is the corrected value and what NOAA's own
 * displays plot, so that's what this reads.
 */
const SWPC_GOES_XRAY_URL = 'https://services.swpc.noaa.gov/json/goes/primary/xrays-7-day.json';

/**
 * The last six hours only, ~160 KB against the seven-day file's ~4.4 MB.
 *
 * Same split as the Kp and solar-wind adapters, for the same reason: polling
 * the wide file on a fifteen-minute cadence would be well over a gigabyte a
 * day to collect a few minutes of new rows. Six hours rather than one — like
 * the solar-wind adapter uses — because this file is far larger per hour of
 * coverage (1-minute cadence, two channels per timestamp), so there is less
 * margin to spend on redundancy against a missed poll or two.
 */
const SWPC_GOES_XRAY_LATEST_URL = 'https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json';

const LONG_CHANNEL = '0.1-0.8nm';

interface RawXrayRecord {
  time_tag?: unknown;
  flux?: unknown;
  energy?: unknown;
}

/** Fetches the last seven days of X-ray flux — the closest this data source has to a backfill. */
export async function fetchRecentGoesXray(fetchImpl: typeof fetch = fetch): Promise<SpaceWeatherSample[]> {
  return fetchGoesXray(SWPC_GOES_XRAY_URL, fetchImpl, 'seven-day');
}

/** Fetches the last six hours, for the poll. */
export async function fetchLatestGoesXray(fetchImpl: typeof fetch = fetch): Promise<SpaceWeatherSample[]> {
  return fetchGoesXray(SWPC_GOES_XRAY_LATEST_URL, fetchImpl, 'six-hour');
}

async function fetchGoesXray(
  url: string,
  fetchImpl: typeof fetch,
  label: string,
): Promise<SpaceWeatherSample[]> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`SWPC GOES X-ray ${label}: HTTP ${String(response.status)} ${response.statusText}`);
  }
  return parseSwpcGoesXray(await response.json());
}

/**
 * Reduces the one-minute long-channel stream to hourly samples.
 *
 * Split out from the fetch so it can be tested against a fixture, like every
 * other adapter here.
 *
 * ## The hourly value is the hour's peak, not its mean
 *
 * This is the opposite choice from the solar-wind adapter, which means its
 * sixty one-minute readings into an hourly value — and that's deliberate,
 * not an inconsistency. Wind speed varies smoothly enough that a mean is a
 * reasonable summary of an hour. Flux does not: a flare is a spike lasting
 * minutes inside a background that can be four or more orders of magnitude
 * quieter, so averaging sixty readings would dilute a real M-class flare
 * toward invisibility inside its own hour, before the data even reaches
 * `downsampleSpaceWeather`'s own peak/typical split. Taking the max keeps the
 * spike; `typicalXrayFlux` downstream then becomes a median of hourly
 * *peaks* rather than a median of ordinary readings, which is a real
 * difference from Kp's `typicalKp` worth knowing but the safer one — it can
 * only overstate a quiet hour, never erase a flare that happened during it.
 */
export function parseSwpcGoesXray(payload: unknown): SpaceWeatherSample[] {
  if (!Array.isArray(payload)) {
    throw new Error('SWPC GOES X-ray: expected an array');
  }

  const hours = new Map<string, number>();

  for (const entry of payload as RawXrayRecord[]) {
    if (entry.energy !== LONG_CHANNEL) continue;

    const flux = entry.flux;
    if (typeof flux !== 'number' || !Number.isFinite(flux) || flux <= 0) continue;

    const hour = hourStart(entry.time_tag);
    if (hour === null) continue;

    const current = hours.get(hour);
    if (current === undefined || flux > current) hours.set(hour, flux);
  }

  const samples: SpaceWeatherSample[] = Array.from(hours, ([timeUtc, xrayFlux]) => ({
    timeUtc,
    // This product carries none of the other indices.
    kp: null,
    dst: null,
    windSpeed: null,
    density: null,
    bzGsm: null,
    xrayFlux,
  }));

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
