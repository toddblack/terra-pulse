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

/**
 * A personal NASA DONKI API key, if the user has saved one.
 *
 * Lives here rather than `.env`, which is the only mechanism that survives
 * packaging — `dotenv.config()`'s path resolves relative to the main
 * process bundle and only lands on a real `.env` file in dev. `.env` stays a
 * lower-priority dev convenience underneath this.
 */
const DONKI_API_KEY_KEY = 'nasa_donki_api_key';

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

/** `null` when no personal key has been saved. */
export function readDonkiApiKey(db: DatabaseSync): string | null {
  return readAppState(db, DONKI_API_KEY_KEY);
}

/** Trims the input and rejects an empty key rather than saving a blank string. */
export function saveDonkiApiKey(db: DatabaseSync, key: string): void {
  const trimmed = key.trim();
  if (trimmed.length === 0) throw new Error('DONKI API key cannot be empty');
  writeAppState(db, DONKI_API_KEY_KEY, trimmed);
}
