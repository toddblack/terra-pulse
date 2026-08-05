import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { backupPathFor, openDatabase } from './client';
import { runMigrations } from './migrate';
import { migrations } from './migrations';

describe('openDatabase', () => {
  it('creates the earthquakes table and the rtree spatial index against an in-memory db', () => {
    const db = openDatabase(':memory:');

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table') AND name IN ('earthquakes', 'earthquakes_rtree')",
      )
      .all();
    expect(tables.map((t) => t['name'])).toEqual(
      expect.arrayContaining(['earthquakes', 'earthquakes_rtree']),
    );
  });

  it('is idempotent — re-running migrations against the same db skips already-applied ones', () => {
    const db = openDatabase(':memory:');

    // If this tried to re-run migration 1, CREATE TABLE would throw on the
    // already-existing table — not throwing confirms the skip logic works.
    expect(() => runMigrations(db)).not.toThrow();

    // Against migrations.length rather than a literal, so adding a migration
    // doesn't require editing this assertion.
    const appliedCount = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get();
    expect(appliedCount?.['count']).toBe(migrations.length);
  });
});

describe('pre-migration backup', () => {
  const dirs: string[] = [];

  function tempDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'terra-pulse-db-'));
    dirs.push(dir);
    return join(dir, 'terra-pulse.sqlite');
  }

  /**
   * A database file left partway through the migration list — migration 1 done,
   * everything after it pending — which is the state that triggers a backup.
   */
  function halfMigratedFile(path: string): void {
    const db = new DatabaseSync(path);
    runMigrations(db, [migrations[0]!]);
    db.prepare(
      `INSERT INTO earthquakes
         (usgs_id, magnitude, magnitude_type, place, time_utc, updated_utc,
          longitude, latitude, depth_km, status, tsunami, significance, url)
       VALUES ('precious', 7.1, 'mww', 'Nowhere', '1970-01-01T00:00:00.000Z',
               '1970-01-01T00:00:00.000Z', 0, 0, 10, 'reviewed', 0, 1, 'https://x')`,
    ).run();
    db.close();
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('snapshots the database before applying a pending migration', () => {
    const path = tempDbPath();
    halfMigratedFile(path);

    openDatabase(path).close();

    expect(existsSync(backupPathFor(path))).toBe(true);
  });

  it('captures the state from before the migration, not after', () => {
    const path = tempDbPath();
    halfMigratedFile(path);

    // Migration 2 drops the earthquakes table. That is safe today only because
    // the catalogue refetches itself; this asserts the property that has to
    // hold once it does not — whatever a migration destroys is still in the
    // snapshot afterwards.
    openDatabase(path).close();

    const backup = new DatabaseSync(backupPathFor(path));
    const rows = backup.prepare('SELECT usgs_id FROM earthquakes').all();
    backup.close();

    expect(rows.map((r) => r['usgs_id'])).toEqual(['precious']);
  });

  it('does not write a backup when the schema is already current', () => {
    const path = tempDbPath();
    openDatabase(path).close(); // creates the file, applies everything

    rmSync(backupPathFor(path), { force: true });
    openDatabase(path).close(); // nothing pending this time

    expect(existsSync(backupPathFor(path))).toBe(false);
  });

  it('does not write a backup when creating the database from scratch', () => {
    const path = tempDbPath();

    openDatabase(path).close();

    // Every migration is pending on a new file, but there is nothing to lose.
    expect(existsSync(backupPathFor(path))).toBe(false);
  });
});
