import type { CmeArrival, FlareClass, SolarFlare } from '@terra-pulse/schema';

/**
 * Solar flares and CME arrivals from NASA's DONKI catalogue.
 *
 * ## No shared-key fallback — a product choice, not a proven-broken `DEMO_KEY`
 *
 * NASA publishes a shared `DEMO_KEY` that works without registration, and the
 * original design here leaned on it: the app would run for anyone who never
 * set a key, degraded to 10 requests an hour instead of 2,500. Real testing
 * turned up `403 Forbidden` on essentially every request, which looked like
 * the shared key being unreliable — but the actual cause, found afterwards,
 * was `apps/desktop/src/main/ipc/nasa-donki.ts`'s key resolution treating an
 * *empty* `NASA_DONKI_API_KEY=` in `.env` as a configured key rather than as
 * unset, so every request went out with a blank `api_key`. That is what a 403
 * looks like for a bad credential, and it fully explains what was seen —
 * `DEMO_KEY` itself was never actually confirmed to be the problem.
 *
 * The app requires a personal key anyway, independent of that bug: headroom
 * (2,500 requests/hour instead of 10) and not depending on a resource shared
 * with every tutorial and demo that hardcodes `DEMO_KEY`. See that file's
 * `donkiApiKey` for the actual gate.
 *
 * The function signatures below still accept `apiKey` as optional and still
 * default to `DONKI_DEMO_KEY` — that stays honest at the HTTP-client level,
 * where a shared key is a valid credential even if the app chooses not to use
 * it. The "requires a key" decision lives one layer up, in what the app
 * chooses to call this with.
 *
 * This does narrow the "no mandatory account" rule in `SOURCES.md` — worth
 * being honest about. It's a narrower ask than SuperMAG's rejected
 * registration (a free, instant, login-free key request, not an account with
 * credentials), and it's scoped to DONKI alone; every other layer in this app
 * remains fully keyless.
 *
 * ## Two endpoints, because arrival is not in the CME record
 *
 * `/FLR` gives flares. Arrivals do **not** come from `/CME` or `/CMEAnalysis` —
 * measured, `CMEAnalysis` returns no `enlilList` and no arrival times at all.
 * They come from `/WSAEnlilSimulations`, the model runs, where roughly a quarter
 * of runs carry an Earth arrival and the rest miss us.
 */
const BASE = 'https://api.nasa.gov/DONKI';

/**
 * NASA's shared key. Rate-limited to 10 requests an hour. See the module doc
 * above — this app doesn't call the fetch functions below with this as the
 * actual key any more, only as their documented default, by product choice
 * rather than because it was shown not to work.
 */
export const DONKI_DEMO_KEY = 'DEMO_KEY';

/**
 * Raised on HTTP 429 instead of a plain `Error`, same idea as
 * `ArchiveCancelledError` in the archive adapter.
 *
 * Lets a caller tell "rate limited, will clear on its own" apart from
 * "actually broken" without string-matching a message — the main-process
 * controller uses this to switch into a `waiting`/auto-resume state rather
 * than burning retries or failing outright.
 */
export class DonkiRateLimitError extends Error {
  constructor(label: string) {
    super(
      `DONKI ${label}: rate limited. The shared DEMO_KEY allows 10 requests an hour; set NASA_DONKI_API_KEY for 2,500.`,
    );
    this.name = 'DonkiRateLimitError';
  }
}

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
      throw new DonkiRateLimitError(label);
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
