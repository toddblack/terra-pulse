import type { DatabaseSync } from 'node:sqlite';
import {
  SEQUENCE_MIN_MAGNITUDE,
  gardnerKnopoffRadiusKm,
  gardnerKnopoffWindowDays,
  haversineKm,
  sequenceSearchBoxes,
  summariseSequence,
  type AftershockSequence,
  type EarthquakeEvent,
} from '@terra-pulse/schema';
import { uncoveredArchiveYears } from './archive-queries';
import { rowToEvent } from './queries';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Every catalogued event inside the mainshock's Gardner-Knopoff window.
 *
 * Narrows on the R-Tree first and measures true distance afterwards, the same
 * shape as `findCandidateMatches` and for the same reason: the index answers in
 * rectangles, and a rectangle is not a circle. The corner of a 130 km box is
 * 184 km from the centre, so skipping the haversine step would inflate a large
 * sequence by roughly the 4/π ratio of the areas.
 *
 * **Both bounds are bound in SQL**, not filtered afterwards. A composite index
 * only narrows on the columns actually bound — the lesson `findCandidateMatches`
 * paid 1.25 s per call to learn — so the time range and the magnitude floor are
 * predicates, not post-filters.
 */
function queryWindow(
  db: DatabaseSync,
  mainshock: EarthquakeEvent,
  radiusKm: number,
  endUtc: string,
): EarthquakeEvent[] {
  const boxes = sequenceSearchBoxes(mainshock, radiusKm);

  // One statement per box rather than an OR across both. A disjunction over
  // R-Tree columns is exactly the shape that talks SQLite out of using the
  // index; two indexed lookups are cheaper than one scan, and the split only
  // happens at the antimeridian anyway.
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
           AND earthquakes.event_id != ?`,
      )
      .all(
        box.maxLon,
        box.minLon,
        box.maxLat,
        box.minLat,
        mainshock.timeUtc,
        endUtc,
        SEQUENCE_MIN_MAGNITUDE,
        // The mainshock is inside its own window on every axis. Excluded by id
        // rather than by a strict time bound, so that a genuinely simultaneous
        // event elsewhere in the box still counts.
        mainshock.id,
      ),
  );

  const seen = new Set<string>();
  const events: EarthquakeEvent[] = [];
  for (const row of rows) {
    const event = rowToEvent(row);
    // The two antimeridian boxes are disjoint in longitude, so this cannot
    // currently fire. It is here because "the boxes are disjoint" is a property
    // of `sequenceSearchBoxes`, not of this function, and double-counting an
    // aftershock would be silent.
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (haversineKm(mainshock, event) <= radiusKm) events.push(event);
  }

  return events;
}

/**
 * The observed aftershock sequence for a mainshock — PROJECT_PLAN §5.9.
 *
 * Pure observation: it reports what the catalogue holds inside a window fixed
 * by Gardner & Knopoff (1974), and fits, extrapolates and predicts nothing.
 * That is what makes it Explore-safe under non-negotiable #1.
 *
 * `nowMs` is a parameter rather than a `Date.now()` call so the result is a
 * function of its inputs and the tests do not need a clock. It also clamps the
 * window: the future half of a recent mainshock's window has not happened, and
 * querying it would be asking the database for events that do not exist yet.
 */
export function queryAftershockSequence(
  db: DatabaseSync,
  mainshock: EarthquakeEvent,
  nowMs: number,
): AftershockSequence {
  const radiusKm = gardnerKnopoffRadiusKm(mainshock.magnitude);
  const windowDays = gardnerKnopoffWindowDays(mainshock.magnitude);
  const originMs = Date.parse(mainshock.timeUtc);

  const windowEndMs = originMs + windowDays * DAY_MS;
  const elapsedEndMs = Math.min(windowEndMs, nowMs);

  // A mainshock in the future relative to `nowMs` — reachable via the playhead
  // — has no elapsed window and therefore no sequence. Querying backwards would
  // return a time range with its ends crossed, which is a silent empty result
  // rather than the deliberate one.
  if (elapsedEndMs <= originMs) {
    return {
      summary: summariseSequence(mainshock, [], nowMs),
      missingYears: [],
    };
  }

  const events = queryWindow(db, mainshock, radiusKm, new Date(elapsedEndMs).toISOString());

  return {
    summary: summariseSequence(mainshock, events, nowMs),
    missingYears: uncoveredArchiveYears(db, originMs, elapsedEndMs, nowMs),
  };
}
