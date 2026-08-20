import type { DatabaseSync } from 'node:sqlite';
import type { CmeArrival, FlareSource, SolarFlare } from '@terra-pulse/schema';
import { GOES_FLARE_LAST_YEAR } from '@terra-pulse/schema';

interface FlareRow {
  id: string;
  source: string;
  class_type: string;
  flare_class: string;
  magnitude: number;
  peak_time_utc: string;
  begin_time_utc: string | null;
  end_time_utc: string | null;
  source_location: string | null;
  active_region_number: number | null;
  link: string | null;
}

interface CmeRow {
  simulation_id: string;
  arrival_time_utc: string;
  predicted_kp: number | null;
  glancing_blow: number;
  minor_impact: number;
  link: string | null;
}

/**
 * Upserts flares by id.
 *
 * `SAVEPOINT`-wrapped like `insertSpaceWeather`, for the same reason: without a
 * transaction every row pays its own durability flush. A plain overwrite on
 * conflict is correct rather than a `COALESCE`, for both catalogues but for
 * slightly different reasons: DONKI revises records in place under a stable id
 * (see nasa-donki.ts's note on `parseFlares`), so a later fetch is a revision
 * rather than a second partial observation; GOES never changes a published year,
 * so a conflict there means the same row re-ingested and overwriting it is a
 * no-op that keeps re-running the backfill idempotent.
 *
 * `source` is written but deliberately **not** in the `DO UPDATE SET` list — a
 * row's catalogue is part of its identity, and an id collision across the two
 * namespaces would be a bug rather than something to silently reassign.
 */
export function insertSolarFlares(db: DatabaseSync, flares: readonly SolarFlare[]): number {
  if (flares.length === 0) return 0;

  const statement = db.prepare(`
    INSERT INTO solar_flares
      (id, source, class_type, flare_class, magnitude, peak_time_utc, begin_time_utc,
       end_time_utc, source_location, active_region_number, link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      class_type = excluded.class_type,
      flare_class = excluded.flare_class,
      magnitude = excluded.magnitude,
      peak_time_utc = excluded.peak_time_utc,
      begin_time_utc = excluded.begin_time_utc,
      end_time_utc = excluded.end_time_utc,
      source_location = excluded.source_location,
      active_region_number = excluded.active_region_number,
      link = excluded.link
  `);

  db.exec('SAVEPOINT insert_solar_flares');
  try {
    for (const flare of flares) {
      statement.run(
        flare.id,
        flare.source,
        flare.classType,
        flare.flareClass,
        flare.magnitude,
        flare.peakTimeUtc,
        flare.beginTimeUtc,
        flare.endTimeUtc,
        flare.sourceLocation,
        flare.activeRegionNumber,
        flare.link,
      );
    }
    db.exec('RELEASE insert_solar_flares');
  } catch (error: unknown) {
    db.exec('ROLLBACK TO insert_solar_flares');
    db.exec('RELEASE insert_solar_flares');
    throw error;
  }

  return flares.length;
}

/** Upserts CME arrivals by their simulation id. Same shape as `insertSolarFlares`. */
export function insertCmeArrivals(db: DatabaseSync, arrivals: readonly CmeArrival[]): number {
  if (arrivals.length === 0) return 0;

  const statement = db.prepare(`
    INSERT INTO cme_arrivals
      (simulation_id, arrival_time_utc, predicted_kp, glancing_blow, minor_impact, link)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(simulation_id) DO UPDATE SET
      arrival_time_utc = excluded.arrival_time_utc,
      predicted_kp = excluded.predicted_kp,
      glancing_blow = excluded.glancing_blow,
      minor_impact = excluded.minor_impact,
      link = excluded.link
  `);

  db.exec('SAVEPOINT insert_cme_arrivals');
  try {
    for (const arrival of arrivals) {
      statement.run(
        arrival.simulationId,
        arrival.arrivalTimeUtc,
        arrival.predictedKp,
        arrival.glancingBlow ? 1 : 0,
        arrival.minorImpact ? 1 : 0,
        arrival.link,
      );
    }
    db.exec('RELEASE insert_cme_arrivals');
  } catch (error: unknown) {
    db.exec('ROLLBACK TO insert_cme_arrivals');
    db.exec('RELEASE insert_cme_arrivals');
    throw error;
  }

  return arrivals.length;
}

function flareFromRow(row: FlareRow): SolarFlare {
  return {
    id: row.id,
    source: row.source as FlareSource,
    classType: row.class_type,
    flareClass: row.flare_class as SolarFlare['flareClass'],
    magnitude: row.magnitude,
    peakTimeUtc: row.peak_time_utc,
    beginTimeUtc: row.begin_time_utc,
    endTimeUtc: row.end_time_utc,
    sourceLocation: row.source_location,
    activeRegionNumber: row.active_region_number,
    link: row.link,
  };
}

function cmeArrivalFromRow(row: CmeRow): CmeArrival {
  return {
    simulationId: row.simulation_id,
    arrivalTimeUtc: row.arrival_time_utc,
    predictedKp: row.predicted_kp,
    glancingBlow: row.glancing_blow === 1,
    minorImpact: row.minor_impact === 1,
    link: row.link,
  };
}

/**
 * The year after the last GOES-owned one, as an ISO instant — the single
 * boundary in the SQL below. Derived from the schema constant rather than
 * written as a literal, so the registered join moves in one place if it ever
 * moves at all.
 */
const DONKI_OWNS_FROM_UTC = `${String(GOES_FLARE_LAST_YEAR + 1)}-01-01T00:00:00.000Z`;

export interface QuerySolarFlaresOptions {
  /**
   * `'preferred'` (the default) applies H1b's registered join — GOES at or
   * below `GOES_FLARE_LAST_YEAR`, DONKI above it — so each flare is returned
   * exactly once. `'all'` returns both catalogues including the 2014-2016
   * overlap, which is what checking that they agree needs, and is *never* what
   * a count or a drawn layer wants.
   */
  source?: 'preferred' | 'all' | FlareSource;
}

/**
 * Flares peaking in a half-open range, oldest first. Bound on both ends — see
 * `querySpaceWeather`.
 *
 * **Defaults to one catalogue per year, not to everything stored.** Both
 * catalogues overlap across 2014-2016, so an unfiltered read would return the
 * same flare twice — double-counting it in H1b's trigger set and drawing it
 * twice on the globe. The default here is the same rule the analysis uses, so
 * the marks and the count cannot disagree; `{ source: 'all' }` is the explicit
 * opt-in for comparing the two.
 */
export function querySolarFlares(
  db: DatabaseSync,
  startUtc: string,
  endUtc: string,
  options: QuerySolarFlaresOptions = {},
): SolarFlare[] {
  const source = options.source ?? 'preferred';
  const columns = `id, source, class_type, flare_class, magnitude, peak_time_utc,
                   begin_time_utc, end_time_utc, source_location, active_region_number, link`;

  if (source === 'preferred') {
    const rows = db
      .prepare(
        `SELECT ${columns}
           FROM solar_flares
          WHERE peak_time_utc >= ? AND peak_time_utc < ?
            AND ((source = 'goes' AND peak_time_utc < ?)
              OR (source = 'donki' AND peak_time_utc >= ?))
          ORDER BY peak_time_utc`,
      )
      .all(startUtc, endUtc, DONKI_OWNS_FROM_UTC, DONKI_OWNS_FROM_UTC) as unknown as FlareRow[];
    return rows.map(flareFromRow);
  }

  if (source === 'all') {
    const rows = db
      .prepare(
        `SELECT ${columns}
           FROM solar_flares
          WHERE peak_time_utc >= ? AND peak_time_utc < ?
          ORDER BY peak_time_utc`,
      )
      .all(startUtc, endUtc) as unknown as FlareRow[];
    return rows.map(flareFromRow);
  }

  const rows = db
    .prepare(
      `SELECT ${columns}
         FROM solar_flares
        WHERE peak_time_utc >= ? AND peak_time_utc < ? AND source = ?
        ORDER BY peak_time_utc`,
    )
    .all(startUtc, endUtc, source) as unknown as FlareRow[];
  return rows.map(flareFromRow);
}

/** CME arrivals in a half-open range, oldest first. */
export function queryCmeArrivals(
  db: DatabaseSync,
  startUtc: string,
  endUtc: string,
): CmeArrival[] {
  const rows = db
    .prepare(
      `SELECT simulation_id, arrival_time_utc, predicted_kp, glancing_blow, minor_impact, link
         FROM cme_arrivals
        WHERE arrival_time_utc >= ? AND arrival_time_utc < ?
        ORDER BY arrival_time_utc`,
    )
    .all(startUtc, endUtc) as unknown as CmeRow[];

  return rows.map(cmeArrivalFromRow);
}

export type DonkiSource = 'flares' | 'cme';

/**
 * Marks one year, for one source, done. Call only once its records are
 * committed — see `recordArchiveChunk`, whose role this mirrors exactly.
 */
export function recordDonkiChunk(
  db: DatabaseSync,
  year: number,
  source: DonkiSource,
  eventCount: number,
): void {
  db.prepare(
    `INSERT INTO donki_chunks (year, source, event_count, completed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(year, source) DO UPDATE SET
       event_count = excluded.event_count,
       completed_at = excluded.completed_at`,
  ).run(year, source, eventCount, new Date().toISOString());
}

/**
 * Years already fetched for one source.
 *
 * Explicit bookkeeping rather than "does this year have any rows" — DONKI can
 * legitimately return few or zero records for a quiet year on either source,
 * which row presence cannot tell apart from "never fetched". See the note on
 * migration 9.
 */
export function completedDonkiYears(db: DatabaseSync, source: DonkiSource): Set<number> {
  const rows = db.prepare('SELECT year FROM donki_chunks WHERE source = ?').all(source);
  return new Set(rows.map((row) => row['year'] as number));
}

export function donkiChunkSummary(
  db: DatabaseSync,
  source: DonkiSource,
): { completedChunks: number; storedEvents: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS chunks, COALESCE(SUM(event_count), 0) AS events
         FROM donki_chunks WHERE source = ?`,
    )
    .get(source);

  return {
    completedChunks: Number(row?.['chunks'] ?? 0),
    storedEvents: Number(row?.['events'] ?? 0),
  };
}

/**
 * Marks one GOES year done. Call only once its flares are committed — the same
 * contract `recordArchiveChunk` and `recordDonkiChunk` carry.
 *
 * No `source` argument, unlike the DONKI pair: there is only one thing to fetch
 * here. And no "is this year final" question either — the record is closed at
 * 2016, so every year in range is final by construction.
 */
export function recordGoesFlareChunk(db: DatabaseSync, year: number, eventCount: number): void {
  db.prepare(
    `INSERT INTO goes_flare_chunks (year, event_count, completed_at)
     VALUES (?, ?, ?)
     ON CONFLICT(year) DO UPDATE SET
       event_count = excluded.event_count,
       completed_at = excluded.completed_at`,
  ).run(year, eventCount, new Date().toISOString());
}

/**
 * GOES years already fetched.
 *
 * Explicit bookkeeping rather than "does this year have any rows", and this
 * record makes the case unusually well: **2009 has zero M/X flares** and several
 * solar-minimum years have almost none, so row presence genuinely cannot tell a
 * quiet year from an unfetched one.
 */
export function completedGoesFlareYears(db: DatabaseSync): Set<number> {
  const rows = db.prepare('SELECT year FROM goes_flare_chunks').all();
  return new Set(rows.map((row) => row['year'] as number));
}

export function goesFlareChunkSummary(db: DatabaseSync): {
  completedChunks: number;
  storedEvents: number;
} {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS chunks, COALESCE(SUM(event_count), 0) AS events
         FROM goes_flare_chunks`,
    )
    .get();

  return {
    completedChunks: Number(row?.['chunks'] ?? 0),
    storedEvents: Number(row?.['events'] ?? 0),
  };
}
