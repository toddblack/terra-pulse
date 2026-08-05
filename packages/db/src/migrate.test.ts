import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { EarthquakeEvent } from '@terra-pulse/schema';
import { openDatabase } from './client';
import { pendingMigrations, runMigrations } from './migrate';
import { migrations, type Migration } from './migrations';
import { insertEarthquakes, queryEarthquakes, queryEarthquakesInBoundingBox } from './queries';

function makeEvent(overrides: Partial<EarthquakeEvent> = {}): EarthquakeEvent {
  return {
    id: 'us0001',
    source: 'usgs',
    magnitude: 5.2,
    magnitudeType: 'mb',
    place: '10km SSW of Somewhere',
    timeUtc: '2026-07-20T12:00:00.000Z',
    updatedUtc: '2026-07-20T12:05:00.000Z',
    longitude: -112.14,
    latitude: 36.05,
    depthKm: 10,
    status: 'reviewed',
    tsunami: false,
    alertLevel: null,
    significance: 400,
    url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us0001',
    ...overrides,
  };
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Number(row?.['count'] ?? 0) > 0;
}

/**
 * The create-copy-drop-rename shape that every schema change from migration 3
 * onward has to use, documented at the top of `migrations.ts`. This adds a
 * column, which is the cheap case — but it is written the expensive way on
 * purpose, because the expensive way is what a nullability or type change
 * forces, and this test is here to prove that shape keeps its rows.
 */
const REBUILD_PRESERVING_DATA: Migration = {
  id: 900,
  name: 'test_rebuild_preserving_data',
  sql: `
    CREATE TABLE earthquakes_new (
      row_id INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      magnitude REAL NOT NULL,
      magnitude_type TEXT NOT NULL,
      place TEXT NOT NULL,
      time_utc TEXT NOT NULL,
      updated_utc TEXT NOT NULL,
      longitude REAL NOT NULL,
      latitude REAL NOT NULL,
      depth_km REAL NOT NULL,
      status TEXT,
      tsunami INTEGER NOT NULL,
      alert_level TEXT,
      significance INTEGER,
      url TEXT NOT NULL,
      felt_reports INTEGER
    );

    INSERT INTO earthquakes_new
      (row_id, event_id, source, magnitude, magnitude_type, place, time_utc,
       updated_utc, longitude, latitude, depth_km, status, tsunami,
       alert_level, significance, url)
    SELECT
       row_id, event_id, source, magnitude, magnitude_type, place, time_utc,
       updated_utc, longitude, latitude, depth_km, status, tsunami,
       alert_level, significance, url
    FROM earthquakes;

    DROP TABLE earthquakes;
    ALTER TABLE earthquakes_new RENAME TO earthquakes;

    CREATE INDEX idx_earthquakes_source_time ON earthquakes (source, time_utc);
  `,
};

describe('runMigrations', () => {
  it('preserves rows, row_ids and R-Tree linkage through a create-copy-drop-rename', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [
      makeEvent({ id: 'keep-me', longitude: -112.14, latitude: 36.05 }),
      makeEvent({ id: 'keep-me-too', longitude: 140.1, latitude: 35.7 }),
    ]);

    const rowIdsBefore = db
      .prepare('SELECT event_id, row_id FROM earthquakes ORDER BY event_id')
      .all();

    runMigrations(db, [REBUILD_PRESERVING_DATA]);

    const rowIdsAfter = db
      .prepare('SELECT event_id, row_id FROM earthquakes ORDER BY event_id')
      .all();
    expect(rowIdsAfter).toEqual(rowIdsBefore);

    // The real check. The R-Tree was never touched by the migration, so if
    // row_id had been reassigned during the copy this join would come back
    // empty — silently, with no error anywhere.
    const nearArizona = queryEarthquakesInBoundingBox(db, {
      minLon: -113,
      maxLon: -111,
      minLat: 35,
      maxLat: 37,
    });
    expect(nearArizona.map((e) => e.id)).toEqual(['keep-me']);
  });

  it('rolls the whole migration back when one statement fails', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent({ id: 'survivor' })]);

    const broken: Migration = {
      id: 901,
      name: 'test_broken',
      sql: `
        CREATE TABLE canary (x INTEGER);
        INSERT INTO canary VALUES (1);
        INSERT INTO table_that_does_not_exist VALUES (1);
      `,
    };

    expect(() => runMigrations(db, [broken])).toThrow(/901 \(test_broken\) failed/);

    // Everything the migration managed to do before failing is gone: the first
    // two statements did run, and without the transaction `canary` would still
    // be here.
    expect(tableExists(db, 'canary')).toBe(false);

    // And it is not recorded, so a corrected version gets a clean attempt.
    const applied = db.prepare('SELECT id FROM schema_migrations WHERE id = 901').all();
    expect(applied).toEqual([]);

    // Data predating the failure is untouched.
    const rows = db.prepare('SELECT event_id FROM earthquakes').all();
    expect(rows.map((r) => r['event_id'])).toEqual(['survivor']);
  });

  it('rolls back R-Tree virtual tables too, not just ordinary ones', () => {
    // The rebuild pattern leans on DDL being transactional. That is true of
    // SQLite generally, but R-Tree is a virtual table backed by shadow tables,
    // which is exactly the sort of thing that turns out not to roll back. It
    // does — asserted rather than assumed.
    const db = new DatabaseSync(':memory:');

    const broken: Migration = {
      id: 902,
      name: 'test_broken_vtab',
      sql: `
        CREATE VIRTUAL TABLE probe_rtree USING rtree(id, min_x, max_x);
        INSERT INTO probe_rtree VALUES (1, 0.0, 1.0);
        SELECT nonexistent_function(1);
      `,
    };

    expect(() => runMigrations(db, [broken])).toThrow();
    expect(tableExists(db, 'probe_rtree')).toBe(false);
    // Shadow tables are the part most likely to leak through a rollback.
    expect(tableExists(db, 'probe_rtree_node')).toBe(false);
  });

  it('applies each pending migration exactly once and reports which ran', () => {
    const db = new DatabaseSync(':memory:');
    const first: Migration = { id: 1, name: 'first', sql: 'CREATE TABLE a (x INTEGER);' };
    const second: Migration = { id: 2, name: 'second', sql: 'CREATE TABLE b (x INTEGER);' };

    expect(runMigrations(db, [first]).map((m) => m.id)).toEqual([1]);

    // Re-running with both must skip the first — if it did not, CREATE TABLE a
    // would throw on the existing table.
    expect(runMigrations(db, [first, second]).map((m) => m.id)).toEqual([2]);
    expect(runMigrations(db, [first, second])).toEqual([]);
  });
});

// The rules in migrations.ts applied to a real migration rather than a fixture.
// Migration 4 is the first one that had data worth keeping.
describe('migration 4 — nullable depth', () => {
  /** A database at migration 3, with events in it, as an existing install is. */
  function atMigration3() {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, migrations.slice(0, 3));
    insertEarthquakes(db, [
      makeEvent({ id: 'archive-1985', magnitude: 7.4, depthKm: 33 }),
      makeEvent({ id: 'shallow', magnitude: 5.1, depthKm: 8, longitude: 140.1, latitude: 35.7 }),
    ]);
    return db;
  }

  it('keeps every row through the rebuild', () => {
    const db = atMigration3();
    const before = queryEarthquakes(db);

    runMigrations(db, migrations);

    expect(queryEarthquakes(db)).toEqual(before);
  });

  it('keeps row_id stable, so the R-Tree still resolves', () => {
    // The silent failure: reassigned row_ids unlink every event from its
    // spatial index without erroring, and dedup stops finding duplicates.
    const db = atMigration3();
    const before = db.prepare('SELECT event_id, row_id FROM earthquakes ORDER BY event_id').all();

    runMigrations(db, migrations);

    expect(db.prepare('SELECT event_id, row_id FROM earthquakes ORDER BY event_id').all()).toEqual(
      before,
    );
    const found = queryEarthquakesInBoundingBox(db, {
      minLon: -113,
      maxLon: -111,
      minLat: 35,
      maxLat: 37,
    });
    expect(found.map((event) => event.id)).toEqual(['archive-1985']);
  });

  it('accepts a null depth afterwards, which is the point', () => {
    const db = atMigration3();
    runMigrations(db, migrations);

    insertEarthquakes(db, [makeEvent({ id: 'ushis3097', depthKm: null })]);

    const stored = queryEarthquakes(db).find((event) => event.id === 'ushis3097');
    expect(stored?.depthKm).toBeNull();
  });

  it('rejected a null depth before it, which is why it exists', () => {
    // The live 1970 and 1975 archive chunks both failed exactly here.
    const db = atMigration3();

    expect(() => {
      insertEarthquakes(db, [makeEvent({ id: 'ushis3097', depthKm: null })]);
    }).toThrow();
  });

  it('brings both indexes back — they belonged to the dropped table', () => {
    const db = atMigration3();

    runMigrations(db, migrations);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'earthquakes'")
      .all()
      .map((row) => row['name']);
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_earthquakes_source_time', 'idx_earthquakes_time_magnitude']),
    );
  });
});

describe('pendingMigrations', () => {
  it('reports what has not been applied without applying anything', () => {
    const db = new DatabaseSync(':memory:');
    const one: Migration = { id: 1, name: 'one', sql: 'CREATE TABLE a (x INTEGER);' };

    expect(pendingMigrations(db, [one]).map((m) => m.id)).toEqual([1]);
    expect(tableExists(db, 'a')).toBe(false);

    runMigrations(db, [one]);
    expect(pendingMigrations(db, [one])).toEqual([]);
  });
});
