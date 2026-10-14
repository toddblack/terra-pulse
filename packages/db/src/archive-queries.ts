import type { DatabaseSync } from 'node:sqlite';
import {
  ARCHIVE_MIN_MAGNITUDE,
  ARCHIVE_START_YEAR,
  DEEP_ARCHIVE_MIN_MAGNITUDE,
  longestCoverageHours,
  type ArchiveChunk,
} from '@terra-pulse/schema';

/**
 * Bookkeeping for the historical archive backfill.
 *
 * The events themselves go in `earthquakes` like everything else — this table
 * only records *which years have been fully fetched*, which is what makes an
 * interrupted backfill resumable rather than restartable.
 *
 * Nothing here infers completion from the event rows. "The year 1993 has 3,102
 * events in the table" does not distinguish a finished chunk from one that
 * failed three quarters of the way through, and guessing wrong means a
 * permanent silent hole in the archive.
 */
export interface CompletedChunk {
  year: number;
  eventCount: number;
  completedAt: string;
}

/**
 * Marks a chunk done. Call only once its events are committed — this row is the
 * claim that the year is complete, and it needs to be true.
 */
export function recordArchiveChunk(
  db: DatabaseSync,
  chunk: ArchiveChunk,
  minMagnitude: number,
  eventCount: number,
): void {
  db.prepare(
    `INSERT INTO archive_chunks
       (year, start_utc, end_utc, min_magnitude, event_count, completed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(year) DO UPDATE SET
       start_utc = excluded.start_utc,
       end_utc = excluded.end_utc,
       min_magnitude = excluded.min_magnitude,
       event_count = excluded.event_count,
       completed_at = excluded.completed_at`,
  ).run(
    chunk.year,
    chunk.startUtc,
    chunk.endUtc,
    minMagnitude,
    eventCount,
    new Date().toISOString(),
  );
}

/**
 * Years already fetched at a floor at least as low as `minMagnitude`.
 *
 * The floor comparison matters for re-runs at a *lower* floor: a year fetched
 * at M5.5 does not satisfy a request for M4.5, and treating it as done would
 * leave a hole shaped exactly like the difference between the two. A year
 * fetched at M4.5 does satisfy a request for M5.5, so that direction is kept.
 */
export function completedArchiveYears(db: DatabaseSync, minMagnitude: number): Set<number> {
  const rows = db
    .prepare('SELECT year FROM archive_chunks WHERE min_magnitude <= ?')
    .all(minMagnitude);

  return new Set(rows.map((row) => row['year'] as number));
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Years in `[startMs, endMs]` the catalogue does not hold.
 *
 * Three ways a year can be covered, and all three are needed:
 *
 * - It is a completed archive chunk. The direct case.
 * - The window's overlap with it falls inside the rolling cache, which runs
 *   below M4.5 and so contains everything the archive would. A sequence from
 *   last week is fully visible with no archive downloaded at all.
 * - It is the current year and the archive is non-empty. The archive refetches
 *   the current year on every run precisely because it is never complete, so
 *   the data is there; it just cannot be recorded as a finished chunk. Inferred
 *   rather than proven, which is why it is spelled out here.
 *
 * `endMs` must already be clamped to now by the caller. An M9's window runs
 * ~1,070 days, so a 2025 mainshock reaches into 2028 — and reporting 2027 as a
 * gap in the archive would be true and completely useless.
 *
 * ## `deepTierCounts`
 *
 * Before 1970 the archive is the deep tier: M7.5+ and nothing below. Whether
 * such a year is "held" depends on who is asking.
 *
 * - **Off (the default)** asks about M4.5+. A pre-1970 year is then always
 *   missing, which is right for a count made at M4.5+: the aftershock panel's
 *   number for a 1960 mainshock really is a lower bound.
 * - **On** asks whether the year holds what the archive is *meant* to hold
 *   there. That is the question a view of the globe has: a 1960 date range
 *   with the deep tier downloaded is showing everything there is to show, and
 *   calling it "not downloaded" would send the reader to a button that has
 *   nothing left to fetch.
 */
export function uncoveredArchiveYears(
  db: DatabaseSync,
  startMs: number,
  endMs: number,
  nowMs: number,
  options: { deepTierCounts?: boolean } = {},
): number[] {
  const mainYears = completedArchiveYears(db, ARCHIVE_MIN_MAGNITUDE);
  const deepYears = options.deepTierCounts
    ? completedArchiveYears(db, DEEP_ARCHIVE_MIN_MAGNITUDE)
    : mainYears;
  const archiveDownloaded = mainYears.size > 0;
  const currentYear = new Date(nowMs).getUTCFullYear();
  const rollingCacheStartMs = nowMs - longestCoverageHours() * HOUR_MS;

  const missing: number[] = [];
  const firstYear = new Date(startMs).getUTCFullYear();
  const lastYear = new Date(endMs).getUTCFullYear();

  for (let year = firstYear; year <= lastYear; year += 1) {
    if ((year < ARCHIVE_START_YEAR ? deepYears : mainYears).has(year)) continue;
    if (year === currentYear && archiveDownloaded) continue;

    // Does this year's slice of the window sit entirely in the rolling cache?
    const yearStartMs = Date.UTC(year, 0, 1);
    const yearEndMs = Date.UTC(year + 1, 0, 1) - 1;
    const sliceStartMs = Math.max(startMs, yearStartMs);
    const sliceEndMs = Math.min(endMs, yearEndMs);
    if (sliceStartMs >= rollingCacheStartMs && sliceEndMs <= nowMs) continue;

    missing.push(year);
  }

  return missing;
}

export function archiveChunkSummary(
  db: DatabaseSync,
  minMagnitude: number,
): { completedChunks: number; storedEvents: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS chunks, COALESCE(SUM(event_count), 0) AS events
       FROM archive_chunks WHERE min_magnitude <= ?`,
    )
    .get(minMagnitude);

  return {
    completedChunks: Number(row?.['chunks'] ?? 0),
    storedEvents: Number(row?.['events'] ?? 0),
  };
}

/** Every recorded chunk, oldest first — for showing what the archive holds. */
export function listArchiveChunks(db: DatabaseSync): CompletedChunk[] {
  return db
    .prepare('SELECT year, event_count, completed_at FROM archive_chunks ORDER BY year')
    .all()
    .map((row) => ({
      year: row['year'] as number,
      eventCount: row['event_count'] as number,
      completedAt: row['completed_at'] as string,
    }));
}
