import type { DatabaseSync } from 'node:sqlite';
import type { FocalMechanism } from '@terra-pulse/schema';

interface MechanismRow {
  id: string;
  time_utc: string;
  latitude: number;
  longitude: number;
  depth_km: number;
  magnitude: number;
  scalar_moment_dyne_cm: number;
  np1_strike: number;
  np1_dip: number;
  np1_rake: number;
  np2_strike: number;
  np2_dip: number;
  np2_rake: number;
  centroid_latitude: number;
  centroid_longitude: number;
  centroid_depth_km: number;
  reference_catalog: string;
}

function toMechanism(row: MechanismRow): FocalMechanism {
  return {
    id: row.id,
    timeUtc: row.time_utc,
    latitude: row.latitude,
    longitude: row.longitude,
    depthKm: row.depth_km,
    magnitude: row.magnitude,
    scalarMomentDyneCm: row.scalar_moment_dyne_cm,
    nodalPlane1: { strike: row.np1_strike, dip: row.np1_dip, rake: row.np1_rake },
    nodalPlane2: { strike: row.np2_strike, dip: row.np2_dip, rake: row.np2_rake },
    centroidLatitude: row.centroid_latitude,
    centroidLongitude: row.centroid_longitude,
    centroidDepthKm: row.centroid_depth_km,
    referenceCatalog: row.reference_catalog,
  };
}

/**
 * Upserts mechanisms by their GCMT event name.
 *
 * `SAVEPOINT`-wrapped like `insertSolarFlares` and `insertEarthquakes`, for the
 * reason measured there: without a transaction every row pays its own
 * durability flush, which took 7,000 upserts from 0.3 s to 66 s. This ingest is
 * 70,044 rows in one go, so it is the largest single insert in the app.
 *
 * A plain overwrite on conflict is right here. GCMT *does* revise solutions —
 * a Quick CMT (`Q-` timestamp) is superseded by a Standard one (`S-`) under the
 * same event name — so a later fetch is a revision to take, not a second
 * partial observation to merge.
 */
export function insertFocalMechanisms(
  db: DatabaseSync,
  mechanisms: readonly FocalMechanism[],
): number {
  if (mechanisms.length === 0) return 0;

  const statement = db.prepare(`
    INSERT INTO focal_mechanisms
      (id, time_utc, latitude, longitude, depth_km, magnitude, scalar_moment_dyne_cm,
       np1_strike, np1_dip, np1_rake, np2_strike, np2_dip, np2_rake,
       centroid_latitude, centroid_longitude, centroid_depth_km, reference_catalog)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      time_utc = excluded.time_utc,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      depth_km = excluded.depth_km,
      magnitude = excluded.magnitude,
      scalar_moment_dyne_cm = excluded.scalar_moment_dyne_cm,
      np1_strike = excluded.np1_strike,
      np1_dip = excluded.np1_dip,
      np1_rake = excluded.np1_rake,
      np2_strike = excluded.np2_strike,
      np2_dip = excluded.np2_dip,
      np2_rake = excluded.np2_rake,
      centroid_latitude = excluded.centroid_latitude,
      centroid_longitude = excluded.centroid_longitude,
      centroid_depth_km = excluded.centroid_depth_km,
      reference_catalog = excluded.reference_catalog
  `);

  db.exec('SAVEPOINT insert_focal_mechanisms');
  try {
    for (const mechanism of mechanisms) {
      statement.run(
        mechanism.id,
        mechanism.timeUtc,
        mechanism.latitude,
        mechanism.longitude,
        mechanism.depthKm,
        mechanism.magnitude,
        mechanism.scalarMomentDyneCm,
        mechanism.nodalPlane1.strike,
        mechanism.nodalPlane1.dip,
        mechanism.nodalPlane1.rake,
        mechanism.nodalPlane2.strike,
        mechanism.nodalPlane2.dip,
        mechanism.nodalPlane2.rake,
        mechanism.centroidLatitude,
        mechanism.centroidLongitude,
        mechanism.centroidDepthKm,
        mechanism.referenceCatalog,
      );
    }
    db.exec('RELEASE insert_focal_mechanisms');
  } catch (error) {
    db.exec('ROLLBACK TO insert_focal_mechanisms');
    db.exec('RELEASE insert_focal_mechanisms');
    throw error;
  }

  return mechanisms.length;
}

export interface MechanismQuery {
  /** Inclusive lower bound on origin time. */
  startUtc?: string;
  /** Exclusive upper bound on origin time. */
  endUtc?: string;
  minMagnitude?: number;
}

/**
 * Reads mechanisms in origin-time order, which is what `matchMechanisms`
 * requires of its inputs.
 *
 * **Always bind a time range.** The index this leans on is
 * `idx_focal_mechanisms_time`, and an unbounded read is a full scan of 70,000
 * rows wearing the word INDEX in its query plan — the exact shape that made
 * `findCandidateMatches` 1.25 s per call before a time bound was added.
 *
 * The magnitude filter is applied *after* the time bound rather than through
 * `idx_focal_mechanisms_magnitude_time`, because a join needs the whole time
 * slice in order; that second index exists for the counting queries below.
 */
export function queryFocalMechanisms(
  db: DatabaseSync,
  query: MechanismQuery = {},
): FocalMechanism[] {
  const clauses: string[] = [];
  const parameters: (string | number)[] = [];

  if (query.startUtc !== undefined) {
    clauses.push('time_utc >= ?');
    parameters.push(query.startUtc);
  }
  if (query.endUtc !== undefined) {
    clauses.push('time_utc < ?');
    parameters.push(query.endUtc);
  }
  if (query.minMagnitude !== undefined) {
    clauses.push('magnitude >= ?');
    parameters.push(query.minMagnitude);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT id, time_utc, latitude, longitude, depth_km, magnitude, scalar_moment_dyne_cm,
              np1_strike, np1_dip, np1_rake, np2_strike, np2_dip, np2_rake,
              centroid_latitude, centroid_longitude, centroid_depth_km, reference_catalog
         FROM focal_mechanisms
         ${where}
         ORDER BY time_utc`,
    )
    .all(...parameters) as unknown as MechanismRow[];

  return rows.map(toMechanism);
}

export interface MechanismCoverage {
  total: number;
  earliestUtc: string | null;
  latestUtc: string | null;
}

/** What the catalogue holds, for the archive panel and for H6's own caveats. */
export function focalMechanismCoverage(db: DatabaseSync): MechanismCoverage {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total, MIN(time_utc) AS earliest, MAX(time_utc) AS latest
         FROM focal_mechanisms`,
    )
    .get() as unknown as { total: number; earliest: string | null; latest: string | null };

  return { total: row.total, earliestUtc: row.earliest, latestUtc: row.latest };
}

/**
 * Which catalogue files have been fetched in full.
 *
 * Presence of rows is not the test, for the reason every chunk table here
 * exists: a month with no M5+ mechanisms and a month never fetched look
 * identical from the data alone.
 */
export function completedGcmtChunks(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT chunk FROM gcmt_chunks').all() as unknown as { chunk: string }[];
  return new Set(rows.map((row) => row.chunk));
}

export function recordGcmtChunk(db: DatabaseSync, chunk: string, eventCount: number): void {
  db.prepare(
    `INSERT INTO gcmt_chunks (chunk, event_count, completed_at)
     VALUES (?, ?, ?)
     ON CONFLICT(chunk) DO UPDATE SET
       event_count = excluded.event_count,
       completed_at = excluded.completed_at`,
  ).run(chunk, eventCount, new Date().toISOString());
}

/** Totals for the archive panel's progress bar. */
export function gcmtChunkSummary(db: DatabaseSync): {
  completedChunks: number;
  storedEvents: number;
} {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS chunks, COALESCE(SUM(event_count), 0) AS events FROM gcmt_chunks`,
    )
    .get();

  return {
    completedChunks: Number(row?.['chunks'] ?? 0),
    storedEvents: Number(row?.['events'] ?? 0),
  };
}
