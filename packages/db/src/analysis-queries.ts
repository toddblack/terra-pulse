import type { DatabaseSync } from 'node:sqlite';
import { MECHANISM_JOIN_WINDOW_MS, matchMechanisms } from '@terra-pulse/schema';
import { queryFocalMechanisms } from './focal-mechanism-queries';

/**
 * The earthquake catalogue in the shape the Phase 4 engine actually wants:
 * four parallel arrays, not `EarthquakeEvent[]`.
 *
 * At the M5.0+ floor H4c registers, the catalogue is ~90k rows. As row
 * objects that is tens of MB of JSON and a matching number of allocations on
 * both sides of the IPC/HTTP boundary; as four flat arrays it's a fraction
 * of that and drops straight into numpy with `np.asarray` on the engine
 * side. See `apps/desktop/src/main/ipc/analysis.ts`, which is the only
 * caller — this is not a general-purpose earthquake query, it exists for
 * exactly this payload.
 *
 * Epoch **milliseconds**, not ISO strings: one conversion here, none on the
 * engine side, and no timezone parsing in Python.
 */
export interface AnalysisCatalog {
  timeMs: number[];
  latitude: number[];
  longitude: number[];
  magnitude: number[];
}

interface Row {
  time_ms: number;
  latitude: number;
  longitude: number;
  magnitude: number;
}

/**
 * Ordered by time — the engine's declustering and lag-window code both
 * require a sorted array and would otherwise have to sort 90k rows
 * themselves. `strftime('%s', time_utc) * 1000` avoids a round trip through
 * a string epoch in JS; SQLite's `strftime` returns whole seconds, and this
 * catalogue has no sub-second precision that would lose.
 *
 * Uses the existing `(time_utc, magnitude)` index — verified with
 * `EXPLAIN QUERY PLAN` against the real 314k-row dev database rather than
 * assumed, per this codebase's own history of composite indexes that looked
 * fine and weren't (`findCandidateMatches`, `catalogSignature`).
 */
export function queryAnalysisCatalog(
  db: DatabaseSync,
  options: { minMagnitude: number; startUtc: string; endUtc: string },
): AnalysisCatalog {
  const rows = db
    .prepare(
      `SELECT CAST(strftime('%s', time_utc) AS INTEGER) * 1000 AS time_ms, latitude, longitude, magnitude
         FROM earthquakes
        WHERE magnitude >= ? AND time_utc >= ? AND time_utc < ?
        ORDER BY time_utc`,
    )
    .all(options.minMagnitude, options.startUtc, options.endUtc) as unknown as Row[];

  return {
    timeMs: rows.map((row) => row.time_ms),
    latitude: rows.map((row) => row.latitude),
    longitude: rows.map((row) => row.longitude),
    magnitude: rows.map((row) => row.magnitude),
  };
}

/**
 * `AnalysisCatalog` plus each event's fault orientation, for H6.
 *
 * The three orientation arrays are parallel to the others and carry `null`
 * where Global CMT has no mechanism for that event — about 11.5% of M5.5+
 * events since 1976, measured. That is ordinary rather than exceptional, and
 * the engine excludes those events *after* declustering, never before.
 */
export interface OrientedAnalysisCatalog extends AnalysisCatalog {
  np1Strike: (number | null)[];
  np1Dip: (number | null)[];
  np1Rake: (number | null)[];
}

interface OrientedRow {
  time_utc: string;
  time_ms: number;
  latitude: number;
  longitude: number;
  magnitude: number;
}

/**
 * The catalogue with Global CMT orientations joined on, in time order.
 *
 * The join lives here rather than in main so there is one definition of it,
 * and it is `matchMechanisms` — the same sweep the ingest verification used,
 * with its one-mechanism-to-one-event rule. Reimplementing "nearest mechanism"
 * at the call site would drop that rule, and the failure is quiet: a smaller
 * event seconds after a mainshock silently inherits the mainshock's fault
 * orientation. See `matchMechanisms` for the 53 real cases behind it.
 *
 * Mechanisms are read over the same time range as the events, widened by the
 * join window so an event at either edge can still match one just outside it.
 * Without that widening the first and last events of the span would be
 * systematically unoriented — a small effect, and exactly the kind that is
 * invisible until someone asks why coverage dips at the ends.
 */
export function queryOrientedAnalysisCatalog(
  db: DatabaseSync,
  options: { minMagnitude: number; startUtc: string; endUtc: string },
): OrientedAnalysisCatalog {
  const rows = db
    .prepare(
      `SELECT time_utc,
              CAST(strftime('%s', time_utc) AS INTEGER) * 1000 AS time_ms,
              latitude, longitude, magnitude
         FROM earthquakes
        WHERE magnitude >= ? AND time_utc >= ? AND time_utc < ?
        ORDER BY time_utc`,
    )
    .all(options.minMagnitude, options.startUtc, options.endUtc) as unknown as OrientedRow[];

  const padMs = MECHANISM_JOIN_WINDOW_MS;
  const mechanisms = queryFocalMechanisms(db, {
    startUtc: new Date(Date.parse(options.startUtc) - padMs).toISOString(),
    endUtc: new Date(Date.parse(options.endUtc) + padMs).toISOString(),
  });

  const events = rows.map((row, index) => ({
    index,
    timeUtc: row.time_utc,
    latitude: row.latitude,
    longitude: row.longitude,
  }));

  const np1Strike: (number | null)[] = rows.map(() => null);
  const np1Dip: (number | null)[] = rows.map(() => null);
  const np1Rake: (number | null)[] = rows.map(() => null);

  for (const match of matchMechanisms(events, mechanisms).matched) {
    const { index } = match.event;
    np1Strike[index] = match.mechanism.nodalPlane1.strike;
    np1Dip[index] = match.mechanism.nodalPlane1.dip;
    np1Rake[index] = match.mechanism.nodalPlane1.rake;
  }

  return {
    timeMs: rows.map((row) => row.time_ms),
    latitude: rows.map((row) => row.latitude),
    longitude: rows.map((row) => row.longitude),
    magnitude: rows.map((row) => row.magnitude),
    np1Strike,
    np1Dip,
    np1Rake,
  };
}
