import { ipcMain } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import { fetchGcmtCombined, fetchGcmtMonth, gcmtMonthlyChunks } from '@terra-pulse/ingest';
import type { GcmtProgress } from '@terra-pulse/schema';
import {
  completedGcmtChunks,
  gcmtChunkSummary,
  insertFocalMechanisms,
  recordGcmtChunk,
} from '@terra-pulse/db';

/**
 * The Global CMT focal-mechanism backfill — H6's orientation source.
 *
 * User-triggered from the archive panel, never automatic, like every other
 * historical record here. It is the cheapest of them by a wide margin (one
 * 8.8 MB request for fifty years), but "cheap" is not the test — fetching a
 * fifty-year archive on someone's behalf at launch is not a thing to start
 * doing quietly.
 *
 * ## Modelled on `goes-flares.ts`, with one thing it does not have
 *
 * No API key, no rate limiting, no poller — the same three absences, for the
 * same reasons. What is genuinely different is that **this record is not
 * closed**, unlike the GOES reports which stop at 2016. So there is a
 * current-year path, and it has a wrinkle the earthquake archive's does not:
 *
 * **Global CMT publishes on a three-to-four-month delay.** The monthly files
 * for the most recent months do not exist yet, and asking for one returns 404.
 * That is not a failure and must not be retried into one — `fetchGcmtMonth`
 * returns null, the chunk is left unrecorded, and a later run picks it up. It
 * is counted as `pendingMonths` and surfaced, because otherwise a completely
 * successful download leaves the progress bar short of full and reads as
 * broken.
 *
 * Measured against the live service on 2026-08-22: `jan26`, `feb26` and
 * `mar26` return 200, and `apr26` onward return 404 — a four-month lag. So
 * **every real run ends with pending months**, and this is the ordinary path
 * rather than an edge case. H6 spans fifty years, so the missing tail changes
 * nothing it can say.
 *
 * The same probe found `jan76_dec24.ndk.gz` already **404** while `dec25` is
 * served, which is worth knowing: the combined file is *replaced*, not
 * accumulated, so the fallback candidates in `gcmtCombinedCandidates` earn
 * their keep only in the window after New Year and before the new file lands.
 *
 * ## Order
 *
 * The combined file first, then the months, oldest first. The combined file is
 * 99.9% of the record, so a run that is interrupted after it has still done
 * essentially all the work — the same "cheap work first" reasoning that puts
 * the deep earthquake tier before the M4.5+ one.
 */
const CHUNK_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Raised to unwind the loop on Cancel, the same idiom the other controllers use. */
class GcmtCancelledError extends Error {
  constructor() {
    super('Global CMT backfill cancelled');
    this.name = 'GcmtCancelledError';
  }
}

export interface GcmtController {
  status(): GcmtProgress;
  start(): Promise<GcmtProgress>;
  cancel(): void;
}

export function createGcmtController(
  db: DatabaseSync,
  onProgress: (progress: GcmtProgress) => void,
  now: () => Date = () => new Date(),
): GcmtController {
  let state: GcmtProgress['state'] = 'idle';
  let currentChunk: string | null = null;
  let pendingMonths = 0;
  let error: string | null = null;
  let running: Promise<GcmtProgress> | null = null;
  const signal = { aborted: false };

  function status(): GcmtProgress {
    // Read from the database rather than run-local counters, so a status call
    // before any run in this session still reports what is already stored.
    const summary = gcmtChunkSummary(db);
    return {
      state,
      completedChunks: summary.completedChunks,
      // The combined file plus however many months of the current year have
      // finished. Recomputed per call rather than captured at construction: a
      // long-running app crosses a month boundary.
      totalChunks: 1 + gcmtMonthlyChunks(now()).length,
      storedMechanisms: summary.storedEvents,
      currentChunk,
      pendingMonths,
      error,
    };
  }

  function publish(): void {
    onProgress(status());
  }

  /**
   * Retries a unit of work on transient failure.
   *
   * The chunk is recorded only after the mechanisms are committed, so a failure
   * partway leaves it unrecorded and the refetch is harmless — every insert is
   * an upsert on the GCMT event name.
   */
  async function attempt(label: string, work: () => Promise<number | null>): Promise<void> {
    let lastError: unknown;
    for (let tries = 1; tries <= CHUNK_ATTEMPTS; tries += 1) {
      if (signal.aborted) throw new GcmtCancelledError();
      try {
        await work();
        return;
      } catch (caught: unknown) {
        lastError = caught;
        if (tries < CHUNK_ATTEMPTS) await delay(RETRY_BASE_DELAY_MS * tries);
      }
    }
    throw new Error(`Global CMT ${label} failed after ${String(CHUNK_ATTEMPTS)} attempts`, {
      cause: lastError,
    });
  }

  async function run(): Promise<GcmtProgress> {
    state = 'running';
    error = null;
    pendingMonths = 0;
    publish();

    try {
      const done = completedGcmtChunks(db);

      // The combined file is skipped only if this exact name is already
      // recorded. When the year turns and a newer name appears, it is fetched
      // again — 8.8 MB to gain a year, and every insert is an upsert, so the
      // overlap costs nothing but time.
      const alreadyHaveCombined = [...done].some((chunk) => chunk.startsWith('jan76_'));
      if (!alreadyHaveCombined) {
        currentChunk = 'catalogue 1976 onward';
        publish();
        await attempt('combined catalogue', async () => {
          const fetched = await fetchGcmtCombined(fetch, now());
          insertFocalMechanisms(db, fetched.mechanisms);
          recordGcmtChunk(db, fetched.chunk.chunk, fetched.mechanisms.length);
          return fetched.mechanisms.length;
        });
        publish();
      }

      for (const chunk of gcmtMonthlyChunks(now())) {
        if (signal.aborted) throw new GcmtCancelledError();
        if (done.has(chunk.chunk)) continue;

        currentChunk = chunk.chunk;
        publish();
        await attempt(chunk.chunk, async () => {
          const mechanisms = await fetchGcmtMonth(chunk.year, chunk.month, fetch);
          if (mechanisms === null) {
            // Not published yet. Deliberately not recorded, so a later run
            // fetches it — see the note at the top of this file.
            pendingMonths += 1;
            return null;
          }
          insertFocalMechanisms(db, mechanisms);
          recordGcmtChunk(db, chunk.chunk, mechanisms.length);
          return mechanisms.length;
        });
        publish();
      }

      state = 'complete';
    } catch (caught: unknown) {
      if (caught instanceof GcmtCancelledError) {
        state = 'cancelled';
      } else {
        state = 'failed';
        error = caught instanceof Error ? caught.message : String(caught);
        console.error('Global CMT backfill failed', caught);
      }
    } finally {
      currentChunk = null;
      running = null;
      signal.aborted = false;
      publish();
    }

    return status();
  }

  return {
    status,
    start(): Promise<GcmtProgress> {
      running ??= run();
      return running;
    },
    cancel(): void {
      if (running) signal.aborted = true;
    },
  };
}

export function registerGcmtIpcHandlers(controller: GcmtController): void {
  ipcMain.handle('gcmt:status', (): GcmtProgress => controller.status());
  ipcMain.handle('gcmt:start', (): Promise<GcmtProgress> => controller.start());
  ipcMain.handle('gcmt:cancel', (): GcmtProgress => {
    controller.cancel();
    return controller.status();
  });
}
