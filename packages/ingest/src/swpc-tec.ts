import {
  TEC_GRID_HEIGHT,
  TEC_GRID_WIDTH,
  type TecGrid,
} from '@terra-pulse/schema';

/**
 * Total electron content from NOAA SWPC's GloTEC product.
 *
 * ## Two requests, not one
 *
 * SWPC publishes an **index** of every available map — 4,464 entries at
 * ten-minute cadence, about a month — and the maps themselves separately. So a
 * fetch is: read the index, take the newest entry, fetch that file. The index
 * is small; each map is ~2.4 MB.
 *
 * ## Why the caller decides when to fetch
 *
 * 2.4 MB is **37 times** the auroral grid, so polling it on a timer regardless
 * of whether anyone is looking would be ~14 MB an hour spent on a layer that is
 * off by default. This adapter is a plain fetch with no schedule of its own;
 * main caches the result and only goes back to the network when the cache is
 * stale *and* something asked.
 */
const INDEX_URL = 'https://services.swpc.noaa.gov/products/glotec/geojson_2d_urt.json';

const HOST = 'https://services.swpc.noaa.gov';

interface IndexEntry {
  url?: unknown;
  time_tag?: unknown;
}

/** Fetches the most recent published map. */
export async function fetchTecGrid(fetchImpl: typeof fetch = fetch): Promise<TecGrid> {
  const indexResponse = await fetchImpl(INDEX_URL);
  if (!indexResponse.ok) {
    throw new Error(
      `GloTEC index: HTTP ${String(indexResponse.status)} ${indexResponse.statusText}`,
    );
  }

  const index: unknown = await indexResponse.json();
  if (!Array.isArray(index) || index.length === 0) {
    throw new Error('GloTEC index: empty');
  }

  // The index is published oldest-first; the newest map is the last entry.
  const newest = index[index.length - 1] as IndexEntry;
  if (typeof newest.url !== 'string') throw new Error('GloTEC index: entry has no url');

  const mapResponse = await fetchImpl(`${HOST}${newest.url}`);
  if (!mapResponse.ok) {
    throw new Error(`GloTEC map: HTTP ${String(mapResponse.status)} ${mapResponse.statusText}`);
  }

  return parseTecGrid(await mapResponse.json());
}

interface TecFeature {
  geometry?: { coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

/**
 * Turns the GeoJSON FeatureCollection into row-major grids.
 *
 * Split out from the fetch so it can be tested against a fixture, like every
 * other adapter here.
 *
 * ## Why the cells are placed by coordinate rather than by order
 *
 * The product ships 5,184 point features and *happens* to emit them in a
 * consistent order, but nothing documents that — and a raster built by
 * consuming features in sequence would render a plausible-looking but scrambled
 * image the moment that order changed. Each cell is indexed from its own
 * longitude and latitude instead, so a reordering is harmless and a missing
 * cell stays missing rather than shifting everything after it.
 *
 * Row 0 is the **northernmost** row and column 0 is longitude -180, which is
 * what an image wants — the product runs south-first.
 */
export function parseTecGrid(payload: unknown): TecGrid {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('GloTEC map: expected a FeatureCollection');
  }
  const body = payload as { features?: unknown; time_tag?: unknown };
  if (!Array.isArray(body.features)) throw new Error('GloTEC map: no features');

  const cells = TEC_GRID_WIDTH * TEC_GRID_HEIGHT;
  const tec: (number | null)[] = new Array<number | null>(cells).fill(null);
  const anomaly: (number | null)[] = new Array<number | null>(cells).fill(null);
  const qualityFlag: (number | null)[] = new Array<number | null>(cells).fill(null);

  // Cell size derived from the pinned grid rather than hard-coded twice.
  const lonStep = 360 / TEC_GRID_WIDTH;
  const latStep = 180 / TEC_GRID_HEIGHT;

  for (const raw of body.features as TecFeature[]) {
    const coordinates = raw.geometry?.coordinates;
    if (!Array.isArray(coordinates)) continue;
    const [longitude, latitude] = coordinates as unknown[];
    if (typeof longitude !== 'number' || typeof latitude !== 'number') continue;

    // Cell centres, so the floor of (edge distance / step) lands on the index.
    const column = Math.floor((longitude + 180) / lonStep);
    const row = Math.floor((90 - latitude) / latStep);
    if (column < 0 || column >= TEC_GRID_WIDTH || row < 0 || row >= TEC_GRID_HEIGHT) continue;

    const index = row * TEC_GRID_WIDTH + column;
    const properties = raw.properties ?? {};

    tec[index] = numberOrNull(properties.tec);
    anomaly[index] = numberOrNull(properties.anomaly);
    qualityFlag[index] = numberOrNull(properties.quality_flag);
  }

  return {
    tec,
    anomaly,
    qualityFlag,
    observedAtUtc:
      typeof body.time_tag === 'string' ? body.time_tag : new Date().toISOString(),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
