import { describe, expect, it } from 'vitest';
import type { EarthquakeEvent } from '@terra-pulse/schema';
import { openDatabase } from './client';
import {
  catalogSignature,
  findCandidateMatches,
  insertEarthquakes,
  pruneEarthquakesBefore,
  queryEarthquakes,
  queryEarthquakesInBoundingBox,
  signaturesMatch,
} from './queries';

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

describe('earthquake queries', () => {
  it('round-trips an inserted event through a query with no filters', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent()]);

    const results = queryEarthquakes(db);

    expect(results).toEqual([makeEvent()]);
  });

  it('round-trips a null depth without turning it into a number', () => {
    // A null that came back as 0 would be indistinguishable from a genuine
    // surface event everywhere downstream.
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent({ id: 'ushis3097', depthKm: null })]);

    expect(queryEarthquakes(db)[0]?.depthKm).toBeNull();
  });

  it('filters by minimum magnitude', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [
      makeEvent({ id: 'small', magnitude: 2.0 }),
      makeEvent({ id: 'big', magnitude: 6.0 }),
    ]);

    const results = queryEarthquakes(db, { minMagnitude: 4.5 });

    expect(results.map((e) => e.id)).toEqual(['big']);
  });

  it('filters by time range', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [
      makeEvent({ id: 'old', timeUtc: '2020-01-01T00:00:00.000Z' }),
      makeEvent({ id: 'recent', timeUtc: '2026-07-20T00:00:00.000Z' }),
    ]);

    const results = queryEarthquakes(db, { startUtc: '2025-01-01T00:00:00.000Z' });

    expect(results.map((e) => e.id)).toEqual(['recent']);
  });

  it('replaces an event with the same id rather than duplicating it', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent({ magnitude: 5.0 })]);
    insertEarthquakes(db, [makeEvent({ magnitude: 5.4 })]);

    const results = queryEarthquakes(db);

    expect(results).toHaveLength(1);
    expect(results[0]?.magnitude).toBe(5.4);
  });

  it('preserves a null alertLevel and a true tsunami flag through the round trip', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent({ alertLevel: 'orange', tsunami: true })]);

    const [result] = queryEarthquakes(db);

    expect(result?.alertLevel).toBe('orange');
    expect(result?.tsunami).toBe(true);
  });

  it('finds events inside a bounding box via the rtree index, and excludes ones outside it', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [
      makeEvent({ id: 'inside', longitude: -112.14, latitude: 36.05 }),
      makeEvent({ id: 'outside', longitude: 100, latitude: -30 }),
    ]);

    const results = queryEarthquakesInBoundingBox(db, {
      minLon: -120,
      maxLon: -100,
      minLat: 30,
      maxLat: 40,
    });

    expect(results.map((e) => e.id)).toEqual(['inside']);
  });

  it('keeps the rtree entry in sync after an event is re-ingested (row_id must stay stable)', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent({ longitude: 0, latitude: 0 })]);
    // Re-ingest the same event at a different location, as a real refresh
    // would if USGS revises an event's coordinates.
    insertEarthquakes(db, [makeEvent({ longitude: -112.14, latitude: 36.05 })]);

    const stale = queryEarthquakesInBoundingBox(db, {
      minLon: -1,
      maxLon: 1,
      minLat: -1,
      maxLat: 1,
    });
    const updated = queryEarthquakesInBoundingBox(db, {
      minLon: -120,
      maxLon: -100,
      minLat: 30,
      maxLat: 40,
    });

    expect(stale).toHaveLength(0);
    expect(updated.map((e) => e.id)).toEqual(['us0001']);
  });
});

describe('catalogSignature', () => {
  it('reports zero for an empty catalogue', () => {
    const db = openDatabase(':memory:');
    expect(catalogSignature(db)).toEqual({ count: 0, latestUpdatedUtc: null });
  });

  it('is unchanged when re-ingesting identical data', () => {
    // The whole point: a poll that finds nothing new must not look like a
    // change, or the renderer rebuilds and closes the user's open inspector.
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent()]);
    const before = catalogSignature(db);

    insertEarthquakes(db, [makeEvent()]);

    expect(signaturesMatch(before, catalogSignature(db))).toBe(true);
  });

  it('changes when a new event arrives', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent({ id: 'first' })]);
    const before = catalogSignature(db);

    insertEarthquakes(db, [makeEvent({ id: 'second' })]);

    expect(signaturesMatch(before, catalogSignature(db))).toBe(false);
  });

  it('changes when an existing event is revised, without the count moving', () => {
    // USGS refines magnitudes and flips status automatic→reviewed for hours
    // after an event. Row count alone would miss it entirely.
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent({ magnitude: 5.0, updatedUtc: '2026-07-20T12:05:00.000Z' })]);
    const before = catalogSignature(db);

    insertEarthquakes(db, [
      makeEvent({ magnitude: 5.4, status: 'reviewed', updatedUtc: '2026-07-20T14:30:00.000Z' }),
    ]);
    const after = catalogSignature(db);

    expect(after.count).toBe(before.count);
    expect(signaturesMatch(before, after)).toBe(false);
  });
});

describe('catalogSignature scoping', () => {
  it('ignores events older than the given horizon', () => {
    // The archive is immutable once downloaded. Counting it would mean a
    // finished archive download flips the signature, the renderer re-queries,
    // the globe layer rebuilds and the user's selection is destroyed — over
    // events nowhere near the window on screen.
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent({ id: 'live', timeUtc: '2026-07-20T00:00:00.000Z' })]);
    const before = catalogSignature(db, '2026-07-01T00:00:00.000Z');

    insertEarthquakes(db, [
      makeEvent({ id: 'archive-1985', magnitude: 7.4, timeUtc: '1985-09-19T13:17:47.000Z' }),
    ]);
    const after = catalogSignature(db, '2026-07-01T00:00:00.000Z');

    expect(signaturesMatch(before, after)).toBe(true);
  });

  it('still notices a change inside the horizon', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent({ id: 'live', timeUtc: '2026-07-20T00:00:00.000Z' })]);
    const before = catalogSignature(db, '2026-07-01T00:00:00.000Z');

    insertEarthquakes(db, [makeEvent({ id: 'newer', timeUtc: '2026-07-21T00:00:00.000Z' })]);

    expect(signaturesMatch(before, catalogSignature(db, '2026-07-01T00:00:00.000Z'))).toBe(false);
  });

  it('still catches a revision inside the horizon, not just a new row', () => {
    // MAX(updated_utc) is what notices a magnitude refinement or an
    // automatic→reviewed flip, neither of which changes the row count.
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent({ id: 'live', timeUtc: '2026-07-20T00:00:00.000Z' })]);
    const before = catalogSignature(db, '2026-07-01T00:00:00.000Z');

    insertEarthquakes(db, [
      makeEvent({
        id: 'live',
        timeUtc: '2026-07-20T00:00:00.000Z',
        magnitude: 5.4,
        updatedUtc: '2026-07-20T14:30:00.000Z',
      }),
    ]);

    expect(signaturesMatch(before, catalogSignature(db, '2026-07-01T00:00:00.000Z'))).toBe(false);
  });

  it('covers the whole table when no horizon is given', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent({ id: 'old', timeUtc: '1985-09-19T13:17:47.000Z' })]);

    expect(catalogSignature(db).count).toBe(1);
    expect(catalogSignature(db, '2026-07-01T00:00:00.000Z').count).toBe(0);
  });
});

describe('insertEarthquakes transactionality', () => {
  /** Throws on insert — magnitude is NOT NULL. */
  function poison(): EarthquakeEvent {
    return makeEvent({ id: 'poison', magnitude: null as unknown as number });
  }

  it('commits the batch and its R-Tree rows together', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent({ id: 'a' }), makeEvent({ id: 'b', longitude: 20 })]);

    const events = db.prepare('SELECT COUNT(*) AS n FROM earthquakes').get();
    const index = db.prepare('SELECT COUNT(*) AS n FROM earthquakes_rtree').get();
    expect(Number(events?.['n'])).toBe(2);
    expect(Number(index?.['n'])).toBe(2);
  });

  it('rolls the whole batch back when one event fails', () => {
    // Half a batch is worse than none: the caller believes the window is
    // stored, so nothing ever refetches the missing part.
    const db = openDatabase(':memory:');

    expect(() => {
      insertEarthquakes(db, [makeEvent({ id: 'good' }), poison()]);
    }).toThrow();

    expect(queryEarthquakes(db)).toEqual([]);
    const index = db.prepare('SELECT COUNT(*) AS n FROM earthquakes_rtree').get();
    expect(Number(index?.['n'])).toBe(0);
  });

  it('leaves no open transaction behind after a failure', () => {
    // ROLLBACK TO undoes the work but leaves the savepoint on the stack. Miss
    // the RELEASE and the connection stays inside a transaction forever — the
    // next write appears to work and is never committed.
    const db = openDatabase(':memory:');
    expect(() => {
      insertEarthquakes(db, [poison()]);
    }).toThrow();

    // Would throw "cannot start a transaction within a transaction".
    expect(() => {
      db.exec('BEGIN');
      db.exec('COMMIT');
    }).not.toThrow();

    // And the connection is still usable.
    insertEarthquakes(db, [makeEvent({ id: 'after' })]);
    expect(queryEarthquakes(db).map((e) => e.id)).toEqual(['after']);
  });

  it('nests inside a caller-owned transaction', () => {
    // SAVEPOINT rather than BEGIN exists for this: a bulk caller wrapping many
    // batches would get "cannot start a transaction within a transaction".
    const db = openDatabase(':memory:');

    expect(() => {
      db.exec('BEGIN');
      insertEarthquakes(db, [makeEvent({ id: 'inner' })]);
      db.exec('COMMIT');
    }).not.toThrow();

    expect(queryEarthquakes(db).map((e) => e.id)).toEqual(['inner']);
  });

  it('is a no-op on an empty batch', () => {
    const db = openDatabase(':memory:');
    expect(() => {
      insertEarthquakes(db, []);
    }).not.toThrow();
    expect(queryEarthquakes(db)).toEqual([]);
  });
});

describe('findCandidateMatches', () => {
  const AT = '2026-07-20T12:00:00.000Z';
  const WITHIN = 60;

  function seeded() {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [
      makeEvent({ id: 'usgs-here-now', source: 'usgs', timeUtc: AT }),
      makeEvent({
        id: 'usgs-here-but-1985',
        source: 'usgs',
        timeUtc: '1985-09-19T13:17:47.000Z',
      }),
      makeEvent({ id: 'usgs-far', source: 'usgs', timeUtc: AT, longitude: 20, latitude: 20 }),
      makeEvent({ id: 'emsc-here-now', source: 'emsc', timeUtc: AT }),
    ]);
    return db;
  }

  const candidate = { longitude: -112.14, latitude: 36.05, timeUtc: AT };

  it('finds a same-place, same-time event from the requested source', () => {
    const found = findCandidateMatches(seeded(), candidate, 'usgs', WITHIN);
    expect(found.map((e) => e.id)).toEqual(['usgs-here-now']);
  });

  it('ignores other sources — that is the whole point of the source argument', () => {
    const found = findCandidateMatches(seeded(), candidate, 'emsc', WITHIN);
    expect(found.map((e) => e.id)).toEqual(['emsc-here-now']);
  });

  it('ignores events outside the bounding box', () => {
    const found = findCandidateMatches(seeded(), candidate, 'usgs', WITHIN);
    expect(found.map((e) => e.id)).not.toContain('usgs-far');
  });

  // The regression this whole change exists for. Before the time bound, an
  // event at the same coordinates in 1985 came back as a dedupe candidate for
  // a 2026 event, along with every other event ever recorded nearby — 800-2,100
  // rows per candidate once the archive shared the table, at 1.25 s a call.
  it('ignores an event at the same place decades apart', () => {
    const found = findCandidateMatches(seeded(), candidate, 'usgs', WITHIN);
    expect(found.map((e) => e.id)).not.toContain('usgs-here-but-1985');
  });

  it('includes an event at the very edge of the window', () => {
    // The bound must be a superset of what the predicate accepts. Excluding the
    // boundary would make dedup miss real duplicates, which shows up as doubled
    // marks on the globe rather than as an error.
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [
      makeEvent({ id: 'edge-early', source: 'usgs', timeUtc: '2026-07-20T11:59:00.000Z' }),
      makeEvent({ id: 'edge-late', source: 'usgs', timeUtc: '2026-07-20T12:01:00.000Z' }),
      makeEvent({ id: 'just-outside', source: 'usgs', timeUtc: '2026-07-20T12:01:00.001Z' }),
    ]);

    const found = findCandidateMatches(db, candidate, 'usgs', WITHIN);

    expect(found.map((e) => e.id).sort()).toEqual(['edge-early', 'edge-late']);
  });

  it('widens with the window rather than being hardcoded', () => {
    const db = seeded();
    // A year's worth of window does reach the 1985 event's neighbours; more
    // usefully, it proves the caller's threshold is what governs.
    const wide = findCandidateMatches(db, candidate, 'usgs', 60 * 60 * 24 * 365 * 50);
    expect(wide.map((e) => e.id)).toContain('usgs-here-but-1985');
  });

  it('returns nothing for an unparseable timestamp instead of falling back to a full scan', () => {
    const db = seeded();
    const found = findCandidateMatches(
      db,
      { longitude: -112.14, latitude: 36.05, timeUtc: 'not a date' },
      'usgs',
      WITHIN,
    );
    expect(found).toEqual([]);
  });
});

describe('pruneEarthquakesBefore', () => {
  // Everything seeded here is M2.5 — below the archive floor, so it is
  // rolling-cache data and prunable. The default magnitude on `makeEvent` is
  // 5.2, which the archive protects; these tests are about the cache, so they
  // say so explicitly rather than inheriting a magnitude that changes what the
  // function does.
  function seed() {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [
      makeEvent({ id: 'ancient', magnitude: 2.5, timeUtc: '2026-06-01T00:00:00.000Z' }),
      makeEvent({ id: 'old', magnitude: 2.5, timeUtc: '2026-06-20T00:00:00.000Z' }),
      makeEvent({ id: 'recent', magnitude: 2.5, timeUtc: '2026-07-20T00:00:00.000Z' }),
    ]);
    return db;
  }

  it('removes events before the cutoff and keeps the rest', () => {
    const db = seed();

    const removed = pruneEarthquakesBefore(db, '2026-07-01T00:00:00.000Z');

    expect(removed).toBe(2);
    expect(queryEarthquakes(db).map((event) => event.id)).toEqual(['recent']);
  });

  it('clears the spatial index too, leaving no orphaned rows', () => {
    // The failure this guards is silent: a stranded R-Tree row still matches a
    // bounding box, but joins to a deleted event. `findCandidateMatches` would
    // quietly stop recognising duplicates rather than throwing.
    const db = seed();

    pruneEarthquakesBefore(db, '2026-07-01T00:00:00.000Z');

    const indexRows = db.prepare('SELECT COUNT(*) AS n FROM earthquakes_rtree').get();
    expect(Number(indexRows?.['n'])).toBe(1);

    // And the surviving event is still reachable *through* the index.
    const found = queryEarthquakesInBoundingBox(db, {
      minLon: -113,
      maxLon: -111,
      minLat: 35,
      maxLat: 37,
    });
    expect(found.map((event) => event.id)).toEqual(['recent']);
  });

  it('is a no-op when nothing is old enough', () => {
    const db = seed();

    expect(pruneEarthquakesBefore(db, '2020-01-01T00:00:00.000Z')).toBe(0);
    expect(queryEarthquakes(db)).toHaveLength(3);
  });

  it('leaves an event exactly on the cutoff in place', () => {
    // The cutoff is "older than", so the boundary event is still in window.
    const db = seed();

    pruneEarthquakesBefore(db, '2026-06-20T00:00:00.000Z');

    expect(queryEarthquakes(db).map((event) => event.id)).toEqual(['recent', 'old']);
  });

  it('lets a pruned event be re-ingested cleanly', () => {
    // Backfill re-fetches overlapping ranges every launch, so a pruned event
    // reappearing must not collide on its unique id or double-index.
    const db = seed();
    pruneEarthquakesBefore(db, '2026-07-01T00:00:00.000Z');

    insertEarthquakes(db, [
      makeEvent({ id: 'old', magnitude: 2.5, timeUtc: '2026-06-20T00:00:00.000Z' }),
    ]);

    expect(queryEarthquakes(db)).toHaveLength(2);
    const indexRows = db.prepare('SELECT COUNT(*) AS n FROM earthquakes_rtree').get();
    expect(Number(indexRows?.['n'])).toBe(2);
  });

  // The whole point of the magnitude floor. The archive shares this table, so
  // the launch-time prune is the one piece of code positioned to delete all of
  // it at once — and it would have reported success while doing so.
  describe('archive protection', () => {
    it('keeps events at or above the archive floor no matter how old', () => {
      const db = openDatabase(':memory:');
      insertEarthquakes(db, [
        makeEvent({ id: 'archive-1971', magnitude: 6.8, timeUtc: '1971-03-04T00:00:00.000Z' }),
        makeEvent({ id: 'archive-edge', magnitude: 4.5, timeUtc: '1988-11-02T00:00:00.000Z' }),
        makeEvent({ id: 'cache', magnitude: 2.5, timeUtc: '2026-06-01T00:00:00.000Z' }),
      ]);

      const removed = pruneEarthquakesBefore(db, '2026-07-01T00:00:00.000Z');

      expect(removed).toBe(1);
      expect(queryEarthquakes(db).map((event) => event.id).sort()).toEqual([
        'archive-1971',
        'archive-edge',
      ]);
    });

    it('leaves the R-Tree entries for archive events intact', () => {
      // A surviving event whose index row got deleted is invisible to every
      // spatial query — which is most of what the archive is for.
      const db = openDatabase(':memory:');
      insertEarthquakes(db, [
        makeEvent({
          id: 'archive',
          magnitude: 7.4,
          timeUtc: '1985-09-19T00:00:00.000Z',
          longitude: -112.14,
          latitude: 36.05,
        }),
        makeEvent({ id: 'cache', magnitude: 1.2, timeUtc: '1985-09-19T00:00:00.000Z' }),
      ]);

      pruneEarthquakesBefore(db, '2026-07-01T00:00:00.000Z');

      const found = queryEarthquakesInBoundingBox(db, {
        minLon: -113,
        maxLon: -111,
        minLat: 35,
        maxLat: 37,
      });
      expect(found.map((event) => event.id)).toEqual(['archive']);
    });

    it('honours an explicit floor when one is given', () => {
      const db = openDatabase(':memory:');
      insertEarthquakes(db, [
        makeEvent({ id: 'm5', magnitude: 5.0, timeUtc: '2026-06-01T00:00:00.000Z' }),
        makeEvent({ id: 'm6', magnitude: 6.0, timeUtc: '2026-06-01T00:00:00.000Z' }),
      ]);

      pruneEarthquakesBefore(db, '2026-07-01T00:00:00.000Z', 5.5);

      expect(queryEarthquakes(db).map((event) => event.id)).toEqual(['m6']);
    });
  });
});
