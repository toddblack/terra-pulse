import { ipcMain } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import { fetchCmeArrivals, fetchSolarFlares } from '@terra-pulse/ingest';
import { DONKI_START_YEAR, type CmeArrival, type DonkiProgress, type SolarFlare } from '@terra-pulse/schema';
import {
  completedDonkiYears,
  donkiChunkSummary,
  insertCmeArrivals,
  insertSolarFlares,
  queryCmeArrivals,
  querySolarFlares,
  recordDonkiChunk,
  type DonkiSource,
} from '@terra-pulse/db';

/** How often the live tail is refreshed. Flares and CMEs are not minute-scale events. */
const DONKI_POLL_INTERVAL_MS = 30 * 60_000;

/** How far back the live poll looks, wide enough to overlap the previous poll comfortably. */
const POLL_WINDOW_MS = 3 * 24 * 60_000 * 60;

/** Transient failures happen on a multi-minute run; one bad year shouldn't end it. */
const CHUNK_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    };
  }

  function publish(): void {
    onProgress(status());
  }

  /**
   * One year for one source, retried on transient failure.
   *
   * Records committed and the chunk recorded only after the whole year's
   * fetch succeeds — a failure partway leaves the year unrecorded, and the
   * upsert makes a refetch harmless.
   */
  async function runYear(
    year: number,
    source: DonkiSource,
    canRecord: boolean,
  ): Promise<void> {
    const startUtc = new Date(`${String(year)}-01-01T00:00:00.000Z`);
    const endUtc = new Date(`${String(year + 1)}-01-01T00:00:00.000Z`);

    let lastError: unknown;
    for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
      if (signal.aborted) throw new DonkiCancelledError();
      try {
        if (source === 'flares') {
          const flares = await fetchSolarFlares(startUtc, endUtc);
          insertSolarFlares(db, flares);
          if (canRecord) recordDonkiChunk(db, year, source, flares.length);
        } else {
          const arrivals = await fetchCmeArrivals(startUtc, endUtc);
          insertCmeArrivals(db, arrivals);
          if (canRecord) recordDonkiChunk(db, year, source, arrivals.length);
        }
        return;
      } catch (caught: unknown) {
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

  async function run(): Promise<DonkiProgress> {
    const at = now();

    state = 'running';
    error = null;
    publish();

    try {
      await runPhase('flares', at);
      await runPhase('cme', at);
      state = 'complete';
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

export function registerDonkiIpcHandlers(db: DatabaseSync, controller: DonkiController): void {
  ipcMain.handle(
    'solar-events:query-flares',
    (_event, request: { startUtc: string; endUtc: string }): SolarFlare[] =>
      querySolarFlares(db, request.startUtc, request.endUtc),
  );
  ipcMain.handle(
    'solar-events:query-cme-arrivals',
    (_event, request: { startUtc: string; endUtc: string }): CmeArrival[] =>
      queryCmeArrivals(db, request.startUtc, request.endUtc),
  );

  ipcMain.handle('solar-events:status', (): DonkiProgress => controller.status());
  ipcMain.handle('solar-events:start', (): Promise<DonkiProgress> => controller.start());
  ipcMain.handle('solar-events:cancel', (): DonkiProgress => {
    controller.cancel();
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
    inFlight = true;

    const endUtc = new Date();
    const startUtc = new Date(endUtc.getTime() - POLL_WINDOW_MS);

    void Promise.allSettled([
      fetchSolarFlares(startUtc, endUtc),
      fetchCmeArrivals(startUtc, endUtc),
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
