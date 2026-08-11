import type { DatabaseSync } from 'node:sqlite';
import {
  ANTIPODAL_SEARCH_KM,
  ANTIPODAL_TARGET_MIN_MAGNITUDE,
  ANTIPODAL_WINDOW_HOURS,
  ARCHIVE_START_YEAR,
  antipodeOf,
  haversineKm,
  sequenceSearchBoxes,
  summariseAntipodal,
  type AntipodalWindow,
  type EarthquakeEvent,
} from '@terra-pulse/schema';
import { rowToEvent } from './queries';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Qualifying events within `ANTIPODAL_SEARCH_KM` of a point, over a time range.
 *
 * Shares `sequenceSearchBoxes` with the aftershock and recurrence queries, which
 * matters more here than anywhere else: an antipode is *by construction* on the
 * far side of the world from its trigger, so roughly half of them land near the
 * date line. Without the antimeridian split this would silently return nothing
 * for exactly the cases the panel exists to examine.
 */
function queryNear(
  db: DatabaseSync,
  point: { latitude: number; longitude: number },
  startUtc: string,
  endUtc: string,
): EarthquakeEvent[] {
  const boxes = sequenceSearchBoxes(point, ANTIPODAL_SEARCH_KM);

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
      .all(
        box.maxLon,
        box.minLon,
        box.maxLat,
        box.minLat,
        startUtc,
        endUtc,
        ANTIPODAL_TARGET_MIN_MAGNITUDE,
      ),
  );

  const seen = new Set<string>();
  const events: EarthquakeEvent[] = [];
  for (const row of rows) {
    const event = rowToEvent(row);
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    // The R-Tree answers in rectangles; the corner of a 1000 km box is 1414 km
    // out, so the true distance decides membership.
    if (haversineKm(point, event) <= ANTIPODAL_SEARCH_KM) events.push(event);
  }

  return events;
}

/**
 * What the catalogue recorded near one event's antipode — PROJECT_PLAN §5.3.
 *
 * Descriptive only. It returns the events, their distance from the antipode and
 * their delay, **plus the background rate at that antipode**, and makes no claim
 * that any of them were triggered. The registered statistical test (H5) is a
 * separate, Analyze-side job.
 *
 * The background rate is computed here rather than left to the caller because it
 * is not optional context — it is what stops the list being read as evidence.
 * Measured over the whole archive at the same radius and floor, so it answers
 * exactly "how often does this happen here anyway".
 */
export function queryAntipodalWindow(
  db: DatabaseSync,
  trigger: EarthquakeEvent,
  nowMs: number,
): AntipodalWindow {
  const antipode = antipodeOf(trigger);
  const originMs = Date.parse(trigger.timeUtc);
  const windowEndMs = originMs + ANTIPODAL_WINDOW_HOURS * HOUR_MS;

  // Clamped to now: the remainder of a recent trigger's window has not happened,
  // and querying it would report an absence for time that does not exist yet.
  const elapsedEndMs = Math.min(windowEndMs, nowMs);

  const events =
    elapsedEndMs <= originMs
      ? []
      : queryNear(
          db,
          antipode,
          // Strictly after the trigger. An event at the same instant on the far
          // side of the planet cannot have been caused by it — no signal has
          // had time to travel — so including it would only add noise.
          new Date(originMs + 1).toISOString(),
          new Date(elapsedEndMs).toISOString(),
        );

  // Background: everything the archive holds near this antipode, over its full
  // span. The same radius and floor as the window above, so the two are
  // directly comparable.
  const epochMs = Date.UTC(ARCHIVE_START_YEAR, 0, 1);
  const background = queryNear(
    db,
    antipode,
    new Date(epochMs).toISOString(),
    new Date(nowMs).toISOString(),
  );

  return summariseAntipodal(trigger, events, {
    backgroundCount: background.length,
    backgroundYears: Math.max(0, (nowMs - epochMs) / (365.25 * 24 * HOUR_MS)),
    nowMs,
  });
}
