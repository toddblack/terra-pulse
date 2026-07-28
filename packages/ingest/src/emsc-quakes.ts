import type { EarthquakeEvent } from '@terra-pulse/schema';

const EMSC_QUERY_URL = 'https://www.seismicportal.eu/fdsnws/event/1/query';

/**
 * EMSC's raw record. Kept internal — downstream sees only the normalised
 * `EarthquakeEvent` (non-negotiable #7).
 *
 * `auth` is the contributing national agency (BMKG, INGV, GeoNet…), which is
 * exactly the data USGS's global feed lacks below M4.
 */
interface EmscFeature {
  properties: {
    unid: string;
    time: string;
    lastupdate: string | null;
    flynn_region: string | null;
    lat: number;
    lon: number;
    depth: number | null;
    mag: number | null;
    magtype: string | null;
    auth: string | null;
  };
}

interface EmscFeatureCollection {
  features: EmscFeature[];
}

export function emscFeatureToEarthquakeEvent(feature: EmscFeature): EarthquakeEvent {
  const p = feature.properties;
  return {
    id: `emsc:${p.unid}`,
    source: 'emsc',
    magnitude: p.mag ?? 0,
    magnitudeType: p.magtype ?? 'unknown',
    place: p.flynn_region ?? 'Unknown location',
    timeUtc: new Date(p.time).toISOString(),
    updatedUtc: new Date(p.lastupdate ?? p.time).toISOString(),
    longitude: p.lon,
    latitude: p.lat,
    depthKm: p.depth ?? 0,
    // EMSC exposes no review state, and inventing one would be a claim about
    // data quality we can't support. Same for the two below: these are USGS
    // products, absent here rather than zero.
    status: null,
    tsunami: false,
    alertLevel: null,
    significance: null,
    url: `https://www.seismicportal.eu/eventdetails.html?unid=${p.unid}`,
  };
}

export interface FetchEmscOptions {
  startUtc: Date;
  minMagnitude?: number;
  /** EMSC caps results; the default is generous enough for a 4-day window. */
  limit?: number;
}

/**
 * EMSC aggregates ~70 national agency catalogues, which is why it carries the
 * small events USGS's global feed misses: measured over 7 days at M2+, EMSC
 * returned 2,652 events at 13% US against USGS's ~730 at 69% US.
 *
 * Note the non-standard parameter names (`start`, `minmag`) — EMSC's FDSN
 * implementation accepts these short forms rather than the usual
 * `starttime`/`minmagnitude`.
 */
export async function fetchEmscEarthquakes(
  options: FetchEmscOptions,
): Promise<EarthquakeEvent[]> {
  const url = new URL(EMSC_QUERY_URL);
  url.searchParams.set('format', 'json');
  url.searchParams.set('start', options.startUtc.toISOString().slice(0, 10));
  url.searchParams.set('limit', String(options.limit ?? 20000));
  if (options.minMagnitude !== undefined) {
    url.searchParams.set('minmag', String(options.minMagnitude));
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`EMSC request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as EmscFeatureCollection;
  // A quiet period legitimately returns no features; that is not an error.
  return (data.features ?? []).map(emscFeatureToEarthquakeEvent);
}
