import type { DatabaseSync } from 'node:sqlite';

/**
 * Small scalars that have to outlive a run.
 *
 * Deliberately not a general settings system. Right now there is exactly one
 * key, and inventing a preferences layer for it would be scaffolding ahead of
 * need.
 */

/**
 * How far through the catalogue the user has actually seen.
 *
 * Advanced on every successful poll rather than on quit, so a crash or a
 * force-quit costs at most one poll interval instead of replaying a whole
 * session's events as "missed". "The last moment the app was demonstrably
 * running and healthy" is the honest reading of it.
 */
const SEEN_THROUGH_KEY = 'seen_through_utc';

export function readAppState(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
  return (row?.['value'] as string | undefined) ?? null;
}

export function writeAppState(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

/** `null` on a first-ever launch — there is nothing you can have missed yet. */
export function readSeenThrough(db: DatabaseSync): string | null {
  return readAppState(db, SEEN_THROUGH_KEY);
}

export function writeSeenThrough(db: DatabaseSync, utc: string): void {
  writeAppState(db, SEEN_THROUGH_KEY, utc);
}
