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
];
