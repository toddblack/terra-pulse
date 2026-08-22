import { describe, expect, it } from 'vitest';
import type { FocalMechanism } from '@terra-pulse/schema';
import { openDatabase } from './client';
import {
  completedGcmtChunks,
  focalMechanismCoverage,
  insertFocalMechanisms,
  queryFocalMechanisms,
  recordGcmtChunk,
} from './focal-mechanism-queries';

const mechanism = (overrides: Partial<FocalMechanism> = {}): FocalMechanism => ({
  id: 'M201103110546A',
  timeUtc: '2011-03-11T05:46:23.000Z',
  latitude: 38.32,
  longitude: 142.37,
  depthKm: 24.4,
  magnitude: 9.08,
  scalarMomentDyneCm: 5.312e29,
  nodalPlane1: { strike: 203, dip: 10, rake: 88 },
  nodalPlane2: { strike: 25, dip: 80, rake: 90 },
  centroidLatitude: 37.52,
  centroidLongitude: 143.05,
  centroidDepthKm: 20,
  referenceCatalog: 'PDE',
  ...overrides,
});

describe('insertFocalMechanisms', () => {
  it('round-trips a solution including both nodal planes', () => {
    const db = openDatabase(':memory:');
    insertFocalMechanisms(db, [mechanism()]);

    const [stored] = queryFocalMechanisms(db, { startUtc: '2011-01-01T00:00:00Z' });
    expect(stored).toEqual(mechanism());
    db.close();
  });

  it('keeps the scalar moment to full precision', () => {
    // 5.312e29 in a REAL column. Stored as anything narrower the magnitude
    // drifts, and a magnitude is what selects H6's target set.
    const db = openDatabase(':memory:');
    insertFocalMechanisms(db, [mechanism()]);
    const [stored] = queryFocalMechanisms(db, {});
    expect(stored!.scalarMomentDyneCm).toBe(5.312e29);
    db.close();
  });

  it('upserts on re-ingest so a repeated backfill is idempotent', () => {
    const db = openDatabase(':memory:');
    insertFocalMechanisms(db, [mechanism()]);
    insertFocalMechanisms(db, [mechanism()]);
    expect(focalMechanismCoverage(db).total).toBe(1);
    db.close();
  });

  it('takes a revised solution over the one already stored', () => {
    // GCMT supersedes a Quick CMT with a Standard one under the same event
    // name, so a conflict is a revision to take rather than a duplicate to
    // ignore.
    const db = openDatabase(':memory:');
    insertFocalMechanisms(db, [mechanism({ nodalPlane1: { strike: 1, dip: 2, rake: 3 } })]);
    insertFocalMechanisms(db, [mechanism()]);

    const [stored] = queryFocalMechanisms(db, {});
    expect(stored!.nodalPlane1).toEqual({ strike: 203, dip: 10, rake: 88 });
    db.close();
  });

  it('inserts nothing for an empty list without opening a transaction', () => {
    const db = openDatabase(':memory:');
    expect(insertFocalMechanisms(db, [])).toBe(0);
    db.close();
  });
});

describe('queryFocalMechanisms', () => {
  const seed = (db: ReturnType<typeof openDatabase>): void => {
    insertFocalMechanisms(db, [
      mechanism({ id: 'a', timeUtc: '1990-01-01T00:00:00.000Z', magnitude: 5.2 }),
      mechanism({ id: 'b', timeUtc: '2000-01-01T00:00:00.000Z', magnitude: 6.1 }),
      mechanism({ id: 'c', timeUtc: '2010-01-01T00:00:00.000Z', magnitude: 5.6 }),
    ]);
  };

  it('returns rows in origin-time order, which the join depends on', () => {
    // `matchMechanisms` is a two-pointer sweep and throws on unsorted input, so
    // the ordering here is a contract rather than a convenience.
    const db = openDatabase(':memory:');
    seed(db);
    expect(queryFocalMechanisms(db, {}).map((m) => m.id)).toEqual(['a', 'b', 'c']);
    db.close();
  });

  it('bounds time as inclusive start and exclusive end', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const window = queryFocalMechanisms(db, {
      startUtc: '2000-01-01T00:00:00.000Z',
      endUtc: '2010-01-01T00:00:00.000Z',
    });
    expect(window.map((m) => m.id)).toEqual(['b']);
    db.close();
  });

  it('filters on magnitude', () => {
    const db = openDatabase(':memory:');
    seed(db);
    expect(queryFocalMechanisms(db, { minMagnitude: 5.5 }).map((m) => m.id)).toEqual(['b', 'c']);
    db.close();
  });

  it('uses the time index when a time range is bound', () => {
    // The `findCandidateMatches` lesson, applied before it can bite: a
    // composite index only narrows on the columns actually bound, and an
    // unbounded read is a full scan that still says INDEX in its plan.
    const db = openDatabase(':memory:');
    seed(db);
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM focal_mechanisms WHERE time_utc >= ? AND time_utc < ? ORDER BY time_utc`,
      )
      .all('2000-01-01T00:00:00.000Z', '2010-01-01T00:00:00.000Z') as unknown as {
      detail: string;
    }[];
    const detail = plan.map((row) => row.detail).join(' ');
    expect(detail).toContain('idx_focal_mechanisms_time');
    expect(detail).not.toContain('SCAN focal_mechanisms');
    db.close();
  });
});

describe('gcmt chunk bookkeeping', () => {
  it('records which catalogue files have been fetched in full', () => {
    // Row presence cannot answer this: a month with no M5+ mechanisms and a
    // month never fetched look identical from the data alone.
    const db = openDatabase(':memory:');
    expect(completedGcmtChunks(db).size).toBe(0);

    recordGcmtChunk(db, 'jan76_dec25', 70044);
    recordGcmtChunk(db, '2026-01', 118);

    const chunks = completedGcmtChunks(db);
    expect(chunks.has('jan76_dec25')).toBe(true);
    expect(chunks.has('2026-01')).toBe(true);
    expect(chunks.has('2026-02')).toBe(false);
    db.close();
  });

  it('overwrites a chunk re-fetched later', () => {
    const db = openDatabase(':memory:');
    recordGcmtChunk(db, '2026-08', 12);
    recordGcmtChunk(db, '2026-08', 31);
    const row = db.prepare('SELECT event_count FROM gcmt_chunks WHERE chunk = ?').get('2026-08') as
      | { event_count: number }
      | undefined;
    expect(row?.event_count).toBe(31);
    db.close();
  });
});

describe('focalMechanismCoverage', () => {
  it('reports nulls for an empty catalogue rather than throwing', () => {
    const db = openDatabase(':memory:');
    expect(focalMechanismCoverage(db)).toEqual({
      total: 0,
      earliestUtc: null,
      latestUtc: null,
    });
    db.close();
  });

  it('reports the span actually held', () => {
    const db = openDatabase(':memory:');
    insertFocalMechanisms(db, [
      mechanism({ id: 'a', timeUtc: '1976-01-01T01:29:39.600Z' }),
      mechanism({ id: 'b', timeUtc: '2025-12-31T20:27:43.700Z' }),
    ]);
    expect(focalMechanismCoverage(db)).toEqual({
      total: 2,
      earliestUtc: '1976-01-01T01:29:39.600Z',
      latestUtc: '2025-12-31T20:27:43.700Z',
    });
    db.close();
  });
});
