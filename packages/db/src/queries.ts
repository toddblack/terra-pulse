import type { DatabaseSync } from 'node:sqlite';
import { ARCHIVE_MIN_MAGNITUDE } from '@terra-pulse/schema';
import type {
  EarthquakeEvent,
  EarthquakeQuery,
  EarthquakeSource,
  BoundingBox,
} from '@terra-pulse/schema';

/**
 * Exported so every query module builds an event the same way. A second copy of
 * this mapping is how one caller ends up with `tsunami` as the raw 0/1 integer,
 * or misses a column added later.
 */
export function rowToEvent(row: Record<string, unknown>): EarthquakeEvent {
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
    depthKm: row['depth_km'] as number | null,
    status: row['status'] as string | null,
    tsunami: Boolean(row['tsunami']),
    alertLevel: row['alert_level'] as string | null,
    significance: row['significance'] as number | null,
    url: row['url'] as string,
  };
}

/**
 * Upserts a batch of events, and their R-Tree rows, in **one transaction**.
 *
 * The transaction is a performance requirement, not a consistency nicety. Each
 * statement outside one is its own implicit transaction, so every event paid a
 * separate durability flush: measured against the real 306k-row catalogue,
 * 7,000 upserts took **66 s** loose and **0.3 s** wrapped — 216×. A backfill
 * does this twice per launch, which is most of why the app took minutes to
 * start once the archive landed.
 *
 * `SAVEPOINT` rather than `BEGIN` so this composes: a caller that already has a
 * transaction open (a migration, a bulk archive chunk) would get "cannot start
 * a transaction within a transaction" from `BEGIN`, and that caller is exactly
 * the one most likely to exist later.
 *
 * The two tables move together or not at all. A committed event with no R-Tree
 * row is invisible to every spatial query — including dedup, which would then
 * quietly stop recognising it as a duplicate.
 */
export function insertEarthquakes(db: DatabaseSync, events: EarthquakeEvent[]): void {
  if (events.length === 0) return;
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

  db.exec('SAVEPOINT insert_earthquakes');
  try {
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
    db.exec('RELEASE insert_earthquakes');
  } catch (error: unknown) {
    // ROLLBACK TO undoes the work but leaves the savepoint on the stack; the
    // RELEASE is what pops it. Without both, a failed batch leaves the
    // connection inside an open transaction for the rest of its life.
    db.exec('ROLLBACK TO insert_earthquakes');
    db.exec('RELEASE insert_earthquakes');
    throw error;
  }
}

/**
 * Deletes rolling-cache events older than `beforeUtc`. Returns how many went.
 *
 * The catalogue is a rolling cache, but nothing was ever removing anything —
 * `insertEarthquakes` only upserts, so the table grew for the lifetime of the
 * install regardless of the window on screen. Harmless while it held four days;
 * worth fixing before a thirty-day ingest accelerates it.
 *
 * **The magnitude floor is what keeps the historical archive alive.** This ran
 * on time alone, which was right while the table held nothing but a 30-day
 * cache. The archive shares this table — deliberately, so the globe layer, the
 * R-Tree and dedup all keep working with no union queries — which means a
 * time-only prune on the next launch would delete all ~295k rows of it and
 * report success. Rows at or above the archive floor are therefore never
 * pruned.
 *
 * The consequence, stated plainly: this table is a 30-day cache *below* M4.5
 * and permanent at or above it, whether or not the archive has been downloaded
 * yet. That costs ~700 rows a month from the rolling window, and they are rows
 * the archive would want anyway.
 *
 * **Both tables, in one transaction.** Deleting from `earthquakes` alone would
 * strand the matching R-Tree rows, and a stale spatial index is worse than none:
 * `findCandidateMatches` would return ids that no longer join to anything, so
 * dedup would silently stop recognising duplicates. The R-Tree goes first so a
 * failure mid-way leaves orphaned *index* rows — which the join discards —
 * rather than orphaned events, which it would not.
 */
export function pruneEarthquakesBefore(
  db: DatabaseSync,
  beforeUtc: string,
  // Defaulted rather than required at the call site: forgetting to pass it
  // would destroy the archive silently, and a default that protects is the
  // only version of this that fails safe.
  keepAtOrAboveMagnitude: number = ARCHIVE_MIN_MAGNITUDE,
): number {
  const doomed = db
    .prepare('SELECT row_id FROM earthquakes WHERE time_utc < ? AND magnitude < ?')
    .all(beforeUtc, keepAtOrAboveMagnitude)
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
/**
 * The notable events that arrived while the app was closed.
 *
 * Ordered **by magnitude, not by time**, and that is the load-bearing choice.
 * The list has to be capped — someone away for three months could have missed
 * hundreds — and a chronological cap can hide the M7.5 behind ten M5.9s, which
 * is the one failure this digest cannot have. Sorting by size means the cap can
 * only ever trim the least interesting end.
 *
 * `sinceUtc` is exclusive: an event exactly at the last-seen instant was seen.
 */
export function queryMissedEarthquakes(
  db: DatabaseSync,
  sinceUtc: string,
  minMagnitude: number,
  limit: number,
): EarthquakeEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM earthquakes
       WHERE time_utc > ? AND magnitude >= ?
       ORDER BY magnitude DESC, time_utc DESC
       LIMIT ?`,
    )
    .all(sinceUtc, minMagnitude, limit);

  return rows.map(rowToEvent);
}

/** How many qualify in total, so a trimmed list can say what it left out. */
export function countMissedEarthquakes(
  db: DatabaseSync,
  sinceUtc: string,
  minMagnitude: number,
): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM earthquakes WHERE time_utc > ? AND magnitude >= ?')
    .get(sinceUtc, minMagnitude);
  return Number(row?.['count'] ?? 0);
}

/**
 * One event by its catalogue id, or null.
 *
 * Exists so IPC callers can pass an id rather than a whole event. The renderer
 * already holds the object, but sending it back would make main trust
 * renderer-supplied coordinates for a spatial query — and a mainshock that
 * isn't a real catalogue row is not a question worth answering.
 */
export function getEarthquakeById(db: DatabaseSync, eventId: string): EarthquakeEvent | null {
  const row = db.prepare('SELECT * FROM earthquakes WHERE event_id = ?').get(eventId);
  return row === undefined ? null : rowToEvent(row);
}

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

/**
 * `sinceUtc` scopes the signature to the part of the catalogue that can
 * actually change — omit it and this is a full-table scan.
 *
 * Both reasons to pass it point the same way:
 *
 * - **Speed.** Unscoped this plans as `SCAN earthquakes`: measured at 68.7 ms
 *   over 306k rows, run twice per poll, every five minutes, forever. Scoped it
 *   uses `idx_earthquakes_time_magnitude` and costs 5.0 ms.
 * - **Correctness.** This answers "should the renderer re-query the live
 *   window?". The historical archive is immutable once downloaded, so counting
 *   it means a completed archive download flips the signature and rebuilds the
 *   globe layer — destroying the user's selection — over events nowhere near
 *   the window on screen. The archive has its own progress channel for saying
 *   it changed; it does not need this one.
 */
export function catalogSignature(db: DatabaseSync, sinceUtc?: string): CatalogSignature {
  const row =
    sinceUtc === undefined
      ? db.prepare('SELECT COUNT(*) AS count, MAX(updated_utc) AS latest FROM earthquakes').get()
      : db
          .prepare(
            'SELECT COUNT(*) AS count, MAX(updated_utc) AS latest FROM earthquakes WHERE time_utc >= ?',
          )
          .get(sinceUtc);

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
 * Narrows on **both** axes the caller's predicate cares about — a bbox around
 * the candidate and a time window around its origin — then hands the survivors
 * over. The bbox is deliberately generous: it only has to be a superset of what
 * the predicate accepts, so a degree of latitude (~111 km) comfortably covers a
 * 50 km match radius without projection maths here.
 *
 * ## Why `withinSeconds` is required rather than optional
 *
 * This took a bbox and a source and nothing else, on the reasoning that the
 * R-Tree would do the narrowing. It does not: measured against the real
 * catalogue, SQLite plans it as
 * `SEARCH earthquakes USING INDEX idx_earthquakes_source_time (source=?)` —
 * every row of that source, then filtered by the spatial index. With a 30-day
 * cache that was invisible. With the historical archive in the same table it
 * became **1.25 s per call**, against 800–2,100 rows materialised for a single
 * candidate in any seismically busy region, and it runs once per EMSC event
 * during backfill. That was the slow app start.
 *
 * With the time bound the same index is used as
 * `(source=? AND time_utc>? AND time_utc<?)` and the call drops to **0 ms**.
 * Every row it used to return outside that window was fetched purely to be
 * rejected by the predicate.
 *
 * It has no default because a default is exactly the thing that would have gone
 * on being wrong quietly. **The window passed here must be at least as wide as
 * the predicate's own time threshold** — narrower, and dedupe silently stops
 * recognising duplicates, which shows up as doubled marks on the globe rather
 * than as an error.
 */
export function findCandidateMatches(
  db: DatabaseSync,
  candidate: Pick<EarthquakeEvent, 'longitude' | 'latitude' | 'timeUtc'>,
  source: EarthquakeSource,
  withinSeconds: number,
  radiusDegrees = 1,
): EarthquakeEvent[] {
  const candidateMs = Date.parse(candidate.timeUtc);
  // An unparseable timestamp can't be bounded, and widening to "everything"
  // would quietly restore the full scan. Nothing can match it anyway.
  if (!Number.isFinite(candidateMs)) return [];

  const windowMs = withinSeconds * 1000;
  const earliest = new Date(candidateMs - windowMs).toISOString();
  const latest = new Date(candidateMs + windowMs).toISOString();

  const rows = db
    .prepare(
      `
      SELECT earthquakes.*
      FROM earthquakes_rtree
      JOIN earthquakes ON earthquakes.row_id = earthquakes_rtree.id
      WHERE earthquakes_rtree.min_lon <= ? AND earthquakes_rtree.max_lon >= ?
        AND earthquakes_rtree.min_lat <= ? AND earthquakes_rtree.max_lat >= ?
        AND earthquakes.source = ?
        AND earthquakes.time_utc BETWEEN ? AND ?
    `,
    )
    .all(
      candidate.longitude + radiusDegrees,
      candidate.longitude - radiusDegrees,
      candidate.latitude + radiusDegrees,
      candidate.latitude - radiusDegrees,
      source,
      earliest,
      latest,
    );

  return rows.map(rowToEvent);
}
