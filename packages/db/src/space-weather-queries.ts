import type { DatabaseSync } from 'node:sqlite';
import type { SpaceWeatherSample } from '@terra-pulse/schema';

interface Row {
  time_utc: string;
  kp: number | null;
  dst: number | null;
  wind_speed: number | null;
  density: number | null;
  bz_gsm: number | null;
  xray_flux: number | null;
}

/**
 * Upserts a batch of hourly samples.
 *
 * Wrapped in a `SAVEPOINT` for the same reason `insertEarthquakes` is: without
 * a transaction every row pays its own durability flush, which measured 216x
 * slower on the earthquake path. A year of hourly data is 8,760 rows and a full
 * backfill is ~550,000, so this is the difference between seconds and minutes.
 *
 * `SAVEPOINT` rather than `BEGIN` so it nests inside a caller's transaction
 * instead of throwing.
 *
 * **Null does not overwrite a value.** A later pass may carry Kp but not Dst
 * for an hour we already have Dst for — provisional data being replaced by
 * final, or two sources with different coverage. `COALESCE(excluded.x, x)`
 * keeps whichever is known rather than letting a gap erase a measurement.
 */
export function insertSpaceWeather(
  db: DatabaseSync,
  samples: readonly SpaceWeatherSample[],
): number {
  if (samples.length === 0) return 0;

  const statement = db.prepare(`
    INSERT INTO space_weather (time_utc, kp, dst, wind_speed, density, bz_gsm, xray_flux)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(time_utc) DO UPDATE SET
      kp = COALESCE(excluded.kp, kp),
      dst = COALESCE(excluded.dst, dst),
      wind_speed = COALESCE(excluded.wind_speed, wind_speed),
      density = COALESCE(excluded.density, density),
      bz_gsm = COALESCE(excluded.bz_gsm, bz_gsm),
      xray_flux = COALESCE(excluded.xray_flux, xray_flux)
  `);

  db.exec('SAVEPOINT insert_space_weather');
  try {
    for (const sample of samples) {
      statement.run(
        sample.timeUtc,
        sample.kp,
        sample.dst,
        sample.windSpeed,
        sample.density,
        sample.bzGsm,
        sample.xrayFlux,
      );
    }
    db.exec('RELEASE insert_space_weather');
  } catch (error: unknown) {
    db.exec('ROLLBACK TO insert_space_weather');
    db.exec('RELEASE insert_space_weather');
    throw error;
  }

  return samples.length;
}

/**
 * Every sample in a half-open range, oldest first.
 *
 * Bound on both ends deliberately. An unbounded query over a full backfill is
 * 550,000 rows and roughly 30 MB of structured clone across IPC — the same
 * mistake `earthquakes:refresh` made before it was scoped, which cost 1.25 s
 * and ~100 MB per press.
 */
export function querySpaceWeather(
  db: DatabaseSync,
  startUtc: string,
  endUtc: string,
): SpaceWeatherSample[] {
  const rows = db
    .prepare(
      `SELECT time_utc, kp, dst, wind_speed, density, bz_gsm, xray_flux
         FROM space_weather
        WHERE time_utc >= ? AND time_utc < ?
        ORDER BY time_utc`,
    )
    .all(startUtc, endUtc) as unknown as Row[];

  return rows.map((row) => ({
    timeUtc: row.time_utc,
    kp: row.kp,
    dst: row.dst,
    windSpeed: row.wind_speed,
    density: row.density,
    bzGsm: row.bz_gsm,
    xrayFlux: row.xray_flux,
  }));
}

/**
 * Which years already hold data **for one index**, so a backfill knows what to
 * skip.
 *
 * ## Why this is per-index rather than per-row
 *
 * It used to ask "does this year have any sample?", which was a fair proxy while
 * one source carried both indices. It stopped being one the moment Kp moved to
 * GFZ: that fetch is a single request covering 1932 to today, so afterwards
 * *every* year holds samples — and a Dst backfill keyed on "any sample" would
 * skip all sixty-three OMNI years and quietly never fetch Dst again.
 *
 * The failure mode is the bad kind: no error, a backfill that reports complete
 * in seconds, and a track with no Dst on it.
 *
 * A year counts as present if it holds *any* value for that index, which is the
 * same standard as before — partial years are re-fetched only because the
 * current year always is.
 */
export function spaceWeatherYearsPresent(
  db: DatabaseSync,
  index: 'kp' | 'dst' | 'wind_speed',
): Set<number> {
  // Column names cannot be bound, so this maps through a fixed set rather than
  // interpolating the argument — parameterised SQL only, including here.
  const COLUMNS = { kp: 'kp', dst: 'dst', wind_speed: 'wind_speed' } as const;
  const column = COLUMNS[index];

  const rows = db
    .prepare(
      `SELECT DISTINCT substr(time_utc, 1, 4) AS year
         FROM space_weather
        WHERE ${column} IS NOT NULL
        ORDER BY year`,
    )
    .all() as unknown as { year: string }[];

  return new Set(rows.map((row) => Number(row.year)).filter((year) => Number.isFinite(year)));
}

/** Row count and the span covered, for the panel's status line. */
export function spaceWeatherCoverage(db: DatabaseSync): {
  samples: number;
  firstUtc: string | null;
  lastUtc: string | null;
} {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS samples, MIN(time_utc) AS first_utc, MAX(time_utc) AS last_utc
         FROM space_weather`,
    )
    .get() as unknown as { samples: number; first_utc: string | null; last_utc: string | null };

  return { samples: row.samples, firstUtc: row.first_utc, lastUtc: row.last_utc };
}
