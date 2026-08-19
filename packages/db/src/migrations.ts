export interface Migration {
  id: number;
  name: string;
  sql: string;
}

// Inline SQL rather than separate .sql files: this package gets bundled by
// Vite when consumed from the Electron main process, and bundlers don't
// reliably carry non-JS assets like .sql files along for the ride. A plain
// exported string sidesteps that entirely.
//
// Spatial index is SQLite's own built-in R-Tree module, not SpatiaLite.
// SpatiaLite was tried first (matching the original stack choice) but the
// only available Windows binary (spatialite-bin, unmaintained, bundling a
// 2016-era GEOS build) fails its own DLL init on this system even once the
// Windows DLL search-path issue is worked around — a wall, not a quick fix.
// R-Tree ships inside SQLite core, so there's no extension/binary to load
// at all, and it covers what's actually needed (bbox/radius queries).
//
// `row_id` is a real, separate INTEGER PRIMARY KEY (not the USGS id) so it
// stays stable across re-ingestion — usgs_id is upserted via
// ON CONFLICT...DO UPDATE, which updates in place rather than delete+insert,
// so row_id (and therefore the linked rtree row) never drifts.
//
// ---------------------------------------------------------------------------
// WRITING MIGRATION 3 AND BEYOND: preserve, don't recreate.
//
// Migration 2 drops and recreates `earthquakes`. That was a sound call at the
// time and is explained in place, but it is not a precedent — it was only safe
// because the table then held four days of trivially refetchable cache. Tier 1
// (M4.5+, 1970–present, ~295k rows) changes that permanently.
//
// SQLite still cannot ALTER a column's type or nullability, so a schema change
// of that kind is create-copy-drop-rename:
//
//   CREATE TABLE earthquakes_new (...the new shape...);
//   INSERT INTO earthquakes_new (col, ...) SELECT col, ... FROM earthquakes;
//   DROP TABLE earthquakes;
//   ALTER TABLE earthquakes_new RENAME TO earthquakes;
//   -- indexes go with the old table; recreate every one.
//
// Two things that are easy to get wrong here:
//
//   - `row_id` must be carried across explicitly in the SELECT. Let SQLite
//     reassign it and every row silently unlinks from its `earthquakes_rtree`
//     entry, which does not error — it just makes dedup stop finding matches.
//   - The R-Tree itself needs no rebuild as long as row_id is preserved, and
//     should not get one. Rebuilding it is slow and buys nothing.
//
// The runner wraps each migration in a transaction (see `migrate.ts`), so a
// rebuild that fails partway leaves the old table untouched rather than half
// copied. `migrate.test.ts` exercises exactly this shape.
// ---------------------------------------------------------------------------
export const migrations: Migration[] = [
  {
    id: 1,
    name: 'init',
    sql: `
      CREATE TABLE earthquakes (
        row_id INTEGER PRIMARY KEY,
        usgs_id TEXT NOT NULL UNIQUE,
        magnitude REAL NOT NULL,
        magnitude_type TEXT NOT NULL,
        place TEXT NOT NULL,
        time_utc TEXT NOT NULL,
        updated_utc TEXT NOT NULL,
        longitude REAL NOT NULL,
        latitude REAL NOT NULL,
        depth_km REAL NOT NULL,
        status TEXT NOT NULL,
        tsunami INTEGER NOT NULL,
        alert_level TEXT,
        significance INTEGER NOT NULL,
        url TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE earthquakes_rtree USING rtree(
        id,
        min_lon, max_lon,
        min_lat, max_lat
      );
    `,
  },
  {
    id: 2,
    name: 'multi_source',
    // Adds `source` and relaxes two columns to NULL, because EMSC genuinely
    // does not provide them and defaulting would state something false —
    // significance 0 and significance unknown are different claims.
    //
    // Drops and recreates rather than rebuilding in place. SQLite cannot
    // relax NOT NULL on an existing column, and the alternative (create-copy-
    // drop-rename) buys nothing *today*: this table is a self-healing cache,
    // backfill runs on every launch, and only 4 days are retained. There is
    // nothing here to lose.
    //
    // THIS STOPS BEING TRUE once Tier 1 lands (M4.5+, 1970–present, ~295k
    // rows — PROJECT_PLAN §Storage). From that point a migration touching
    // this table MUST preserve data, because re-fetching decades of catalogue
    // is not a free operation. See the create-copy-drop-rename note above;
    // this migration is history, not a template.
    //
    // Left exactly as written. It is already applied on existing installs, and
    // editing an applied migration means the code and the database on disk
    // disagree about what that id did.
    //
    // `usgs_id` becomes `event_id` — with two sources the old name lies.
    sql: `
      DROP TABLE IF EXISTS earthquakes;
      DROP TABLE IF EXISTS earthquakes_rtree;

      CREATE TABLE earthquakes (
        row_id INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        magnitude REAL NOT NULL,
        magnitude_type TEXT NOT NULL,
        place TEXT NOT NULL,
        time_utc TEXT NOT NULL,
        updated_utc TEXT NOT NULL,
        longitude REAL NOT NULL,
        latitude REAL NOT NULL,
        depth_km REAL NOT NULL,
        status TEXT,
        tsunami INTEGER NOT NULL,
        alert_level TEXT,
        significance INTEGER,
        url TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE earthquakes_rtree USING rtree(
        id,
        min_lon, max_lon,
        min_lat, max_lat
      );

      -- Dedup looks up candidates by source and time; the R-Tree narrows
      -- spatially, this narrows the rest.
      CREATE INDEX idx_earthquakes_source_time ON earthquakes (source, time_utc);
    `,
  },
  {
    id: 3,
    name: 'historical_archive',
    // Bookkeeping for the Tier 1 backfill, plus the index that stops a 295k-row
    // table from being scanned end to end on every launch.
    //
    // Adds only — no rebuild needed, so the create-copy-drop-rename pattern
    // documented above doesn't come into it. A new table and a new index are
    // both safe as plain DDL; that pattern is for changing the shape of columns
    // that already hold data.
    //
    // `year` is the primary key rather than a surrogate id because a chunk's
    // identity *is* its year — see `archiveChunks` in packages/schema, where
    // chunk boundaries are fixed calendar years precisely so that resuming a
    // backfill lines up with what a previous run recorded. Making the year the
    // key means a re-run cannot record the same chunk twice, and a chunk plan
    // that ever stopped being year-aligned would collide loudly here instead of
    // silently leaving gaps.
    //
    // A row in this table means "every event in this year, at or above the
    // archive floor, is in `earthquakes`". It is written only after the chunk's
    // events are committed, so a crash mid-chunk leaves the year unrecorded and
    // the next run refetches it — the upsert makes that harmless.
    sql: `
      CREATE TABLE archive_chunks (
        year INTEGER PRIMARY KEY,
        start_utc TEXT NOT NULL,
        end_utc TEXT NOT NULL,
        min_magnitude REAL NOT NULL,
        event_count INTEGER NOT NULL,
        completed_at TEXT NOT NULL
      );

      -- Prune filters on time and magnitude together, and the archive makes
      -- that a ~295k-row scan on every launch without this. Ordered time-first
      -- because the time bound is the selective one and because
      -- queryEarthquakes sorts by time_utc.
      CREATE INDEX idx_earthquakes_time_magnitude ON earthquakes (time_utc, magnitude);
    `,
  },
  {
    id: 4,
    name: 'nullable_depth',
    // Relaxes `depth_km` to allow NULL, because USGS genuinely has no depth for
    // a handful of historical events and the archive backfill hits them: the
    // 1970 and 1975 chunks both failed on SQLITE_CONSTRAINT_NOTNULL before this.
    // Measured across ~48,500 sampled archive events, 4 lack a depth, all
    // pre-1980. Defaulting to 0 would state something false — see the rule in
    // packages/schema/src/earthquake.ts.
    //
    // **The first data-preserving rebuild.** SQLite cannot relax NOT NULL in
    // place, so this is the create-copy-drop-rename documented at the top of
    // this file, and unlike migration 2 it has real data to keep — an archive
    // this lands after would cost ~15 minutes of refetching.
    //
    // `row_id` is carried across explicitly in the SELECT. That is the whole
    // ballgame: let SQLite reassign it and every row silently unlinks from its
    // `earthquakes_rtree` entry, no error, and spatial queries quietly start
    // returning nothing.
    //
    // The R-Tree itself is deliberately untouched. It keys on row_id, row_id is
    // preserved, so it stays correct — rebuilding it would be slow and pointless.
    sql: `
      CREATE TABLE earthquakes_new (
        row_id INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        magnitude REAL NOT NULL,
        magnitude_type TEXT NOT NULL,
        place TEXT NOT NULL,
        time_utc TEXT NOT NULL,
        updated_utc TEXT NOT NULL,
        longitude REAL NOT NULL,
        latitude REAL NOT NULL,
        depth_km REAL,
        status TEXT,
        tsunami INTEGER NOT NULL,
        alert_level TEXT,
        significance INTEGER,
        url TEXT NOT NULL
      );

      INSERT INTO earthquakes_new
        (row_id, event_id, source, magnitude, magnitude_type, place, time_utc,
         updated_utc, longitude, latitude, depth_km, status, tsunami,
         alert_level, significance, url)
      SELECT
         row_id, event_id, source, magnitude, magnitude_type, place, time_utc,
         updated_utc, longitude, latitude, depth_km, status, tsunami,
         alert_level, significance, url
      FROM earthquakes;

      DROP TABLE earthquakes;
      ALTER TABLE earthquakes_new RENAME TO earthquakes;

      -- Indexes belong to the dropped table; both have to come back.
      CREATE INDEX idx_earthquakes_source_time ON earthquakes (source, time_utc);
      CREATE INDEX idx_earthquakes_time_magnitude ON earthquakes (time_utc, magnitude);
    `,
  },
  {
    id: 5,
    name: 'app_state',
    // A tiny key-value store for things that must outlive a run — currently
    // just "how far through the catalogue has the user actually seen", which
    // the launch summary needs in order to answer "what did I miss".
    //
    // Deliberately key-value rather than a column per setting. These are single
    // scalars read one at a time, and a schema change per preference would mean
    // a create-copy-drop-rename per preference.
    //
    // Adds only — no rebuild, so the pattern documented at the top of this file
    // doesn't apply.
    sql: `
      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 6,
    name: 'space_weather',
    // Hourly Kp and Dst, from 1963. Unlike the auroral oval — which is a
    // nowcast nobody archives, and so is never written to disk — these are
    // records: true when measured and true forever after, and the data H4 is
    // registered against.
    //
    // ## Why both columns are nullable, independently
    //
    // Kp and Dst come from different observatory networks with different
    // reporting lags, and OMNI carries real gaps. A missing hour has to stay
    // missing: filling it with zero would read as "quiet", which is a
    // measurement nobody made, and it would bias any rate computed over it.
    //
    // ## Why the hour is the primary key
    //
    // Both indices are defined per UTC hour, so the hour *is* the identity.
    // That makes re-ingest idempotent — a year refetched because its data was
    // provisional overwrites rather than duplicating — with no surrogate id and
    // no dedupe pass.
    //
    // Adds only, so the create-copy-drop-rename pattern at the top of this file
    // doesn't apply.
    sql: `
      CREATE TABLE space_weather (
        time_utc TEXT PRIMARY KEY,
        kp REAL,
        dst INTEGER
      );

      CREATE INDEX idx_space_weather_time ON space_weather (time_utc);
    `,
  },
  {
    id: 7,
    name: 'solar_wind_columns',
    // Solar wind speed and IMF Bz, alongside the geomagnetic indices they share
    // an hour with. Speed is H3's registered quantity; Bz is not registered for
    // anything and is carried for Explore and for §5.6's magnetopause work.
    //
    // ## Why this costs no new download
    //
    // Both come out of the *same OMNI2 year files* the Dst backfill already
    // fetches — the adapter was parsing two columns out of 55 and discarding
    // these. Backfilling them re-reads bytes we were downloading anyway.
    //
    // ## Why they are nullable, and why that matters more here than for Kp
    //
    // Solar wind coverage depends on a spacecraft being at L1, and for a decade
    // none was: measured hourly coverage runs 92% in 1980, collapses to 32-42%
    // from 1985 to 1994 after ISEE-3 left L1, and recovers to 98-100% from 1995
    // with WIND and then ACE. Null is therefore the *common* case across a
    // third of the record, not an edge case, and it must never be read as calm
    // solar wind. See SOLAR_WIND_COMPLETE_SINCE_YEAR.
    //
    // Adds only, so the create-copy-drop-rename pattern at the top of this file
    // doesn't apply. SQLite's ADD COLUMN backfills existing rows with NULL,
    // which is exactly right: those hours were never measured for these fields.
    sql: `
      ALTER TABLE space_weather ADD COLUMN wind_speed REAL;
      ALTER TABLE space_weather ADD COLUMN bz_gsm REAL;
    `,
  },
  {
    id: 8,
    name: 'solar_wind_density',
    // Proton density, for dynamic pressure — the quantity that actually
    // compresses the dayside magnetosphere, and the input §5.6's magnetopause
    // standoff needs. Pressure goes as density x speed^2, and neither number
    // alone says how hard the wind is pushing: a fast tenuous stream and a slow
    // dense one can exert the same force.
    //
    // Added as its own migration rather than folded into 7, because 7 has
    // already been applied on at least one machine and editing applied history
    // desynchronises the code from disk — the rule at the top of this file.
    //
    // Density and not OMNI's precomputed flow-pressure column: SWPC's live
    // product publishes density and no pressure, so taking pressure from one
    // source and deriving it in the other would put two subtly different
    // quantities in one series. OMNI's includes an alpha-particle correction a
    // proton-only derivation does not.
    sql: `
      ALTER TABLE space_weather ADD COLUMN density REAL;
    `,
  },
  {
    id: 9,
    name: 'solar_events',
    // Solar flares and CME arrivals from NASA DONKI — the data H1b and H2b are
    // registered against. See packages/ingest/src/nasa-donki.ts for the fetch
    // side and packages/schema/src/solar-events.ts for the parsed shape.
    //
    // Three tables, adds only:
    //
    // - `solar_flares` / `cme_arrivals`: one row per DONKI record, keyed on
    //   DONKI's own id. Both are natural keys DONKI assigns and revises in
    //   place rather than duplicating (see nasa-donki.ts's note on why no
    //   dedupe pass is needed), so an upsert on the key is idempotent re-ingest
    //   with no surrogate id.
    // - `donki_chunks`: bookkeeping only, the same role `archive_chunks` plays
    //   for the earthquake archive. Necessary rather than decorative: DONKI is
    //   fetched by year like the earthquake archive, and a quiet year
    //   (legitimately few or zero M-class flares, or zero CME arrivals) is
    //   indistinguishable from a year nobody has fetched yet if completion is
    //   inferred from row presence. That is the exact trap
    //   `OMNI_FIELDS_VERSION` (see space-weather.ts) exists to name — here it's
    //   avoided from the start with real bookkeeping instead of a presence
    //   test. One table for both sources (`source` column) rather than two,
    //   since the only thing recorded is "this year, this source, done".
    sql: `
      CREATE TABLE solar_flares (
        id TEXT PRIMARY KEY,
        class_type TEXT NOT NULL,
        flare_class TEXT NOT NULL,
        magnitude REAL NOT NULL,
        peak_time_utc TEXT NOT NULL,
        begin_time_utc TEXT,
        end_time_utc TEXT,
        source_location TEXT,
        active_region_number INTEGER,
        link TEXT
      );

      CREATE INDEX idx_solar_flares_peak_time ON solar_flares (peak_time_utc);

      CREATE TABLE cme_arrivals (
        simulation_id TEXT PRIMARY KEY,
        arrival_time_utc TEXT NOT NULL,
        predicted_kp REAL,
        glancing_blow INTEGER NOT NULL,
        minor_impact INTEGER NOT NULL,
        link TEXT
      );

      CREATE INDEX idx_cme_arrivals_time ON cme_arrivals (arrival_time_utc);

      CREATE TABLE donki_chunks (
        year INTEGER NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('flares', 'cme')),
        event_count INTEGER NOT NULL,
        completed_at TEXT NOT NULL,
        PRIMARY KEY (year, source)
      );
    `,
  },
  {
    id: 10,
    name: 'space_weather_xray_flux',
    // GOES X-ray flux (0.1-0.8 nm / 1-8 Å, the channel flare classification is
    // defined on), riding the same hourly row every other space-weather
    // quantity does. See SpaceWeatherSample.xrayFlux in packages/schema for
    // why this is the long channel specifically, not the short one GOES also
    // publishes.
    //
    // Unlike Kp/Dst/wind, there is no historical backfill for this column yet
    // — SWPC's JSON product is a live-only rolling window, and a real archive
    // (NOAA NCEI, per-satellite-era netCDF/CSV files) is a separate, larger
    // undertaking. Adding the column now costs nothing and means a future
    // historical ingest needs no migration of its own — it would insert into
    // rows that already exist, the same as any other index's backfill would.
    //
    // Adds only, so the create-copy-drop-rename pattern at the top of this
    // file doesn't apply.
    sql: `
      ALTER TABLE space_weather ADD COLUMN xray_flux REAL;
    `,
  },
];
