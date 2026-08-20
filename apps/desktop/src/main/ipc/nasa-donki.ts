import { ipcMain } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import { DonkiRateLimitError, fetchCmeArrivals, fetchSolarFlares } from '@terra-pulse/ingest';
import { DONKI_START_YEAR, type CmeArrival, type DonkiProgress, type SolarFlare } from '@terra-pulse/schema';
import {
  completedDonkiYears,
  donkiChunkSummary,
  insertCmeArrivals,
  insertSolarFlares,
  queryCmeArrivals,
  querySolarFlares,
  readDonkiApiKey,
  recordDonkiChunk,
  saveDonkiApiKey,
  type DonkiSource,
} from '@terra-pulse/db';

/** How often the live tail is refreshed. Flares and CMEs are not minute-scale events. */
const DONKI_POLL_INTERVAL_MS = 30 * 60_000;

/** How far back the live poll looks, wide enough to overlap the previous poll comfortably. */
const POLL_WINDOW_MS = 3 * 24 * 60_000 * 60;

/** Transient failures happen on a multi-minute run; one bad year shouldn't end it. */
const CHUNK_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;

/**
 * A minute of slack past NASA's documented hourly window, since the exact
 * reset semantics for the shared key aren't documented.
 */
const RATE_LIMIT_RETRY_DELAY_MS = 61 * 60_000;

/** How often the wait loop checks for cancellation. */
const RATE_LIMIT_POLL_MS = 2_000;

/** A wider query than this many missing years shows only what's cached — see `ensureCoverage`. */
const LAZY_FETCH_MAX_MISSING_YEARS = 2;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The key a DONKI request would use — `null` when none is configured.
 *
 * **There is no shared-key fallback, by product decision, not because
 * `DEMO_KEY` was proven broken.** Real testing did turn up `403 Forbidden` on
 * every request, which looked at first like the shared key being unreliable
 * — but the actual cause was this function: `NASA_DONKI_API_KEY=` with no
 * value in `.env` resolves to `''`, not `undefined`, and the original `??`
 * chain happily returned that empty string as "the key", sending a blank
 * `api_key` to NASA. **That is what a 403 looks like for a bad credential —
 * every 403 seen so far is fully explained by this, and DEMO_KEY was never
 * actually confirmed broken.** The fix below treats blank the same as unset.
 * Independent of that bug, the product decision stands: these features
 * require a personal key rather than the shared one, for headroom (2,500
 * requests/hour instead of 10) and to not depend on a resource shared with
 * every other tutorial and demo that hardcodes `DEMO_KEY`. Every call site
 * below checks for `null` and does nothing rather than substituting a key
 * nobody asked for.
 *
 * `app_state` wins over `.env` because it's the only mechanism that survives
 * packaging — `dotenv.config()`'s path resolves relative to the main process
 * bundle's own location, which only lands on the repo's `.env` in dev.
 *
 * Read **inside** this function, called at request time, rather than cached
 * as a module-level constant: `main/index.ts` calls `dotenv.config()` in its
 * own top-level body, but ES module imports are fully evaluated before an
 * importing module's own statements run — so a constant here, evaluated at
 * import time, would have read `process.env` before `.env` was loaded and
 * silently frozen on `undefined` for the life of the process.
 */
function donkiApiKey(db: DatabaseSync): string | null {
  const saved = readDonkiApiKey(db);
  if (saved !== null) return saved;

  // `??` alone isn't enough here: `NASA_DONKI_API_KEY=` with no value in
  // `.env` makes this `''`, not `undefined` — an empty string that `??`
  // would happily return as "the key", sending a blank `api_key` to NASA
  // (a 403, correctly) while `hasApiKey` reported true and nothing ever
  // gated. Blank and unset must resolve the same way: no key.
  const fromEnv = process.env['NASA_DONKI_API_KEY']?.trim();
  return fromEnv ? fromEnv : null;
}

export class DonkiCancelledError extends Error {
  constructor() {
    super('DONKI backfill cancelled');
    this.name = 'DonkiCancelledError';
  }
}

/**
 * Every year the backfill covers, oldest first — same reasoning as
 * `dstBackfillYears` in `space-weather.ts`: a contiguous span from the start
 * rather than scattered years, so an interrupted run leaves something
 * describable in one sentence.
 */
export function donkiBackfillYears(throughYear: number): number[] {
  const years: number[] = [];
  for (let year = DONKI_START_YEAR; year <= throughYear; year += 1) years.push(year);
  return years;
}

function isYearFinal(year: number, now: Date): boolean {
  return year < now.getUTCFullYear();
}

/**
 * One year's fetch-insert-record for one source, coalesced across concurrent
 * callers.
 *
 * Keyed by `${source}:${year}` so a bulk backfill and an on-demand query
 * wanting the same year don't double-spend the shared key's rate limit — the
 * second caller just awaits the first's in-flight promise. Module-level
 * because both the backfill controller and the lazy query handlers below
 * need to share it.
 */
const inFlightYearFetches = new Map<string, Promise<void>>();

async function fetchAndStoreYear(
  db: DatabaseSync,
  year: number,
  source: DonkiSource,
  canRecord: boolean,
  apiKey: string,
): Promise<void> {
  const startUtc = new Date(`${String(year)}-01-01T00:00:00.000Z`);
  const endUtc = new Date(`${String(year + 1)}-01-01T00:00:00.000Z`);

  if (source === 'flares') {
    const flares = await fetchSolarFlares(startUtc, endUtc, apiKey);
    insertSolarFlares(db, flares);
    if (canRecord) recordDonkiChunk(db, year, source, flares.length);
  } else {
    const arrivals = await fetchCmeArrivals(startUtc, endUtc, apiKey);
    insertCmeArrivals(db, arrivals);
    if (canRecord) recordDonkiChunk(db, year, source, arrivals.length);
  }
}

function fetchYearOnce(
  db: DatabaseSync,
  year: number,
  source: DonkiSource,
  canRecord: boolean,
  apiKey: string,
): Promise<void> {
  const key = `${source}:${String(year)}`;
  const existing = inFlightYearFetches.get(key);
  if (existing) return existing;

  const promise = fetchAndStoreYear(db, year, source, canRecord, apiKey).finally(() => {
    inFlightYearFetches.delete(key);
  });
  inFlightYearFetches.set(key, promise);
  return promise;
}

export interface DonkiController {
  status(): DonkiProgress;
  start(): Promise<DonkiProgress>;
  cancel(): void;
}

/**
 * The DONKI historical backfill: solar flares, then CME arrivals, year by year
 * from `DONKI_START_YEAR`.
 *
 * Modelled on `createArchiveController` rather than the space-weather
 * controller: DONKI is fetched by explicit year range like the earthquake
 * archive, not one hourly-sample table where presence alone can answer "is
 * this year done" (see the note on migration 9 — a quiet DONKI year is
 * legitimately near-empty, so row presence cannot stand in for bookkeeping
 * here the way it very nearly failed to for OMNI).
 *
 * Flares first: the smaller, cheaper fetch, and useful sooner if the run is
 * interrupted or the shared key's rate limit is hit partway through.
 */
export function createDonkiController(
  db: DatabaseSync,
  onProgress: (progress: DonkiProgress) => void,
  now: () => Date = () => new Date(),
): DonkiController {
  let state: DonkiProgress['state'] = 'idle';
  let phase: DonkiProgress['phase'] = null;
  let currentYear: number | null = null;
  let error: string | null = null;
  let retryAtUtc: string | null = null;
  let running: Promise<DonkiProgress> | null = null;
  const signal = { aborted: false };

  function totalChunks(): number {
    return donkiBackfillYears(now().getUTCFullYear()).length * 2;
  }

  function status(): DonkiProgress {
    const flares = donkiChunkSummary(db, 'flares');
    const cme = donkiChunkSummary(db, 'cme');
    return {
      state,
      phase,
      completedChunks: flares.completedChunks + cme.completedChunks,
      totalChunks: totalChunks(),
      storedFlares: flares.storedEvents,
      storedCmeArrivals: cme.storedEvents,
      currentYear,
      error,
      retryAtUtc,
      hasApiKey: donkiApiKey(db) !== null,
    };
  }

  function publish(): void {
    onProgress(status());
  }

  /**
   * One year for one source, retried on transient failure.
   *
   * A rate limit is not transient on this timescale — three retries a second
   * apart won't outlast an hour-long window — so it is rethrown immediately
   * rather than spending the attempt budget, and handled by `run`'s
   * wait-and-resume loop instead.
   *
   * Records committed and the chunk recorded only after the whole year's
   * fetch succeeds — a failure partway leaves the year unrecorded, and the
   * upsert makes a refetch harmless.
   */
  async function runYear(year: number, source: DonkiSource, canRecord: boolean): Promise<void> {
    // Not transient, so not retried — same reasoning as the rate-limit branch
    // below. The renderer gates Download/Resume on having a key at all, so
    // this is a defensive check rather than an expected path.
    const apiKey = donkiApiKey(db);
    if (apiKey === null) {
      throw new Error('No personal DONKI API key configured');
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
      if (signal.aborted) throw new DonkiCancelledError();
      try {
        await fetchYearOnce(db, year, source, canRecord, apiKey);
        return;
      } catch (caught: unknown) {
        if (caught instanceof DonkiRateLimitError) throw caught;
        lastError = caught;
        if (attempt < CHUNK_ATTEMPTS) {
          await delay(RETRY_BASE_DELAY_MS * attempt);
        }
      }
    }

    throw new Error(
      `DONKI ${source} ${String(year)} failed after ${String(CHUNK_ATTEMPTS)} attempts`,
      { cause: lastError },
    );
  }

  async function runPhase(source: DonkiSource, at: Date): Promise<void> {
    phase = source;
    const done = completedDonkiYears(db, source);
    publish();

    for (const year of donkiBackfillYears(at.getUTCFullYear())) {
      if (signal.aborted) throw new DonkiCancelledError();

      const final = isYearFinal(year, at);
      if (final && done.has(year)) continue;

      currentYear = year;
      publish();
      await runYear(year, source, final);
    }
  }

  /** Polls `signal.aborted` every couple of seconds so Cancel works mid-wait. */
  async function waitForRetry(retryAtMs: number): Promise<void> {
    while (!signal.aborted && Date.now() < retryAtMs) {
      await delay(Math.min(RATE_LIMIT_POLL_MS, retryAtMs - Date.now()));
    }
  }

  async function run(): Promise<DonkiProgress> {
    const at = now();

    state = 'running';
    error = null;
    retryAtUtc = null;
    publish();

    try {
      // Loops rather than running the two phases once: on a rate limit it
      // waits and re-enters both phases, which skip whatever's already
      // recorded and so resume exactly where they stopped — no separate
      // bookkeeping needed for "where was I".
      for (;;) {
        try {
          await runPhase('flares', at);
          await runPhase('cme', at);
          state = 'complete';
          break;
        } catch (caught: unknown) {
          if (!(caught instanceof DonkiRateLimitError)) throw caught;

          const retryAtMs = Date.now() + RATE_LIMIT_RETRY_DELAY_MS;
          state = 'waiting';
          retryAtUtc = new Date(retryAtMs).toISOString();
          publish();

          await waitForRetry(retryAtMs);
          if (signal.aborted) throw new DonkiCancelledError();

          state = 'running';
          retryAtUtc = null;
          publish();
        }
      }
    } catch (caught: unknown) {
      if (caught instanceof DonkiCancelledError) {
        state = 'cancelled';
      } else {
        state = 'failed';
        error = caught instanceof Error ? caught.message : String(caught);
        console.error('DONKI backfill failed', caught);
      }
    } finally {
      currentYear = null;
      phase = null;
      running = null;
      retryAtUtc = null;
      signal.aborted = false;
      publish();
    }

    return status();
  }

  return {
    status,
    start(): Promise<DonkiProgress> {
      running ??= run();
      return running;
    },
    cancel(): void {
      if (running) signal.aborted = true;
    },
  };
}

/**
 * Which calendar years a half-open UTC range touches, **clamped to the years
 * DONKI actually covers**.
 *
 * DONKI is fetched year-by-year (see `runYear`), so any range — however
 * narrow — needs at least the year(s) it falls inside.
 *
 * The lower clamp is load-bearing, and its absence shipped a real bug. This
 * app's playhead reaches back to 1896 (the deep earthquake archive), so
 * scrubbing there with a solar layer on asked `ensureCoverage` for years long
 * before DONKI's 2010 start. Each one fetched nothing, stored nothing, and was
 * then *recorded complete* — leaving phantom rows for 1896-1901 in
 * `donki_chunks`, which `donkiChunkSummary` counts. The visible symptom was
 * the archive panel's progress bar reading **129%** (46 completed chunks
 * against a 34-chunk total, and still climbing). Migration 12 clears the rows
 * this already created; the clamp stops more appearing.
 *
 * **Only the start is clamped**, deliberately. A future end year needs no
 * equivalent guard because `isYearFinal` already refuses to record any year
 * that has not finished, so a fetch past the present can never leave a phantom
 * row behind. Clamping it as well looked tidy and was caught by the existing
 * "more than 2 missing years fetches nothing" test — it would have narrowed a
 * deliberately-wide window back under `LAZY_FETCH_MAX_MISSING_YEARS` and
 * started fetching where the cap says not to.
 */
function yearsInRange(startUtc: string, endUtc: string): number[] {
  const startYear = Math.max(new Date(startUtc).getUTCFullYear(), DONKI_START_YEAR);
  const endYear = new Date(endUtc).getUTCFullYear();
  const years: number[] = [];
  for (let year = startYear; year <= endYear; year += 1) years.push(year);
  return years;
}

/**
 * "Ensure coverage, then read" for the query handlers — the structural fix
 * for both new layers rendering nothing until someone finds the archive
 * panel and clicks Download.
 *
 * Capped at `LAZY_FETCH_MAX_MISSING_YEARS`: every normal window (72h through
 * 1y) touches at most two calendar years, so this is invisible latency with
 * no setup. A wider window that would need more than the cap fetches nothing
 * here and just shows what's cached — never a silent hours-long background
 * fetch with no progress UI. Failures, including a rate limit, are swallowed:
 * a background fetch failing must never break "just show me the layer", the
 * same way a magnetometer station with no reading draws as absent rather
 * than as an error.
 *
 * With no key configured this is a silent no-op — an unconfigured feature
 * isn't a failure, so it logs nothing. The layer just shows whatever's
 * already cached (usually nothing); the layer-toggle gate in the renderer is
 * what actually tells the user a key is needed.
 */
async function ensureCoverage(
  db: DatabaseSync,
  source: DonkiSource,
  startUtc: string,
  endUtc: string,
  at: Date,
): Promise<void> {
  const apiKey = donkiApiKey(db);
  if (apiKey === null) return;

  const done = completedDonkiYears(db, source);
  const missing = yearsInRange(startUtc, endUtc).filter((year) => !done.has(year));

  if (missing.length === 0 || missing.length > LAZY_FETCH_MAX_MISSING_YEARS) return;

  await Promise.all(
    missing.map((year) =>
      fetchYearOnce(db, year, source, isYearFinal(year, at), apiKey).catch((caught: unknown) => {
        console.error(`DONKI lazy fetch failed for ${source} ${String(year)} (will retry later)`, caught);
      }),
    ),
  );
}

export function registerDonkiIpcHandlers(
  db: DatabaseSync,
  controller: DonkiController,
  onUpdated: () => void,
  now: () => Date = () => new Date(),
): void {
  ipcMain.handle(
    'solar-events:query-flares',
    async (_event, request: { startUtc: string; endUtc: string }): Promise<SolarFlare[]> => {
      await ensureCoverage(db, 'flares', request.startUtc, request.endUtc, now());
      return querySolarFlares(db, request.startUtc, request.endUtc);
    },
  );
  ipcMain.handle(
    'solar-events:query-cme-arrivals',
    async (_event, request: { startUtc: string; endUtc: string }): Promise<CmeArrival[]> => {
      await ensureCoverage(db, 'cme', request.startUtc, request.endUtc, now());
      return queryCmeArrivals(db, request.startUtc, request.endUtc);
    },
  );

  ipcMain.handle('solar-events:status', (): DonkiProgress => controller.status());
  ipcMain.handle('solar-events:start', (): Promise<DonkiProgress> => controller.start());
  ipcMain.handle('solar-events:cancel', (): DonkiProgress => {
    controller.cancel();
    return controller.status();
  });

  // Never receives an existing key back — only `hasApiKey` crosses IPC for
  // that, so there is nothing to mask. Saving switches subsequent requests
  // (poll, lazy fetch and backfill alike) onto the personal key.
  ipcMain.handle('solar-events:save-api-key', (_event, key: unknown): DonkiProgress => {
    if (typeof key !== 'string') throw new Error('DONKI API key must be a string');
    saveDonkiApiKey(db, key);
    // A query made before a key existed came back empty and has no reason to
    // run again on its own — `useSolarEvents` only re-queries on a window
    // change or this same signal, which is otherwise just the 30-minute
    // poll. Without this, a layer enabled right after saving a key would sit
    // blank until one of those happens to fire.
    onUpdated();
    return controller.status();
  });
}

/**
 * Keeps the recent catalogue current without waiting on the multi-hour
 * backfill.
 *
 * Fires once immediately, like the other pollers, so the layers aren't blank
 * for 30 minutes after launch. Both endpoints are fetched with
 * `Promise.allSettled` — same shape as `startKpPolling` — so one being down
 * (or rate-limited) doesn't cost the other its update.
 */
export function startDonkiPolling(
  db: DatabaseSync,
  onUpdated: () => void,
  intervalMs: number = DONKI_POLL_INTERVAL_MS,
): () => void {
  let stopped = false;
  let inFlight = false;

  const tick = () => {
    if (inFlight) return;
    // Nothing to poll with — a silent skip, not a failed poll. Retried next
    // interval automatically once a key exists; no error to log.
    const apiKey = donkiApiKey(db);
    if (apiKey === null) return;

    inFlight = true;
    const endUtc = new Date();
    const startUtc = new Date(endUtc.getTime() - POLL_WINDOW_MS);

    void Promise.allSettled([
      fetchSolarFlares(startUtc, endUtc, apiKey),
      fetchCmeArrivals(startUtc, endUtc, apiKey),
    ]).then((results) => {
      inFlight = false;
      if (stopped) return;

      const [flares, arrivals] = results;
      let changed = false;

      if (flares?.status === 'fulfilled') {
        insertSolarFlares(db, flares.value);
        changed = true;
      } else if (flares) {
        console.error('DONKI flare poll failed (will retry)', flares.reason);
      }

      if (arrivals?.status === 'fulfilled') {
        insertCmeArrivals(db, arrivals.value);
        changed = true;
      } else if (arrivals) {
        console.error('DONKI CME poll failed (will retry)', arrivals.reason);
      }

      if (changed) onUpdated();
    });
  };

  tick();
  const timer = setInterval(tick, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
