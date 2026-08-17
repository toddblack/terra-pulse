import type { CmeArrival, FlareClass, SolarFlare } from '@terra-pulse/schema';

/**
 * Solar flares and CME arrivals from NASA's DONKI catalogue.
 *
 * ## The key is optional, and that is the point
 *
 * NASA publishes a shared `DEMO_KEY` that works without registration, so this
 * layer functions for someone who never sets one — degraded to 10 requests an
 * hour rather than broken. A personal key raises that to 2,500.
 *
 * That distinction is what makes DONKI acceptable where SuperMAG was not: an
 * optional key with a working fallback is fine, a mandatory account is not. See
 * `SOURCES.md`.
 *
 * ## Two endpoints, because arrival is not in the CME record
 *
 * `/FLR` gives flares. Arrivals do **not** come from `/CME` or `/CMEAnalysis` —
 * measured, `CMEAnalysis` returns no `enlilList` and no arrival times at all.
 * They come from `/WSAEnlilSimulations`, the model runs, where roughly a quarter
 * of runs carry an Earth arrival and the rest miss us.
 */
const BASE = 'https://api.nasa.gov/DONKI';

/** NASA's shared key. Rate-limited to 10 requests an hour, but it works. */
export const DONKI_DEMO_KEY = 'DEMO_KEY';

function endpoint(path: string, startUtc: Date, endUtc: Date, apiKey: string): string {
  const query = new URLSearchParams({
    startDate: startUtc.toISOString().slice(0, 10),
    endDate: endUtc.toISOString().slice(0, 10),
    api_key: apiKey,
  });
  return `${BASE}${path}?${query.toString()}`;
}

async function getJson(url: string, fetchImpl: typeof fetch, label: string): Promise<unknown> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    // 429 is the one worth naming: on the shared key it arrives after ten
    // requests an hour, and "HTTP 429" alone reads as a bug rather than a quota.
    if (response.status === 429) {
      throw new Error(
        `DONKI ${label}: rate limited. The shared DEMO_KEY allows 10 requests an hour; set NASA_DONKI_API_KEY for 2,500.`,
      );
    }
    throw new Error(`DONKI ${label}: HTTP ${String(response.status)} ${response.statusText}`);
  }
  return response.json();
}

/** Solar flares over a date range. */
export async function fetchSolarFlares(
  startUtc: Date,
  endUtc: Date,
  apiKey: string = DONKI_DEMO_KEY,
  fetchImpl: typeof fetch = fetch,
): Promise<SolarFlare[]> {
  return parseFlares(await getJson(endpoint('/FLR', startUtc, endUtc, apiKey), fetchImpl, 'FLR'));
}

/** Modelled CME arrivals at Earth over a date range. */
export async function fetchCmeArrivals(
  startUtc: Date,
  endUtc: Date,
  apiKey: string = DONKI_DEMO_KEY,
  fetchImpl: typeof fetch = fetch,
): Promise<CmeArrival[]> {
  return parseCmeArrivals(
    await getJson(
      endpoint('/WSAEnlilSimulations', startUtc, endUtc, apiKey),
      fetchImpl,
      'WSAEnlilSimulations',
    ),
  );
}

/**
 * Splits a published class like `M2.4` into its letter and magnitude.
 *
 * The two parts cannot be compared as one string: `M9.9` is smaller than
 * `X1.0`, and there is no `M10` — that is `X1`. Returns null for anything that
 * does not parse, which is dropped rather than guessed at.
 */
export function parseFlareClass(
  classType: unknown,
): { flareClass: FlareClass; magnitude: number } | null {
  if (typeof classType !== 'string') return null;
  const match = /^([ABCMX])(\d+(?:\.\d+)?)$/.exec(classType.trim().toUpperCase());
  if (!match) return null;
  const magnitude = Number(match[2]);
  if (!Number.isFinite(magnitude)) return null;
  return { flareClass: match[1] as FlareClass, magnitude };
}

/**
 * DONKI timestamps carry no seconds — `2026-08-10T12:34Z`.
 *
 * Normalised to a full ISO instant so every time in this app is the same shape,
 * and so a consumer comparing them against hourly space-weather rows is not
 * quietly comparing two different formats.
 */
function toIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

interface RawFlare {
  flrID?: unknown;
  classType?: unknown;
  peakTime?: unknown;
  beginTime?: unknown;
  endTime?: unknown;
  sourceLocation?: unknown;
  activeRegionNum?: unknown;
  link?: unknown;
}

/**
 * Split out from the fetch so it can be tested against a fixture.
 *
 * **No dedupe, deliberately.** DONKI carries a `versionId` and revises records,
 * which looks like it should produce duplicates — checked on two full years:
 * 127 M/X records with 127 unique ids and 127 unique peak times in 2015, 382 and
 * 382 in 2023. The API returns the current version of each flare, not its
 * history. Adding a dedupe pass would be guarding against something that does
 * not happen, and would hide it if the API ever changed.
 */
export function parseFlares(payload: unknown): SolarFlare[] {
  if (!Array.isArray(payload)) throw new Error('DONKI FLR: expected an array');

  const flares: SolarFlare[] = [];

  for (const raw of payload as RawFlare[]) {
    const id = stringOrNull(raw.flrID);
    const peakTimeUtc = toIso(raw.peakTime);
    const parsed = parseFlareClass(raw.classType);
    // A flare with no id, no peak time or an unreadable class cannot be placed
    // on a timeline or compared to another, so it is dropped rather than
    // half-stored.
    if (!id || !peakTimeUtc || !parsed) continue;

    flares.push({
      id,
      classType: String(raw.classType),
      flareClass: parsed.flareClass,
      magnitude: parsed.magnitude,
      peakTimeUtc,
      beginTimeUtc: toIso(raw.beginTime),
      endTimeUtc: toIso(raw.endTime),
      sourceLocation: stringOrNull(raw.sourceLocation),
      activeRegionNumber: numberOrNull(raw.activeRegionNum),
      link: stringOrNull(raw.link),
    });
  }

  return flares;
}

interface RawSimulation {
  simulationID?: unknown;
  estimatedShockArrivalTime?: unknown;
  kp_90?: unknown;
  isEarthGB?: unknown;
  isEarthMinorImpact?: unknown;
  link?: unknown;
}

/**
 * Keeps only the runs that actually reach Earth.
 *
 * Measured over ten weeks: 79 of 325 runs carry an Earth arrival. The other 246
 * are not failures — they are CMEs modelled to miss us, and several carry
 * arrivals at *other* spacecraft in their `impactList`, which is why filtering
 * on the presence of an arrival time is not the same as filtering on Earth.
 * `estimatedShockArrivalTime` is the Earth-specific field.
 */
export function parseCmeArrivals(payload: unknown): CmeArrival[] {
  if (!Array.isArray(payload)) throw new Error('DONKI WSAEnlilSimulations: expected an array');

  const arrivals: CmeArrival[] = [];

  for (const raw of payload as RawSimulation[]) {
    const simulationId = stringOrNull(raw.simulationID);
    const arrivalTimeUtc = toIso(raw.estimatedShockArrivalTime);
    if (!simulationId || !arrivalTimeUtc) continue;

    arrivals.push({
      simulationId,
      arrivalTimeUtc,
      predictedKp: numberOrNull(raw.kp_90),
      // Defaulting to false rather than null: the flags are booleans in the
      // payload, and an absent flag means the model did not mark it, which is
      // the same as not being one.
      glancingBlow: raw.isEarthGB === true,
      minorImpact: raw.isEarthMinorImpact === true,
      link: stringOrNull(raw.link),
    });
  }

  return arrivals;
}
