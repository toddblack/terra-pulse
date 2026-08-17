export {
  fetchRecentEarthquakes,
  fetchEarthquakeFeed,
  fetchEarthquakePage,
  countEarthquakes,
} from './usgs-quakes';
export type {
  FetchRecentEarthquakesOptions,
  FetchEarthquakePageOptions,
  CountEarthquakesOptions,
  EarthquakeFeedBucket,
} from './usgs-quakes';

export { fetchArchiveChunk, ArchiveCancelledError } from './archive-backfill';
export type { FetchArchiveChunkOptions } from './archive-backfill';

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
export * from './aurora';
export * from './omni-indices';
export * from './gfz-kp';
export * from './swpc-solar-wind';
export * from './usgs-magnetometer';
export * from './swpc-tec';
export * from './nasa-donki';
