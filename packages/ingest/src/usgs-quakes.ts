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
    // Depth is genuinely absent on some pre-1980 events — 4 in ~48,500 sampled
    // archive events, all before 1980. Typed honestly so it can't be forgotten.
    coordinates: [number, number, number | null];
  };
}

interface UsgsFeatureCollection {
  features: UsgsFeature[];
}

export function usgsFeatureToEarthquakeEvent(feature: UsgsFeature): EarthquakeEvent {
  const [longitude, latitude, depthKm] = feature.geometry.coordinates;
  return {
    id: feature.id,
    source: 'usgs',
    magnitude: feature.properties.mag ?? 0,
    magnitudeType: feature.properties.magType ?? 'unknown',
    place: feature.properties.place ?? 'Unknown location',
    timeUtc: new Date(feature.properties.time).toISOString(),
    updatedUtc: new Date(feature.properties.updated).toISOString(),
    longitude,
    latitude,
    // Passed through as null rather than defaulted — the adapter reports what
    // the source said (non-negotiable #7), and 0 km would be a claim USGS did
    // not make.
    depthKm: depthKm ?? null,
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

const USGS_FDSN_COUNT_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/count';

export interface CountEarthquakesOptions {
  startUtc: Date;
  endUtc: Date;
  minMagnitude?: number;
}

/**
 * How many events a query *would* return, without transferring any of them.
 *
 * FDSN's `count` endpoint returns a bare integer in a few bytes, where the same
 * query as geojson is megabytes. Used to size the archive backfill up front so
 * progress can be reported against a real total rather than a guess.
 */
export async function countEarthquakes(options: CountEarthquakesOptions): Promise<number> {
  const url = new URL(USGS_FDSN_COUNT_URL);
  url.searchParams.set('starttime', options.startUtc.toISOString());
  url.searchParams.set('endtime', options.endUtc.toISOString());
  if (options.minMagnitude !== undefined) {
    url.searchParams.set('minmagnitude', String(options.minMagnitude));
  }

  const response = await fetch(url);

  // A window containing no events answers 204 with an empty body, not 200
  // with "0" — reading that as an error would make every quiet range fatal.
  if (response.status === 204) return 0;
  if (!response.ok) {
    throw new Error(`USGS count request failed: ${response.status} ${response.statusText}`);
  }

  const text = (await response.text()).trim();
  const count = Number(text);
  if (!Number.isFinite(count)) {
    throw new Error(`USGS count returned something that isn't a number: ${text.slice(0, 80)}`);
  }

  return count;
}

export interface FetchEarthquakePageOptions extends FetchRecentEarthquakesOptions {
  /** Max events to return. FDSN caps this at 20,000 and rejects more. */
  limit: number;
  /** **1-based**, as FDSN defines it — `offset=1` is the first event. */
  offset: number;
}

/**
 * One page of a larger range, in ascending time order.
 *
 * Ordered `time-asc` and not by relevance or magnitude, because paging is only
 * coherent against a stable sort — FDSN's default ordering is newest-first,
 * which shifts as events are added and would let a page boundary skip or repeat
 * events partway through a long backfill.
 *
 * The offset being 1-based is FDSN's convention, not a mistake: `offset=1`
 * returns the first event, and a caller treating it as 0-based silently drops
 * the first event of every page after the first. Verified against the live
 * service rather than the docs.
 */
export async function fetchEarthquakePage(
  options: FetchEarthquakePageOptions,
): Promise<EarthquakeEvent[]> {
  const url = new URL(USGS_FDSN_QUERY_URL);
  url.searchParams.set('format', 'geojson');
  url.searchParams.set('starttime', options.startUtc.toISOString());
  url.searchParams.set('endtime', options.endUtc.toISOString());
  url.searchParams.set('orderby', 'time-asc');
  url.searchParams.set('limit', String(options.limit));
  url.searchParams.set('offset', String(options.offset));
  if (options.minMagnitude !== undefined) {
    url.searchParams.set('minmagnitude', String(options.minMagnitude));
  }

  const response = await fetch(url);
  if (response.status === 204) return [];
  if (!response.ok) {
    throw new Error(`USGS request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as UsgsFeatureCollection;
  return data.features.map(usgsFeatureToEarthquakeEvent);
}

const USGS_FEED_BASE_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';

/**
 * The pre-built summary buckets. This app polls `1.0_day`, matching its M1.0
 * ingest floor; the rest are listed because USGS publishes them.
 *
 * Deliberately the *day* bucket rather than `2.5_hour` for polling: it's
 * self-healing if the machine sleeps (the next poll still covers 24h, no
 * gap-detection needed), and re-reading existing events is how USGS revisions
 * get picked up — magnitudes are refined and `status` flips automatic →
 * reviewed in the hours after an event.
 */
export type EarthquakeFeedBucket =
  | '1.0_hour'
  | '1.0_day'
  | '2.5_hour'
  | '2.5_day'
  | '4.5_hour'
  | '4.5_day'
  | 'all_hour'
  | 'all_day';

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
