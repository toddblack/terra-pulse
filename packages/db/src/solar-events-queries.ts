import type { DatabaseSync } from 'node:sqlite';
import type { CmeArrival, SolarFlare } from '@terra-pulse/schema';

interface FlareRow {
  id: string;
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
 * Upserts flares by DONKI's own id.
 *
 * `SAVEPOINT`-wrapped like `insertSpaceWeather`, for the same reason: without a
 * transaction every row pays its own durability flush. DONKI does not
 * duplicate — see nasa-donki.ts's note on `parseFlares` — so a plain overwrite
 * on conflict is correct rather than a `COALESCE`: a later fetch of the same id
 * is a revision, not a second, partial observation of it.
 */
export function insertSolarFlares(db: DatabaseSync, flares: readonly SolarFlare[]): number {
  if (flares.length === 0) return 0;

  const statement = db.prepare(`
    INSERT INTO solar_flares
      (id, class_type, flare_class, magnitude, peak_time_utc, begin_time_utc,
       end_time_utc, source_location, active_region_number, link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

/** Flares peaking in a half-open range, oldest first. Bound on both ends — see `querySpaceWeather`. */
export function querySolarFlares(
  db: DatabaseSync,
  startUtc: string,
  endUtc: string,
): SolarFlare[] {
  const rows = db
    .prepare(
      `SELECT id, class_type, flare_class, magnitude, peak_time_utc, begin_time_utc,
              end_time_utc, source_location, active_region_number, link
         FROM solar_flares
        WHERE peak_time_utc >= ? AND peak_time_utc < ?
        ORDER BY peak_time_utc`,
    )
    .all(startUtc, endUtc) as unknown as FlareRow[];

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
