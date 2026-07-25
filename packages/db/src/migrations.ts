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
];
