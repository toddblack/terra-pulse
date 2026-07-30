import type { DatabaseSync } from 'node:sqlite';
import type {
  EarthquakeEvent,
  EarthquakeQuery,
  EarthquakeSource,
  BoundingBox,
} from '@terra-pulse/schema';

function rowToEvent(row: Record<string, unknown>): EarthquakeEvent {
  return {
    id: row['event_id'] as string,
    source: row['source'] as EarthquakeSource,
    magnitude: row['magnitude'] as number,
    magnitudeType: row['magnitude_type'] as string,
    place: row['place'] as string,
    timeUtc: row['time_utc'] as string,
    updatedUtc: row['updated_utc'] as string,
    longitude: row['longitude'] as number,
    latitude: row['latitude'] as number,
    depthKm: row['depth_km'] as number,
    status: row['status'] as string | null,
    tsunami: Boolean(row['tsunami']),
    alertLevel: row['alert_level'] as string | null,
    significance: row['significance'] as number | null,
    url: row['url'] as string,
  };
}

export function insertEarthquakes(db: DatabaseSync, events: EarthquakeEvent[]): void {
  // ON CONFLICT...DO UPDATE (not INSERT OR REPLACE) so row_id stays stable
  // across re-ingestion of the same event — REPLACE would delete+reinsert,
  // handing out a new row_id and orphaning the linked rtree row.
  const upsert = db.prepare(`
    INSERT INTO earthquakes
      (event_id, source, magnitude, magnitude_type, place, time_utc, updated_utc,
       longitude, latitude, depth_km, status, tsunami, alert_level,
       significance, url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      source = excluded.source,
      magnitude = excluded.magnitude,
      magnitude_type = excluded.magnitude_type,
      place = excluded.place,
      time_utc = excluded.time_utc,
      updated_utc = excluded.updated_utc,
      longitude = excluded.longitude,
      latitude = excluded.latitude,
      depth_km = excluded.depth_km,
      status = excluded.status,
      tsunami = excluded.tsunami,
      alert_level = excluded.alert_level,
      significance = excluded.significance,
      url = excluded.url
    RETURNING row_id
  `);

  const upsertRtree = db.prepare(`
    INSERT OR REPLACE INTO earthquakes_rtree (id, min_lon, max_lon, min_lat, max_lat)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const event of events) {
    const result = upsert.get(
      event.id,
      event.source,
      event.magnitude,
      event.magnitudeType,
      event.place,
      event.timeUtc,
      event.updatedUtc,
      event.longitude,
      event.latitude,
      event.depthKm,
      event.status,
      event.tsunami ? 1 : 0,
      event.alertLevel,
      event.significance,
      event.url,
    );
    const rowId = result?.['row_id'] as number;
    upsertRtree.run(rowId, event.longitude, event.longitude, event.latitude, event.latitude);
  }
}

/**
 * Deletes events older than `beforeUtc`. Returns how many went.
 *
 * The catalogue is a rolling cache, but nothing was ever removing anything —
 * `insertEarthquakes` only upserts, so the table grew for the lifetime of the
 * install regardless of the window on screen. Harmless while it held four days;
 * worth fixing before a thirty-day ingest accelerates it.
 *
 * **Both tables, in one transaction.** Deleting from `earthquakes` alone would
 * strand the matching R-Tree rows, and a stale spatial index is worse than none:
 * `findCandidateMatches` would return ids that no longer join to anything, so
 * dedup would silently stop recognising duplicates. The R-Tree goes first so a
 * failure mid-way leaves orphaned *index* rows — which the join discards —
 * rather than orphaned events, which it would not.
 */
export function pruneEarthquakesBefore(db: DatabaseSync, beforeUtc: string): number {
  const doomed = db
    .prepare('SELECT row_id FROM earthquakes WHERE time_utc < ?')
    .all(beforeUtc)
    .map((row) => row['row_id'] as number);

  if (doomed.length === 0) return 0;

  const dropIndexRow = db.prepare('DELETE FROM earthquakes_rtree WHERE id = ?');
  const dropEvent = db.prepare('DELETE FROM earthquakes WHERE row_id = ?');

  db.exec('BEGIN');
  try {
    for (const rowId of doomed) {
      dropIndexRow.run(rowId);
      dropEvent.run(rowId);
    }
    db.exec('COMMIT');
  } catch (error: unknown) {
    db.exec('ROLLBACK');
    throw error;
  }

  return doomed.length;
}

export function queryEarthquakes(
  db: DatabaseSync,
  query: EarthquakeQuery = {},
): EarthquakeEvent[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (query.startUtc !== undefined) {
    conditions.push('time_utc >= ?');
    params.push(query.startUtc);
  }
  if (query.endUtc !== undefined) {
    conditions.push('time_utc <= ?');
    params.push(query.endUtc);
  }
  if (query.minMagnitude !== undefined) {
    conditions.push('magnitude >= ?');
    params.push(query.minMagnitude);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM earthquakes ${where} ORDER BY time_utc DESC`)
    .all(...params);

  return rows.map(rowToEvent);
}

// Exercises the R-Tree index specifically (join through earthquakes_rtree),
// rather than a plain WHERE on longitude/latitude — proves the spatial
// index is actually wired up correctly, not just declared in the schema.
export function queryEarthquakesInBoundingBox(
  db: DatabaseSync,
  box: BoundingBox,
): EarthquakeEvent[] {
  const rows = db
    .prepare(
      `
      SELECT earthquakes.*
      FROM earthquakes_rtree
      JOIN earthquakes ON earthquakes.row_id = earthquakes_rtree.id
      WHERE earthquakes_rtree.min_lon <= ? AND earthquakes_rtree.max_lon >= ?
        AND earthquakes_rtree.min_lat <= ? AND earthquakes_rtree.max_lat >= ?
      ORDER BY earthquakes.time_utc DESC
    `,
    )
    .all(box.maxLon, box.minLon, box.maxLat, box.minLat);

  return rows.map(rowToEvent);
}

/**
 * A cheap signature of the catalogue's state.
 *
 * Compared before and after an ingest to decide whether anything actually
 * changed. `MAX(updated_utc)` is what catches USGS *revisions* — a magnitude
 * refinement or an automatic→reviewed status flip changes no row count, but
 * does bump that timestamp.
 *
 * Without it, every poll would push a fresh event array to the renderer, the
 * earthquake layer would rebuild, and Cesium would destroy whichever entity
 * the user has selected — closing the inspector panel once a minute.
 */
export interface CatalogSignature {
  count: number;
  latestUpdatedUtc: string | null;
}

export function catalogSignature(db: DatabaseSync): CatalogSignature {
  const row = db
    .prepare('SELECT COUNT(*) AS count, MAX(updated_utc) AS latest FROM earthquakes')
    .get();

  return {
    count: Number(row?.['count'] ?? 0),
    latestUpdatedUtc: (row?.['latest'] as string | null) ?? null,
  };
}

export function signaturesMatch(a: CatalogSignature, b: CatalogSignature): boolean {
  return a.count === b.count && a.latestUpdatedUtc === b.latestUpdatedUtc;
}

/**
 * Finds an already-stored event from `source` that plausibly *is* the given
 * candidate — the same earthquake reported by a different agency.
 *
 * Narrows with the R-Tree first (a bbox around the candidate), then hands the
 * survivors to the caller's predicate. Without the spatial index this would be
 * a full scan per candidate, and a poll ingests hundreds of them.
 *
 * The bbox is deliberately generous: it only has to be a superset of whatever
 * the predicate accepts, so a degree of latitude (~111 km) comfortably covers
 * a 50 km match radius without needing projection maths here.
 */
export function findCandidateMatches(
  db: DatabaseSync,
  candidate: Pick<EarthquakeEvent, 'longitude' | 'latitude' | 'timeUtc'>,
  source: EarthquakeSource,
  radiusDegrees = 1,
): EarthquakeEvent[] {
  const rows = db
    .prepare(
      `
      SELECT earthquakes.*
      FROM earthquakes_rtree
      JOIN earthquakes ON earthquakes.row_id = earthquakes_rtree.id
      WHERE earthquakes_rtree.min_lon <= ? AND earthquakes_rtree.max_lon >= ?
        AND earthquakes_rtree.min_lat <= ? AND earthquakes_rtree.max_lat >= ?
        AND earthquakes.source = ?
    `,
    )
    .all(
      candidate.longitude + radiusDegrees,
      candidate.longitude - radiusDegrees,
      candidate.latitude + radiusDegrees,
      candidate.latitude - radiusDegrees,
      source,
    );

  return rows.map(rowToEvent);
}
