import type { DatabaseSync } from 'node:sqlite';
import type { ArchiveChunk } from '@terra-pulse/schema';

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
