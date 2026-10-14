import type { IntensityContour, ShakeMapContours, ShakeMapResult } from '@terra-pulse/schema';

/**
 * USGS ShakeMap intensity contours for one earthquake.
 *
 * Two requests: the event's detail record, which lists its products, then the
 * contour file the ShakeMap product points at. Measured 2026-10-13 against
 * Ridgecrest, Tohoku, Valdivia, Loma Prieta, Panama 2026 and Türkiye 2023:
 * the detail takes 0.1-1.7 s, the contours 24-81 KB and under a second.
 *
 * Any id USGS associates with the event works — `iscgem879136` and
 * `usp000hvnu` both resolve to their `official…` records — so the id the
 * catalogue stored is passed as it is.
 */
const DETAIL_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

/**
 * The only host a contour file may be fetched from.
 *
 * The file's address comes out of the detail payload. Following whatever is
 * written there would let a malformed record aim main's fetch anywhere.
 */
const CONTENT_ORIGIN = 'https://earthquake.usgs.gov/';

/**
 * The contour file inside a ShakeMap product, newest name first. ShakeMap v3
 * wrote `cont_mi.json`; v4 writes `cont_mmi.json` and reprocessed products
 * carry both.
 */
const CONTOUR_FILES = ['download/cont_mmi.json', 'download/cont_mi.json'];

/** The parts of the detail record this reads. Everything else is ignored. */
interface ShakeMapProduct {
  source?: unknown;
  status?: unknown;
  preferredWeight?: unknown;
  properties?: Record<string, unknown>;
  contents?: Record<string, { url?: unknown } | undefined>;
}

interface EventDetail {
  properties?: { products?: { shakemap?: ShakeMapProduct[] } };
}

interface ContourCollection {
  features?: {
    properties?: { value?: unknown };
    geometry?: { type?: unknown; coordinates?: unknown };
  }[];
}

/**
 * Fetches a quake's intensity contours.
 *
 * `none` when USGS has no ShakeMap for it, which is ordinary: about a third of
 * M5.5+ quakes before 2013 have one. Anything else that goes wrong throws, so
 * "USGS made no map" and "USGS could not be reached" stay different answers.
 */
export async function fetchShakeMapContours(
  eventId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ShakeMapResult> {
  const detailUrl = `${DETAIL_URL}?${new URLSearchParams({ eventid: eventId, format: 'geojson' }).toString()}`;
  const detailResponse = await fetchImpl(detailUrl);
  // An id USGS does not know. Not a failure of the service: an event that
  // reached the catalogue through another agency has no record there.
  if (detailResponse.status === 404 || detailResponse.status === 204) return { status: 'none' };
  if (!detailResponse.ok) {
    throw new Error(
      `USGS event detail: HTTP ${String(detailResponse.status)} ${detailResponse.statusText}`,
    );
  }

  const product = pickShakeMapProduct((await detailResponse.json()) as EventDetail);
  if (product === null) return { status: 'none' };

  const contourUrl = contourFileUrl(product);
  if (contourUrl === null) return { status: 'none' };

  const contourResponse = await fetchImpl(contourUrl);
  if (!contourResponse.ok) {
    throw new Error(
      `USGS ShakeMap contours: HTTP ${String(contourResponse.status)} ${contourResponse.statusText}`,
    );
  }

  const contours = parseIntensityContours((await contourResponse.json()) as ContourCollection);
  // A map with no lines draws nothing, and "nothing to draw" is what `none`
  // already means to everything downstream.
  if (contours.length === 0) return { status: 'none' };

  return { status: 'available', map: describeProduct(eventId, product, contours) };
}

/**
 * The ShakeMap to use, when an event has several.
 *
 * Ridgecrest has four: the Atlas reprocessing and one each from three
 * networks. USGS ranks them with `preferredWeight` and its own pages show the
 * heaviest, so this does too — taken by weight rather than by position, since
 * nothing documents the order of the list.
 */
export function pickShakeMapProduct(detail: EventDetail): ShakeMapProduct | null {
  const products = detail.properties?.products?.shakemap;
  if (!Array.isArray(products)) return null;

  let best: ShakeMapProduct | null = null;
  let bestWeight = Number.NEGATIVE_INFINITY;
  for (const product of products) {
    // A withdrawn map stays in the list, marked deleted.
    if (product.status === 'DELETE') continue;
    const weight = typeof product.preferredWeight === 'number' ? product.preferredWeight : 0;
    if (weight > bestWeight) {
      best = product;
      bestWeight = weight;
    }
  }
  return best;
}

function contourFileUrl(product: ShakeMapProduct): string | null {
  for (const name of CONTOUR_FILES) {
    const url = product.contents?.[name]?.url;
    if (typeof url === 'string' && url.startsWith(CONTENT_ORIGIN)) return url;
  }
  return null;
}

/**
 * Reads the contour file into the shared shape.
 *
 * The file is GeoJSON: one feature per intensity level, each a
 * `MultiLineString` whose `value` is the MMI. USGS also supplies a colour and
 * a line weight per feature; those are its drawing choices, not data, and are
 * left behind — the renderer has its own encoding.
 *
 * Anything that is not a finite number is dropped rather than coerced. A
 * coordinate read as 0 would draw a line to the Gulf of Guinea.
 */
export function parseIntensityContours(collection: ContourCollection): IntensityContour[] {
  if (!Array.isArray(collection.features)) return [];

  const byLevel = new Map<number, [number, number][][]>();

  for (const feature of collection.features) {
    const mmi = feature.properties?.value;
    if (typeof mmi !== 'number' || !Number.isFinite(mmi)) continue;

    const geometry = feature.geometry;
    const rawLines: unknown =
      geometry?.type === 'MultiLineString'
        ? geometry.coordinates
        : geometry?.type === 'LineString'
          ? [geometry.coordinates]
          : [];
    if (!Array.isArray(rawLines)) continue;

    const lines = byLevel.get(mmi) ?? [];
    for (const rawLine of rawLines) {
      if (!Array.isArray(rawLine)) continue;
      const line: [number, number][] = [];
      for (const point of rawLine) {
        if (!Array.isArray(point)) continue;
        const longitude: unknown = point[0];
        const latitude: unknown = point[1];
        if (
          typeof longitude === 'number' &&
          typeof latitude === 'number' &&
          Number.isFinite(longitude) &&
          Number.isFinite(latitude) &&
          Math.abs(latitude) <= 90
        ) {
          line.push([longitude, latitude]);
        }
      }
      // One point is not a line.
      if (line.length >= 2) lines.push(line);
    }
    if (lines.length > 0) byLevel.set(mmi, lines);
  }

  return [...byLevel.entries()]
    .sort(([a], [b]) => a - b)
    .map(([mmi, lines]) => ({ mmi, lines }));
}

function describeProduct(
  eventId: string,
  product: ShakeMapProduct,
  contours: IntensityContour[],
): ShakeMapContours {
  const properties = product.properties ?? {};
  // USGS sends these as strings: "8.73", "14". An empty string is "not
  // stated", and `Number('')` is 0 — which would read as "nobody felt it".
  const rawMax = properties['maxmmi'];
  const maxMmi =
    typeof rawMax === 'number'
      ? rawMax
      : typeof rawMax === 'string' && rawMax.trim() !== ''
        ? Number(rawMax)
        : Number.NaN;
  const version = properties['version'];
  const processed = properties['process-timestamp'];

  return {
    eventId,
    maxMmi: Number.isFinite(maxMmi) ? maxMmi : null,
    source: typeof product.source === 'string' ? product.source : 'unknown',
    version: typeof version === 'string' ? version : null,
    processedAtUtc: typeof processed === 'string' ? processed : null,
    contours,
  };
}
