import { ipcMain } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import { fetchGoesFlareYear, goesFlareYears } from '@terra-pulse/ingest';
import type { GoesFlareProgress } from '@terra-pulse/schema';
import {
  completedGoesFlareYears,
  goesFlareChunkSummary,
  insertSolarFlares,
  recordGoesFlareChunk,
} from '@terra-pulse/db';

/**
 * The NOAA GOES XRS historical flare backfill — H1b's registered source below
 * 2017, and the deep half of a record whose recent half already arrives via
 * DONKI.
 *
 * ## Deliberately simpler than `nasa-donki.ts`, which it is modelled on
 *
 * Three whole mechanisms are absent, and each is absent for a reason rather
 * than as an omission:
 *
 * - **No API key.** NOAA serves these files anonymously, so there is no
 *   `hasApiKey` gate, no key modal, and no "configured?" check before a fetch.
 * - **No rate limiting.** DONKI's controller wraps its phases in a `for(;;)`
 *   that waits an hour on a 429 and re-enters. Nothing here can return one, so
 *   there is no `'waiting'` state, no `retryAtUtc`, and no wait loop.
 * - **No current-year special case.** Every other backfill in this app has to
 *   avoid recording the year in progress as complete, because it isn't. This
 *   record is **closed at 2016** — every year in range is final and recordable,
 *   which is why there is no `isYearFinal` here and why `totalChunks` is a
 *   constant 21.
 *
 * What is kept is the part that matters: fetch, insert, *then* record the
 * chunk, so a failure partway leaves the year unrecorded and a refetch is
 * harmless. Resume is the same mechanism as everywhere else — re-enter the loop
 * and skip what `goes_flare_chunks` already holds. There is no separate "where
 * was I" state to get wrong.
 *
 * ## No poller
 *
 * The other solar-events ingest polls every thirty minutes for new records.
 * This one cannot: the reports stop at 2016 and will never gain a row.
 */
const CHUNK_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Raised to unwind the loop on Cancel, the same idiom the other controllers use. */
class GoesFlaresCancelledError extends Error {
  constructor() {
    super('GOES flare backfill cancelled');
    this.name = 'GoesFlaresCancelledError';
  }
}

export interface GoesFlareController {
  status(): GoesFlareProgress;
  start(): Promise<GoesFlareProgress>;
  cancel(): void;
}

export function createGoesFlareController(
  db: DatabaseSync,
  onProgress: (progress: GoesFlareProgress) => void,
): GoesFlareController {
  let state: GoesFlareProgress['state'] = 'idle';
  let currentYear: number | null = null;
  let error: string | null = null;
  let running: Promise<GoesFlareProgress> | null = null;
  const signal = { aborted: false };

  const totalChunks = goesFlareYears().length;

  function status(): GoesFlareProgress {
    // Read from the database rather than from run-local counters, so a status
    // call before any run in this session still reports what is already stored.
    const summary = goesFlareChunkSummary(db);
    return {
      state,
      completedChunks: summary.completedChunks,
      totalChunks,
      storedFlares: summary.storedEvents,
      currentYear,
      error,
    };
  }

  function publish(): void {
    onProgress(status());
  }

  /**
   * One year, retried on transient failure.
   *
   * The chunk is recorded only after the flares are committed — a failure
   * partway leaves the year unrecorded, and the upsert on flare id makes the
   * refetch harmless.
   */
  async function runYear(year: number): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
      if (signal.aborted) throw new GoesFlaresCancelledError();
      try {
        const flares = await fetchGoesFlareYear(year);
        insertSolarFlares(db, flares);
        recordGoesFlareChunk(db, year, flares.length);
        return;
      } catch (caught: unknown) {
        lastError = caught;
        if (attempt < CHUNK_ATTEMPTS) {
          await delay(RETRY_BASE_DELAY_MS * attempt);
        }
      }
    }

    throw new Error(
      `NOAA GOES XRS ${String(year)} failed after ${String(CHUNK_ATTEMPTS)} attempts`,
      { cause: lastError },
    );
  }

  async function run(): Promise<GoesFlareProgress> {
    state = 'running';
    error = null;
    publish();

    try {
      const done = completedGoesFlareYears(db);
      for (const year of goesFlareYears()) {
        if (signal.aborted) throw new GoesFlaresCancelledError();
        if (done.has(year)) continue;

        currentYear = year;
        publish();
        await runYear(year);
        publish();
      }
      state = 'complete';
    } catch (caught: unknown) {
      if (caught instanceof GoesFlaresCancelledError) {
        state = 'cancelled';
      } else {
        state = 'failed';
        error = caught instanceof Error ? caught.message : String(caught);
        console.error('GOES flare backfill failed', caught);
      }
    } finally {
      currentYear = null;
      running = null;
      signal.aborted = false;
      publish();
    }

    return status();
  }

  return {
    status,
    start(): Promise<GoesFlareProgress> {
      running ??= run();
      return running;
    },
    cancel(): void {
      if (running) signal.aborted = true;
    },
  };
}

export function registerGoesFlareIpcHandlers(
  controller: GoesFlareController,
  onUpdated: () => void,
): void {
  ipcMain.handle('goes-flares:status', (): GoesFlareProgress => controller.status());

  ipcMain.handle('goes-flares:start', async (): Promise<GoesFlareProgress> => {
    const progress = await controller.start();
    // The flare layer only re-queries on a window change or this signal, so
    // without it a completed download would sit invisible until something else
    // happened to refresh.
    onUpdated();
    return progress;
  });

  ipcMain.handle('goes-flares:cancel', (): GoesFlareProgress => {
    controller.cancel();
    return controller.status();
  });
}
