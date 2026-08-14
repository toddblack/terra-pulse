import {
  AURORA_GRID_HEIGHT,
  AURORA_GRID_WIDTH,
  type AuroraGrid,
} from '@terra-pulse/schema';

/**
 * NOAA SWPC's OVATION Prime auroral forecast.
 *
 * Republished roughly every five minutes. About 900 KB of JSON per fetch, which
 * is why it is parsed down to a 65 KB `Uint8Array` here rather than handed
 * across IPC as-is (non-negotiable #7: downstream sees the shared schema, never
 * the raw payload).
 */
const OVATION_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';

/**
 * The raw product, kept internal to this file.
 *
 * `coordinates` is a flat list of `[longitude, latitude, probability]` triples —
 * 65,160 of them — in longitude-major order from 0 degrees east.
 */
interface OvationResponse {
  'Observation Time': string;
  'Forecast Time': string;
  coordinates: [number, number, number][];
}

/**
 * Fetches and normalises the current grid.
 *
 * Two transforms happen here so no consumer has to repeat them:
 *
 * - **Longitude is re-based from 0..359 to -180..179.** The product starts at
 *   the prime meridian; an equirectangular image starts at the antimeridian.
 *   Skipping this puts the Pacific over Africa, which looks like a plausible
 *   aurora and is wrong by half a planet.
 * - **Rows are flipped to run north-first**, which is image order rather than
 *   the product's south-first order.
 */
export async function fetchAuroraGrid(fetchImpl: typeof fetch = fetch): Promise<AuroraGrid> {
  const response = await fetchImpl(OVATION_URL);
  if (!response.ok) {
    throw new Error(`OVATION aurora: HTTP ${String(response.status)} ${response.statusText}`);
  }

  const payload = (await response.json()) as OvationResponse;
  return parseAuroraGrid(payload, new Date().toISOString());
}

/** Split out from the fetch so it can be tested against a fixture. */
export function parseAuroraGrid(payload: OvationResponse, fetchedAtUtc: string): AuroraGrid {
  const observedAtUtc = payload['Observation Time'];
  const forecastForUtc = payload['Forecast Time'];
  if (!observedAtUtc || !forecastForUtc) {
    throw new Error('OVATION aurora: response is missing its timestamps');
  }

  const coordinates = payload.coordinates;
  const expected = AURORA_GRID_WIDTH * AURORA_GRID_HEIGHT;
  if (!Array.isArray(coordinates) || coordinates.length !== expected) {
    // Pinned rather than inferred: a changed grid shape would otherwise render
    // as a skewed image that still looks like an aurora.
    throw new Error(
      `OVATION aurora: expected ${String(expected)} cells, got ${String(coordinates.length)}`,
    );
  }

  const values = new Uint8Array(expected);

  for (const cell of coordinates) {
    const [longitude, latitude, probability] = cell;

    // 0..359 east -> 0..359 with the antimeridian first, i.e. -180 at column 0.
    const column = (longitude + 180) % 360;
    // -90..90 north-up: latitude 90 is row 0.
    const row = 90 - latitude;

    if (!Number.isInteger(column) || !Number.isInteger(row)) continue;
    if (column < 0 || column >= AURORA_GRID_WIDTH) continue;
    if (row < 0 || row >= AURORA_GRID_HEIGHT) continue;

    values[row * AURORA_GRID_WIDTH + column] = Math.max(0, Math.min(255, Math.round(probability)));
  }

  return {
    observedAtUtc,
    forecastForUtc,
    fetchedAtUtc,
    width: AURORA_GRID_WIDTH,
    height: AURORA_GRID_HEIGHT,
    values,
  };
}
