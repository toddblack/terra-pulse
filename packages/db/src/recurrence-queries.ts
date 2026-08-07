import type { DatabaseSync } from 'node:sqlite';
import {
  declusterGardnerKnopoff,
  haversineKm,
  sequenceSearchBoxes,
  recurrenceEpochYear,
  summariseRecurrence,
  type EarthquakeEvent,
  type RegionalRecurrence,
} from '@terra-pulse/schema';
import { completedArchiveYears } from './archive-queries';
import { rowToEvent } from './queries';

/**
 * Every catalogued event within `radiusKm` of a point, at or above a floor.
 *
 * Narrows on the R-Tree and measures true distance afterwards, the same shape as
 * the aftershock query — and reuses `sequenceSearchBoxes`, so the antimeridian
 * is handled once rather than twice. Without that, every region on the Kuril,
 * Aleutian and Tongan arcs would silently return nothing.
 */
function queryRegion(
  db: DatabaseSync,
  point: { latitude: number; longitude: number },
  radiusKm: number,
  minMagnitude: number,
  nowUtc: string,
): EarthquakeEvent[] {
  const boxes = sequenceSearchBoxes(point, radiusKm);
  // The start depends on the floor: M7.5+ is complete from 1900, everything
  // below only from 1970. Querying from 1900 at M6 would sweep in seven decades
  // of near-empty record and read them as quiet years.
  const startUtc = new Date(
    Date.UTC(recurrenceEpochYear(minMagnitude), 0, 1),
  ).toISOString();

  const rows = boxes.flatMap((box) =>
    db
      .prepare(
        `SELECT earthquakes.*
         FROM earthquakes_rtree
         JOIN earthquakes ON earthquakes.row_id = earthquakes_rtree.id
         WHERE earthquakes_rtree.min_lon <= ? AND earthquakes_rtree.max_lon >= ?
           AND earthquakes_rtree.min_lat <= ? AND earthquakes_rtree.max_lat >= ?
           AND earthquakes.time_utc >= ? AND earthquakes.time_utc <= ?
           AND earthquakes.magnitude >= ?
         ORDER BY earthquakes.time_utc`,
      )
      .all(box.maxLon, box.minLon, box.maxLat, box.minLat, startUtc, nowUtc, minMagnitude),
  );

  const seen = new Set<string>();
  const events: EarthquakeEvent[] = [];
  for (const row of rows) {
    const event = rowToEvent(row);
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (haversineKm(point, event) <= radiusKm) events.push(event);
  }

  return events.sort((a, b) => a.timeUtc.localeCompare(b.timeUtc));
}

/**
 * Whether the archive covers every year from this floor's epoch to now.
 *
 * Deliberately strict. A recurrence interval is a statement about a continuous
 * record, and a hole anywhere inside it merges two real gaps into one longer
 * false gap — an error that always points the same way, toward "rarer than it
 * is". Reporting a summary over a partial archive would be worse than reporting
 * nothing, because it looks exactly like a complete answer.
 *
 * The current year is treated as covered when the archive exists at all: the
 * backfill refetches it on every run precisely because it can never be recorded
 * complete (see `archive-queries.ts`).
 */
function isArchiveComplete(db: DatabaseSync, minMagnitude: number, nowMs: number): boolean {
  const years = completedArchiveYears(db, minMagnitude);
  if (years.size === 0) return false;

  const currentYear = new Date(nowMs).getUTCFullYear();
  for (let year = recurrenceEpochYear(minMagnitude); year < currentYear; year += 1) {
    if (!years.has(year)) return false;
  }
  return true;
}

export function queryRegionalRecurrence(
  db: DatabaseSync,
  point: { latitude: number; longitude: number },
  radiusKm: number,
  minMagnitude: number,
  nowMs: number,
): RegionalRecurrence {
  const raw = queryRegion(db, point, radiusKm, minMagnitude, new Date(nowMs).toISOString());
  const independent = declusterGardnerKnopoff(raw);

  return {
    summary: summariseRecurrence(independent, {
      radiusKm,
      minMagnitude,
      rawCount: raw.length,
      nowMs,
    }),
    // Newest first: the most recent event is the one a reader looks for.
    independent: [...independent].reverse(),
    archiveComplete: isArchiveComplete(db, minMagnitude, nowMs),
  };
}
