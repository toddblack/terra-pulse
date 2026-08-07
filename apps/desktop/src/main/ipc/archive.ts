import { ipcMain } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import {
  archiveChunkSummary,
  completedArchiveYears,
  insertEarthquakes,
  recordArchiveChunk,
} from '@terra-pulse/db';
import { ArchiveCancelledError, fetchArchiveChunk } from '@terra-pulse/ingest';
import {
  ARCHIVE_MIN_MAGNITUDE,
  DEEP_ARCHIVE_MIN_MAGNITUDE,
  archiveChunks,
  deepArchiveChunks,
  type ArchiveChunk,
  type ArchiveProgress,
} from '@terra-pulse/schema';

/**
 * The Tier 1 historical backfill — PROJECT_PLAN §Storage.
 *
 * User-triggered, never automatic: it is ~295k events and a few minutes of
 * requests, which is not something to start on someone's behalf on first launch.
 *
 * Chunks run **sequentially and unthrottled**. Sequential is the politeness
 * here — one in-flight request against a free public service, for a job that
 * runs once. Firing 57 years in parallel would finish sooner and be a much
 * worse thing to do to USGS.
 */

/** Transient failures happen on a multi-minute run; one bad year shouldn't end it. */
const CHUNK_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a year is over, and therefore whether "complete" can be recorded.
 *
 * **The current year is never recorded complete**, because it isn't — it is
 * still accruing events, and a row claiming otherwise would freeze the archive
 * at whatever today happened to be, permanently. It is refetched on every run
 * instead, which costs one request and keeps the span from January 1 to the
 * rolling cache's 30-day window filled in.
 */
function isYearFinal(year: number, now: Date): boolean {
  return year < now.getUTCFullYear();
}

export interface ArchiveController {
  status(): ArchiveProgress;
  start(): Promise<ArchiveProgress>;
  cancel(): void;
}

export function createArchiveController(
  db: DatabaseSync,
  onProgress: (progress: ArchiveProgress) => void,
  now: () => Date = () => new Date(),
): ArchiveController {
  /**
   * The backfill runs in **two tiers**, each a floor over a different span.
   *
   * The deep tier is M7.5+ from 1900, where global instrumental completeness
   * begins for events that size; the main tier is M4.5+ from 1970. They never
   * overlap — the deep chunks stop at 1969 — so the same `archive_chunks` table
   * records both, and `completedArchiveYears(db, floor)` resolves each correctly
   * because it matches on `min_magnitude <= floor`.
   *
   * Deep first: 70 years at M7.5+ is 262 events against the main tier's ~295,000,
   * so the cheap work lands first and an interrupted run still leaves the whole
   * large-event record in place.
   */
  function plannedChunks(at: Date): { chunk: ArchiveChunk; minMagnitude: number }[] {
    return [
      ...deepArchiveChunks().map((chunk) => ({
        chunk,
        minMagnitude: DEEP_ARCHIVE_MIN_MAGNITUDE,
      })),
      ...archiveChunks(at.getUTCFullYear()).map((chunk) => ({
        chunk,
        minMagnitude: ARCHIVE_MIN_MAGNITUDE,
      })),
    ];
  }

  let state: ArchiveProgress['state'] = 'idle';
  let currentYear: number | null = null;
  let error: string | null = null;
  let running: Promise<ArchiveProgress> | null = null;
  const signal = { aborted: false };

  function totalChunks(): number {
    return plannedChunks(now()).length;
  }

  function status(): ArchiveProgress {
    // Counts both tiers: the query matches `min_magnitude <= ?`, so the deeper
    // floor is the one that includes everything.
    const summary = archiveChunkSummary(db, DEEP_ARCHIVE_MIN_MAGNITUDE);
    return {
      state,
      completedChunks: summary.completedChunks,
      totalChunks: totalChunks(),
      storedEvents: summary.storedEvents,
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
   * Events are inserted and the chunk recorded only after the *whole* year has
   * been fetched — `fetchArchiveChunk` resolves only with a complete chunk, so
   * a failure partway leaves the year unrecorded and the next run refetches it.
   * The upsert makes that repetition free.
   */
  async function runChunk(
    chunk: ArchiveChunk,
    minMagnitude: number,
    canRecord: boolean,
  ): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
      try {
        const events = await fetchArchiveChunk({ chunk, minMagnitude, signal });
        insertEarthquakes(db, events);
        if (canRecord) recordArchiveChunk(db, chunk, minMagnitude, events.length);
        return;
      } catch (caught: unknown) {
        // Cancellation is not a failure to retry through.
        if (caught instanceof ArchiveCancelledError) throw caught;
        lastError = caught;
        if (attempt < CHUNK_ATTEMPTS) {
          await delay(RETRY_BASE_DELAY_MS * attempt);
        }
      }
    }

    throw new Error(`Archive chunk ${String(chunk.year)} failed after ${String(CHUNK_ATTEMPTS)} attempts`, {
      cause: lastError,
    });
  }

  async function run(): Promise<ArchiveProgress> {
    const at = now();
    const chunks = plannedChunks(at);

    state = 'running';
    error = null;
    publish();

    try {
      for (const { chunk, minMagnitude } of chunks) {
        if (signal.aborted) throw new ArchiveCancelledError();

        const final = isYearFinal(chunk.year, at);
        // Resolved per tier, because "already fetched" means "at a floor at
        // least as low as this one" — a year held only at M7.5 does not satisfy
        // an M4.5 request, and treating it as done would leave a hole shaped
        // exactly like the difference between the two.
        const done = completedArchiveYears(db, minMagnitude);
        // A finished year already recorded needs nothing. The current year is
        // never "already done" — see isYearFinal.
        if (final && done.has(chunk.year)) continue;

        currentYear = chunk.year;
        publish();

        await runChunk(chunk, minMagnitude, final);
      }

      state = 'complete';
    } catch (caught: unknown) {
      if (caught instanceof ArchiveCancelledError) {
        state = 'cancelled';
      } else {
        state = 'failed';
        error = caught instanceof Error ? caught.message : String(caught);
        console.error('Archive backfill failed', caught);
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
    /**
     * Idempotent while running: a second call returns the in-flight run rather
     * than starting a competing one. Two concurrent backfills would double
     * every request and race on the bookkeeping rows.
     */
    start(): Promise<ArchiveProgress> {
      running ??= run();
      return running;
    },
    cancel(): void {
      // Only meaningful mid-run; the flag clears itself when the run settles.
      if (running) signal.aborted = true;
    },
  };
}

export function registerArchiveIpcHandlers(controller: ArchiveController): void {
  ipcMain.handle('archive:status', (): ArchiveProgress => controller.status());
  ipcMain.handle('archive:start', (): Promise<ArchiveProgress> => controller.start());
  ipcMain.handle('archive:cancel', (): ArchiveProgress => {
    controller.cancel();
    return controller.status();
  });
}
