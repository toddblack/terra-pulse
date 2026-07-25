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

// FDSN's parameterized query endpoint, not the pre-built feed buckets — the
// milestone calls for an exact 72-hour window, and the buckets only come in
// fixed day/week/month sizes. See PROJECT_PLAN.md's Storage/data-source
// notes for the full reasoning.
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
