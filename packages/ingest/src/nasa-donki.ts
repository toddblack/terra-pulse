import type { CmeArrival, FlareClass, SolarFlare } from '@terra-pulse/schema';

/**
 * Solar flares and CME arrivals from NASA's DONKI catalogue.
 *
 * ## No key, and no account
 *
 * Until 2026-09-30 this went through NASA's API gateway, which wanted a key:
 * the app required a free personal one (headroom, and not depending on the
 * shared `DEMO_KEY` every tutorial hardcodes), stored in `app_state`, with a
 * modal asking for it. That made DONKI the one exception to `SOURCES.md`'s
 * standing rule 2. The gateway is gone (below), and CCMC's own endpoint takes
 * no key — so the requirement, the modal and the storage were removed with it,
 * and every source in the app is keyless again. A key that was saved is
 * cleared from `app_state` by migration, since it is a credential nothing
 * reads any more.
 *
 * ## Two endpoints, because arrival is not in the CME record
 *
 * `/FLR` gives flares. Arrivals do **not** come from `/CME` or `/CMEAnalysis` —
 * measured, `CMEAnalysis` returns no `enlilList` and no arrival times at all.
 * They come from `/WSAEnlilSimulations`, the model runs, where roughly a quarter
 * of runs carry an Earth arrival and the rest miss us.
 *
 * ## The endpoint moved on 2026-09-30
 *
 * CCMC retired both old bases — `api.nasa.gov/DONKI` and
 * `kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get` — and each now answers with a 301 to
 * an HTML announcements page (ccmc.gsfc.nasa.gov/news/major-updates). `fetch`
 * follows it, so the symptom was `Unexpected token '<'` from the JSON parser on
 * every poll. The announcement states parameters and response formats are
 * unchanged, and that was checked rather than taken on trust (2026-10-02):
 * May 2024 from the new base against what this app had stored from the old
 * one — 181 of 181 flares by id with no class differences, 52 of 52 Earth
 * arrivals with no timing differences.
 *
 * **The new base needs no key**: responses were identical with and without
 * one, so none is sent.
 *
 * **"Unchanged" was not quite true: it caps a request at 60 days**, which the
 * announcement does not mention and the first verification missed because
 * both of its checks happened to ask for a month. The backfill and the lazy
 * query both ask for a calendar year, and every one answered `400 API Error:
 * Date range cannot exceed 60 days`. Ranges are now split here, so nothing
 * above this module needs to know — see `donkiDateWindows`.
 */
export const DONKI_BASE_URL = 'https://ccmc.gsfc.nasa.gov/DONKI-API/get';

/**
 * The longest range one request may ask for, in days, counted as `endDate`
 * minus `startDate`. Measured 2026-10-02: 2024-03-01..2024-04-30 (60) is
 * accepted, ..2024-05-01 (61) refused.
 */
export const DONKI_MAX_RANGE_DAYS = 60;

const DAY_MS = 86_400_000;

/** A request's `startDate`/`endDate` pair, both `YYYY-MM-DD`, both inclusive. */
export interface DonkiDateWindow {
  startDate: string;
  endDate: string;
}

/**
 * The windows one range must be split into: consecutive, each at most
 * `DONKI_MAX_RANGE_DAYS` long, covering every day from `startUtc`'s date to
 * `endUtc`'s.
 *
 * **Both dates are inclusive, so windows must not share a boundary day.**
 * Measured: 2024-05-01..05-14 plus 05-14..05-31 returned 187 records for a
 * month that holds 181 — the six flares of the 14th, twice. So each window
 * starts the day after the last one ended. The fetchers still de-duplicate by
 * id, in case CCMC ever assigns an event to a day differently than this
 * assumes.
 */
export function donkiDateWindows(startUtc: Date, endUtc: Date): DonkiDateWindow[] {
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const first = Date.parse(day(startUtc.getTime()));
  const last = Date.parse(day(endUtc.getTime()));
  const windows: DonkiDateWindow[] = [];
  for (let from = first; from <= last; ) {
    const to = Math.min(from + DONKI_MAX_RANGE_DAYS * DAY_MS, last);
    windows.push({ startDate: day(from), endDate: day(to) });
    from = to + DAY_MS;
  }
  return windows;
}

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
      `DONKI ${label}: rate limited. CCMC publishes no limit for its keyless endpoint; waiting before retrying.`,
    );
    this.name = 'DonkiRateLimitError';
  }
}

function endpoint(path: string, window: DonkiDateWindow): string {
  const query = new URLSearchParams({ startDate: window.startDate, endDate: window.endDate });
  return `${DONKI_BASE_URL}${path}?${query.toString()}`;
}

async function getJson(url: string, fetchImpl: typeof fetch, label: string): Promise<unknown> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    // 429 is the one worth naming: "HTTP 429" alone reads as a bug rather than
    // a quota, and the controller waits it out instead of failing. CCMC
    // documents no limit for this endpoint; the handling stays because a
    // public service is entitled to add one.
    if (response.status === 429) {
      throw new DonkiRateLimitError(label);
    }
    // The body carries the reason and the status text does not — a 400 for
    // an over-long range arrived with an empty statusText, so the log read
    // "HTTP 400" and nothing else while the body said exactly what was wrong.
    const reason = (await response.text().catch(() => '')).trim().slice(0, 200);
    throw new Error(
      `DONKI ${label}: HTTP ${String(response.status)} ${response.statusText}${reason ? ` — ${reason}` : ''}`.trim(),
    );
  }
  // A retired endpoint redirects to a web page that answers 200, so `ok` says
  // nothing about whether this is data. Say what arrived and where it came
  // from, rather than letting the JSON parser report a stray '<'.
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    throw new Error(
      `DONKI ${label}: expected JSON, got ${type || 'no content type'} from ${response.url || url} — has the endpoint moved?`,
    );
  }
  return response.json();
}

/**
 * Every window of a range, fetched in turn and joined, keeping the first of
 * any id seen twice. Sequential rather than parallel: a year is six requests,
 * and a keyless public service is not something to fan out against.
 */
async function fetchWindows<T>(
  path: string,
  label: string,
  startUtc: Date,
  endUtc: Date,
  fetchImpl: typeof fetch,
  parse: (payload: unknown) => T[],
  idOf: (item: T) => string,
): Promise<T[]> {
  const byId = new Map<string, T>();
  for (const window of donkiDateWindows(startUtc, endUtc)) {
    for (const item of parse(await getJson(endpoint(path, window), fetchImpl, label))) {
      if (!byId.has(idOf(item))) byId.set(idOf(item), item);
    }
  }
  return [...byId.values()];
}

/** Solar flares over a date range, of any length. */
export function fetchSolarFlares(
  startUtc: Date,
  endUtc: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<SolarFlare[]> {
  return fetchWindows('/FLR', 'FLR', startUtc, endUtc, fetchImpl, parseFlares, (f) => f.id);
}

/** Modelled CME arrivals at Earth over a date range, of any length. */
export function fetchCmeArrivals(
  startUtc: Date,
  endUtc: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<CmeArrival[]> {
  return fetchWindows(
    '/WSAEnlilSimulations',
    'WSAEnlilSimulations',
    startUtc,
    endUtc,
    fetchImpl,
    parseCmeArrivals,
    (a) => a.simulationId,
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
      source: 'donki',
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
