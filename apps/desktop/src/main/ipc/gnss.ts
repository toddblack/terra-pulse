import { ipcMain } from 'electron';
import {
  fetchMidasVelocities,
  fetchNglSeries,
  fetchNglStationList,
  fetchNglStationPage,
  type NglStationPage,
  type NglStationRecord,
} from '@terra-pulse/ingest';
import {
  GNSS_AFTER_DAYS,
  GNSS_MAX_BEFORE_DAYS,
  GNSS_MAX_STATIONS,
  bearingDeg,
  gnssQuakeDayMs,
  gnssReachKm,
  haversineKm,
  type GnssDailyPosition,
  type GnssRequest,
  type GnssResult,
  type GnssStationSeries,
  type GnssVelocity,
} from '@terra-pulse/schema';
import { createCachedLoader, type CachedLoader } from './waveform-stations';

/**
 * GPS station positions around one earthquake, fetched **when the window
 * opens**, held in memory and never written to disk — the user's condition
 * (2026-10-15): nothing should be downloaded and kept on their machine.
 *
 * Shaped like the ShakeMap lookup: pulled, small caches, a failure never
 * cached. What is fetched for one window: the station list once a session
 * (2.8 MB), the velocity file once a session (5 MB), and per station its whole
 * record (~1.5 MB) and its page (~20 KB). The records are fetched whole
 * because the lab publishes nothing smaller, and kept so the next quake near
 * the same station costs nothing.
 */

const DAY_MS = 86_400_000;

/** The list gains a day per station per day; a few hours old is current enough. */
const STATION_LIST_TTL_MS = 6 * 3_600_000;
/** The lab recomputes velocities weekly. */
const VELOCITY_TTL_MS = 24 * 3_600_000;
/** Per-station records and pages: long enough to click between quakes, short enough to see a new day. */
const STATION_TTL_MS = 3_600_000;
/**
 * How many stations' records are held.
 *
 * Bounded because a parsed twenty-year record is ~7,600 days, and clicking
 * through a busy region would otherwise keep every station it passed for as
 * long as the app stayed open. Twelve is four windows' worth.
 */
const STATION_CACHE_LIMIT = 12;

/**
 * A station must have been recording at least this long before the quake to be
 * offered, and must have at least this many days in that stretch.
 *
 * The station list only gives a record's first and last day, not its gaps, so
 * a station that "spans" the quake can still hold nothing near it. Measured
 * over 45 M7+ quakes (2005-2009) with a station in reach: **24 of 137 records
 * downloaded (18%) failed this**, in 15 of the 45 quakes.
 */
const MIN_BEFORE_SPAN_DAYS = 30;
const MIN_BEFORE_POSITIONS = 10;

/**
 * Stations closer together than this are one site.
 *
 * The lab keeps a separate id when a site's monument or receiver is replaced
 * beside the old one, so the nearest ids can be the same hillside twice — in 6
 * of the 45 quakes measured above, among the nearest eight. Two rows of one
 * place would waste the window.
 */
const SAME_SITE_KM = 1;

/**
 * At most this many candidates are downloaded for one window.
 *
 * A candidate that passes the station list can still turn out to have a gap
 * over the quake, and each costs ~1.5 MB to find out. In the same 45 quakes
 * the cap was never what stopped a window short of three — every shortfall
 * had run out of candidates first. A window downloaded 3.9 MB at the median
 * and 7.1 MB at most, in under a second.
 */
const MAX_CANDIDATES_TRIED = 2 * GNSS_MAX_STATIONS;

export interface GnssCandidate {
  record: NglStationRecord;
  distanceKm: number;
  bearingDeg: number;
}

/**
 * Whether a station's record, by its first and last day, covers the quake:
 * `MIN_BEFORE_SPAN_DAYS` before it, and at least one whole day after.
 *
 * The day the quake happened is neither before nor after it — that day's
 * position is an average over a day the station moved partway through.
 */
export function recordSpansQuake(record: NglStationRecord, originMs: number): boolean {
  const quakeDay = gnssQuakeDayMs(originMs);
  return record.beginMs <= quakeDay - MIN_BEFORE_SPAN_DAYS * DAY_MS && record.endMs >= quakeDay + DAY_MS;
}

/** Every station whose record covers the quake, nearest first. */
export function rankCandidates(
  stations: readonly NglStationRecord[],
  at: { latitude: number; longitude: number },
  originMs: number,
): GnssCandidate[] {
  const candidates: GnssCandidate[] = [];
  for (const record of stations) {
    if (!recordSpansQuake(record, originMs)) continue;
    candidates.push({
      record,
      distanceKm: haversineKm(at, record),
      bearingDeg: bearingDeg(at, record),
    });
  }
  candidates.sort((a, b) => a.distanceKm - b.distanceKm);
  return candidates;
}

/**
 * The days the window draws: a year before the quake to 30 days after. Shorter
 * spans are cut from this in the renderer.
 */
export function windowOf(positions: readonly GnssDailyPosition[], originMs: number): GnssDailyPosition[] {
  const quakeDay = gnssQuakeDayMs(originMs);
  const startMs = quakeDay - GNSS_MAX_BEFORE_DAYS * DAY_MS;
  const endMs = quakeDay + GNSS_AFTER_DAYS * DAY_MS;
  return positions.filter((p) => p.dayMs >= startMs && p.dayMs <= endMs);
}

/**
 * Whether a station's days actually cover the quake: enough of them in the
 * month before, and at least one after.
 */
export function coversQuake(window: readonly GnssDailyPosition[], originMs: number): boolean {
  const quakeDay = gnssQuakeDayMs(originMs);
  const monthBefore = quakeDay - MIN_BEFORE_SPAN_DAYS * DAY_MS;
  const before = window.filter((p) => p.dayMs >= monthBefore && p.dayMs < quakeDay).length;
  const after = window.some((p) => p.dayMs > quakeDay);
  return before >= MIN_BEFORE_POSITIONS && after;
}

export interface GnssSources {
  stationList: CachedLoader<NglStationRecord[]>;
  velocities: CachedLoader<Map<string, GnssVelocity>>;
  /** Null when the lab has no record for the station. Throws when it could not be reached. */
  series: (station: string) => Promise<GnssDailyPosition[] | null>;
  /** Null when the page could not be read — the window then says steps are unknown. */
  page: (station: string) => Promise<NglStationPage | null>;
}

/**
 * The stations to show for one quake, with their days.
 *
 * Nearest first within the lab's reach for the magnitude, one per site,
 * skipping any whose record turns out to have a gap over the quake. Throws when
 * the station list or a record could not be fetched, so "no station" and
 * "could not reach the lab" stay different answers.
 */
export async function lookUpGnss(request: GnssRequest, sources: GnssSources): Promise<GnssResult> {
  const originMs = Date.parse(request.originUtc);
  const reachKm = gnssReachKm(request.magnitude);

  const stations = await sources.stationList.get();
  if (stations === null) throw new Error('Could not fetch the NGL station list');

  const ranked = rankCandidates(stations, request, originMs);
  const inReach = ranked.filter((candidate) => candidate.distanceKm <= reachKm);
  if (inReach.length === 0) {
    return { status: 'none', reachKm, nearestKm: ranked[0]?.distanceKm ?? null };
  }

  // One per site, before any download.
  const distinct: GnssCandidate[] = [];
  for (const candidate of inReach) {
    if (distinct.some((kept) => haversineKm(kept.record, candidate.record) < SAME_SITE_KM)) continue;
    distinct.push(candidate);
    if (distinct.length === MAX_CANDIDATES_TRIED) break;
  }

  // Started alongside the records rather than after them: it is the slowest
  // single file, and a failure only costs the drift toggle.
  const velocitiesPromise = sources.velocities.get();

  const kept: { candidate: GnssCandidate; window: GnssDailyPosition[] }[] = [];
  // In rounds of however many are still needed, nearest first, so the usual
  // case is one round of three parallel downloads.
  let next = 0;
  while (kept.length < GNSS_MAX_STATIONS && next < distinct.length) {
    const round = distinct.slice(next, next + GNSS_MAX_STATIONS - kept.length);
    next += round.length;
    const records = await Promise.all(round.map((candidate) => sources.series(candidate.record.station)));
    round.forEach((candidate, index) => {
      const positions = records[index];
      if (!positions) return;
      const window = windowOf(positions, originMs);
      if (coversQuake(window, originMs)) kept.push({ candidate, window });
    });
  }
  if (kept.length === 0) {
    return { status: 'none', reachKm, nearestKm: ranked[0]?.distanceKm ?? null };
  }

  const [velocities, pages] = await Promise.all([
    velocitiesPromise,
    Promise.all(kept.map(({ candidate }) => sources.page(candidate.record.station))),
  ]);

  const series: GnssStationSeries[] = kept.map(({ candidate, window }, index) => {
    const { record } = candidate;
    const page = pages[index] ?? null;
    const first = window[0]?.dayMs ?? Number.NEGATIVE_INFINITY;
    const last = window.at(-1)?.dayMs ?? Number.POSITIVE_INFINITY;
    return {
      station: record.station,
      latitude: record.latitude,
      longitude: record.longitude,
      distanceKm: candidate.distanceKm,
      bearingDeg: candidate.bearingDeg,
      positions: window,
      velocity: velocities?.get(record.station) ?? null,
      steps: page === null ? null : page.steps.filter((step) => step.dayMs >= first && step.dayMs <= last),
      doi: page?.doi ?? null,
      lastDayMs: record.endMs,
    };
  });

  return { status: 'available', reachKm, stations: series };
}

/**
 * A small keyed cache: one request per key at a time, a bounded number of
 * answers, and a failure never cached.
 */
export function createKeyedCache<T>(
  load: (key: string) => Promise<T>,
  { ttlMs, limit }: { ttlMs: number; limit: number },
  now: () => number = Date.now,
): (key: string) => Promise<T> {
  const cached = new Map<string, { value: T; atMs: number }>();
  const inFlight = new Map<string, Promise<T>>();

  return (key) => {
    const hit = cached.get(key);
    if (hit && now() - hit.atMs < ttlMs) return Promise.resolve(hit.value);
    const running = inFlight.get(key);
    if (running) return running;

    const request = load(key)
      .then((value) => {
        // Re-inserted so insertion order is "least recently fetched first".
        cached.delete(key);
        cached.set(key, { value, atMs: now() });
        while (cached.size > limit) {
          const oldest = cached.keys().next().value;
          if (oldest === undefined) break;
          cached.delete(oldest);
        }
        return value;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, request);
    return request;
  };
}

/** USGS and EMSC ids alike are short and plain. Only used to name the request. */
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/**
 * The request, checked field by field. Its coordinates and time go into a
 * station search, never into a URL, but a NaN latitude would quietly return
 * "no station" and look like an answer.
 */
export function parseGnssRequest(raw: unknown): GnssRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const { eventId, latitude, longitude, magnitude, originUtc } = r;
  if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) return null;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90) return null;
  if (typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return null;
  if (typeof magnitude !== 'number' || !Number.isFinite(magnitude) || magnitude < 0 || magnitude > 10) return null;
  if (typeof originUtc !== 'string' || !Number.isFinite(Date.parse(originUtc))) return null;
  return { eventId, latitude, longitude, magnitude, originUtc };
}

export function registerGnssIpcHandlers(): void {
  const sources: GnssSources = {
    stationList: createCachedLoader(() => fetchNglStationList(), STATION_LIST_TTL_MS),
    velocities: createCachedLoader(() => fetchMidasVelocities(), VELOCITY_TTL_MS),
    series: createKeyedCache((station) => fetchNglSeries(station), {
      ttlMs: STATION_TTL_MS,
      limit: STATION_CACHE_LIMIT,
    }),
    // A page is a nicety — the DOI and the equipment marks — so a failed one
    // is reported as unknown rather than failing the window. Not cached as
    // null: the catch sits outside the cache.
    page: (() => {
      const cached = createKeyedCache((station) => fetchNglStationPage(station), {
        ttlMs: STATION_TTL_MS,
        limit: STATION_CACHE_LIMIT,
      });
      return (station: string) =>
        cached(station).catch((error: unknown) => {
          console.warn(`NGL station page ${station} could not be read`, error);
          return null;
        });
    })(),
  };

  ipcMain.handle('gnss:near-quake', (_event, raw: unknown): Promise<GnssResult> => {
    const request = parseGnssRequest(raw);
    if (request === null) return Promise.reject(new Error('Bad GPS request'));
    return lookUpGnss(request, sources);
  });
}
