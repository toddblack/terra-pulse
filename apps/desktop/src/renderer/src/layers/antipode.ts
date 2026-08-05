/**
 * Antipode geometry — PROJECT_PLAN §5.3. Pure and Cesium-free, so the maths can
 * be tested without a WebGL context.
 *
 * **This module makes no claim.** The antipode is the point diametrically
 * opposite on a sphere; drawing it says only "here is the other side of the
 * planet from this event". Whether antipodal focusing has any effect on
 * seismicity is a Phase 4 question, and answering it needs a
 * magnitude-of-completeness map (see §5.3) — because only ~4% of land is
 * antipodal to land, so an uncorrected test measures the seismometer network
 * rather than the Earth.
 */

export interface LatLon {
  latitude: number;
  longitude: number;
}

/**
 * Wraps a longitude into [-180, 180).
 *
 * Half-open at the top on purpose: 180 and -180 are the same meridian, so
 * allowing both would let the antipode of one place print two different ways
 * depending on which side of the date line it started.
 */
export function normalizeLongitude(longitude: number): number {
  if (!Number.isFinite(longitude)) return Number.NaN;
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

/**
 * The point directly opposite on the globe.
 *
 * Latitude mirrors about the equator; longitude moves half a turn. Deliberately
 * ignores depth: a hypocentre 600 km down is still *below* a surface point, and
 * the antipode of that surface point is what "the other side of the world" means.
 * Treating depth as part of the geometry would put the far end inside the mantle
 * rather than on the surface.
 */
export function antipodeOf(point: LatLon): LatLon {
  return {
    latitude: -point.latitude,
    longitude: normalizeLongitude(point.longitude + 180),
  };
}

/**
 * Formatted for display: "36.05°S, 67.86°E".
 *
 * Hemisphere letters rather than signed numbers, matching the inspector's
 * existing coordinate formatting — a reader comparing the two shouldn't have to
 * translate between conventions.
 */
export function formatLatLon(point: LatLon): string {
  const lat = `${Math.abs(point.latitude).toFixed(2)}°${point.latitude >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(point.longitude).toFixed(2)}°${point.longitude >= 0 ? 'E' : 'W'}`;
  return `${lat}, ${lon}`;
}

/**
 * How far along the chord to draw, given how long the animation has run.
 *
 * Eased rather than linear — a constant-speed line reaching the far side reads
 * as a loading bar, where an ease-out reads as something travelling and
 * arriving. Clamped at both ends so a paused tab (which can hand back a large
 * elapsed time) or a clock adjustment can't produce a fraction outside [0, 1].
 */
export function chordProgress(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1;
  const t = Math.min(1, Math.max(0, elapsedMs / durationMs));
  // easeOutCubic
  return 1 - (1 - t) ** 3;
}
