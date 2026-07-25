import { describe, expect, it } from 'vitest';
import { openDatabase } from './client';
import { runMigrations } from './migrate';

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

    const appliedCount = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get();
    expect(appliedCount?.['count']).toBe(1);
  });
});
