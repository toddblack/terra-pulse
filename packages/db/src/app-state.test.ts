import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { deleteAppState, readAppState, readSeenThrough, writeAppState, writeSeenThrough } from './app-state';
import { runMigrations } from './migrate';
import { migrations } from './migrations';

describe('app_state', () => {
  it('reads null for a key never written', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);
    expect(readAppState(db, 'nothing-here')).toBeNull();
    expect(readSeenThrough(db)).toBeNull();
  });

  it('round-trips a value, and a later write replaces an earlier one', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);
    writeSeenThrough(db, '2026-10-01T00:00:00.000Z');
    writeSeenThrough(db, '2026-10-02T00:00:00.000Z');
    expect(readSeenThrough(db)).toBe('2026-10-02T00:00:00.000Z');
  });

  it('deletes a key back to null, leaving the others', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);
    writeAppState(db, 'quake_watch_pin', '{}');
    writeSeenThrough(db, '2026-10-02T00:00:00.000Z');
    deleteAppState(db, 'quake_watch_pin');
    deleteAppState(db, 'never-written');
    expect(readAppState(db, 'quake_watch_pin')).toBeNull();
    expect(readSeenThrough(db)).toBe('2026-10-02T00:00:00.000Z');
  });
});

describe('migration 14 — forget the DONKI API key', () => {
  it('deletes a saved key and leaves everything else in app_state alone', () => {
    // An install from before DONKI moved to its keyless endpoint: migrated up
    // to 13, with a personal key saved under the key name the app used.
    const db = new DatabaseSync(':memory:');
    runMigrations(db, migrations.filter((m) => m.id <= 13));
    writeAppState(db, 'nasa_donki_api_key', 'personal-key-123');
    writeSeenThrough(db, '2026-10-02T00:00:00.000Z');

    runMigrations(db);

    expect(readAppState(db, 'nasa_donki_api_key')).toBeNull();
    expect(readSeenThrough(db)).toBe('2026-10-02T00:00:00.000Z');
  });
});
