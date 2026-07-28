export { fetchRecentEarthquakes, fetchEarthquakeFeed } from './usgs-quakes';
export type { FetchRecentEarthquakesOptions, EarthquakeFeedBucket } from './usgs-quakes';

export { fetchEmscEarthquakes } from './emsc-quakes';
export type { FetchEmscOptions } from './emsc-quakes';

export {
  isProbableDuplicate,
  rejectDuplicates,
  distanceKm,
  DEDUPE_MAX_DISTANCE_KM,
  DEDUPE_MAX_TIME_SECONDS,
  DEDUPE_MAX_MAGNITUDE_DELTA,
} from './dedupe';
