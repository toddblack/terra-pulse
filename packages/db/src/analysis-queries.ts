import type { DatabaseSync } from 'node:sqlite';

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
