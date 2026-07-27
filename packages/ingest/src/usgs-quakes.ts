import type { EarthquakeEvent } from '@terra-pulse/schema';

const USGS_FDSN_QUERY_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

// The raw USGS GeoJSON shape — kept internal to this file. Non-negotiable
// #7: downstream code never sees this, only the normalized EarthquakeEvent.
interface UsgsFeature {
  id: string;
  properties: {
    mag: number | null;
    place: string | null;
    time: number;
    updated: number;
    url: string;
    status: string;
    tsunami: number;
    alert: string | null;
    sig: number;
    magType: string | null;
  };
  geometry: {
    type: 'Point';
    coordinates: [number, number, number];
  };
}

interface UsgsFeatureCollection {
  features: UsgsFeature[];
}

export function usgsFeatureToEarthquakeEvent(feature: UsgsFeature): EarthquakeEvent {
  const [longitude, latitude, depthKm] = feature.geometry.coordinates;
  return {
    id: feature.id,
    magnitude: feature.properties.mag ?? 0,
    magnitudeType: feature.properties.magType ?? 'unknown',
    place: feature.properties.place ?? 'Unknown location',
    timeUtc: new Date(feature.properties.time).toISOString(),
    updatedUtc: new Date(feature.properties.updated).toISOString(),
    longitude,
    latitude,
    depthKm,
    status: feature.properties.status,
    tsunami: feature.properties.tsunami === 1,
    alertLevel: feature.properties.alert,
    significance: feature.properties.sig,
    url: feature.properties.url,
  };
}

export interface FetchRecentEarthquakesOptions {
  startUtc: Date;
  endUtc: Date;
  minMagnitude?: number;
}

/**
 * Backfill over an exact window.
 *
 * Uses FDSN's parameterised query rather than a summary feed because only it
 * accepts arbitrary start/end times — the feeds come in fixed hour/day/week
 * buckets. It is a live database query (measured `X-Cache: Miss`), so it's
 * right for a once-per-launch backfill and wrong to poll; see
 * `fetchEarthquakeFeed` for the polling path.
 */
export async function fetchRecentEarthquakes(
  options: FetchRecentEarthquakesOptions,
): Promise<EarthquakeEvent[]> {
  const url = new URL(USGS_FDSN_QUERY_URL);
  url.searchParams.set('format', 'geojson');
  url.searchParams.set('starttime', options.startUtc.toISOString());
  url.searchParams.set('endtime', options.endUtc.toISOString());
  if (options.minMagnitude !== undefined) {
    url.searchParams.set('minmagnitude', String(options.minMagnitude));
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`USGS request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as UsgsFeatureCollection;
  return data.features.map(usgsFeatureToEarthquakeEvent);
}

const USGS_FEED_BASE_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';

/**
 * The pre-built summary buckets. `2.5_day` matches this app's M2.5+ floor.
 *
 * Deliberately the *day* bucket rather than `2.5_hour` for polling: it's
 * self-healing if the machine sleeps (the next poll still covers 24h, no
 * gap-detection needed), and re-reading existing events is how USGS revisions
 * get picked up — magnitudes are refined and `status` flips automatic →
 * reviewed in the hours after an event.
 */
export type EarthquakeFeedBucket = '2.5_hour' | '2.5_day' | 'all_hour' | 'all_day';

/**
 * Poll-friendly fetch. These are CDN-cached with `Cache-Control: max-age=60`,
 * so polling faster than 60s returns byte-identical data.
 *
 * Returns whatever the bucket holds, which is legitimately an empty array
 * during a quiet hour — callers must not read that as "no data exists".
 */
export async function fetchEarthquakeFeed(
  bucket: EarthquakeFeedBucket,
): Promise<EarthquakeEvent[]> {
  const response = await fetch(`${USGS_FEED_BASE_URL}/${bucket}.geojson`);
  if (!response.ok) {
    throw new Error(`USGS feed request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as UsgsFeatureCollection;
  return data.features.map(usgsFeatureToEarthquakeEvent);
}
