import type { DatabaseSync } from 'node:sqlite';
import type { EarthquakeEvent, EarthquakeQuery, BoundingBox } from '@terra-pulse/schema';

function rowToEvent(row: Record<string, unknown>): EarthquakeEvent {
  return {
    id: row['usgs_id'] as string,
    magnitude: row['magnitude'] as number,
    magnitudeType: row['magnitude_type'] as string,
    place: row['place'] as string,
    timeUtc: row['time_utc'] as string,
    updatedUtc: row['updated_utc'] as string,
    longitude: row['longitude'] as number,
    latitude: row['latitude'] as number,
    depthKm: row['depth_km'] as number,
    status: row['status'] as string,
    tsunami: Boolean(row['tsunami']),
    alertLevel: row['alert_level'] as string | null,
    significance: row['significance'] as number,
    url: row['url'] as string,
  };
}

export function insertEarthquakes(db: DatabaseSync, events: EarthquakeEvent[]): void {
  // ON CONFLICT...DO UPDATE (not INSERT OR REPLACE) so row_id stays stable
  // across re-ingestion of the same event — REPLACE would delete+reinsert,
  // handing out a new row_id and orphaning the linked rtree row.
  const upsert = db.prepare(`
    INSERT INTO earthquakes
      (usgs_id, magnitude, magnitude_type, place, time_utc, updated_utc,
       longitude, latitude, depth_km, status, tsunami, alert_level,
       significance, url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(usgs_id) DO UPDATE SET
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
