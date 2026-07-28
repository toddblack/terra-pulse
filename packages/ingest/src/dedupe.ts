import type { EarthquakeEvent } from '@terra-pulse/schema';

/**
 * Thresholds for deciding two records describe the same earthquake.
 *
 * Calibrated, not guessed. At M4.5+ both USGS and EMSC report essentially the
 * same events, which gives free ground truth. Across 142 USGS events matched
 * against EMSC (7-day sample):
 *
 *   distance   median 7.5 km   p90 15.2 km   p99 31.9 km
 *   time       median 0.5 s    p90  1.6 s
 *   magnitude  median 0.00     max  0.20
 *
 * So real pairs cluster very tightly. These thresholds sit comfortably beyond
 * that cluster while staying tight enough not to swallow genuinely distinct
 * events in an aftershock sequence, where many small quakes occur close
 * together in both space and time.
 *
 * The asymmetry that set them: a surviving duplicate is a *visible* error you
 * notice immediately on the globe. A wrongly-dropped event is *invisible*.
 * When in doubt, keep both.
 */
export const DEDUPE_MAX_DISTANCE_KM = 50;
export const DEDUPE_MAX_TIME_SECONDS = 60;
/** Real pairs agree to 0.20; this is the strongest of the three signals. */
export const DEDUPE_MAX_MAGNITUDE_DELTA = 0.5;

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance. Haversine is ample at these scales. */
export function distanceKm(
  a: Pick<EarthquakeEvent, 'latitude' | 'longitude'>,
  b: Pick<EarthquakeEvent, 'latitude' | 'longitude'>,
): number {
  const toRad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * toRad;
  const dLon = (b.longitude - a.longitude) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * toRad) * Math.cos(b.latitude * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Whether two records plausibly describe the same earthquake.
 *
 * All three constraints must hold. Magnitude is included because it separates
 * the case the other two can't: two genuinely different events in an active
 * aftershock sequence, close in space and time but different sizes.
 */
export function isProbableDuplicate(a: EarthquakeEvent, b: EarthquakeEvent): boolean {
  const timeA = Date.parse(a.timeUtc);
  const timeB = Date.parse(b.timeUtc);
  // An unparseable timestamp can't be shown to be the same event, and
  // silently dropping a record on bad data is the worse failure.
  if (!Number.isFinite(timeA) || !Number.isFinite(timeB)) return false;

  if (Math.abs(timeA - timeB) / 1000 > DEDUPE_MAX_TIME_SECONDS) return false;
  if (Math.abs(a.magnitude - b.magnitude) > DEDUPE_MAX_MAGNITUDE_DELTA) return false;

  // Distance last — the trig is the expensive check, and the cheap ones
  // reject most candidates first.
  return distanceKm(a, b) <= DEDUPE_MAX_DISTANCE_KM;
}

/**
 * Drops candidates that duplicate something already known.
 *
 * Used with USGS as `existing` and EMSC as `candidates`, so the richer USGS
 * record always wins — it carries PAGER alert, tsunami flag and significance,
 * none of which EMSC provides.
 */
export function rejectDuplicates(
  candidates: readonly EarthquakeEvent[],
  existing: readonly EarthquakeEvent[],
): EarthquakeEvent[] {
  return candidates.filter(
    (candidate) => !existing.some((known) => isProbableDuplicate(candidate, known)),
  );
}
