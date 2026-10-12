/**
 * Camera-height arithmetic for centring on an event. Pure and Cesium-free so
 * it can be tested without a WebGL context.
 */

/**
 * Used only when the camera's own height can't be trusted — never as a floor.
 *
 * 250 km is a reasonable "you can see a region" altitude for the degenerate
 * case, which is the only case it applies to.
 */
export const FALLBACK_FOCUS_ALTITUDE_M = 250_000;

/**
 * The altitude to fly to when centring on an event: **the one the camera is
 * already at.**
 *
 * This used to be `Math.max(height, 250_000)`, which reads like a sensible
 * floor and is the opposite of what a floor should do here. `Math.max` only
 * changes the result when the camera is *closer* than 250 km — so zoomed out
 * nothing happened, and zoomed in to inspect a sequence, every click on a
 * neighbouring event yanked the view back out to 250 km. The one situation
 * where preserving zoom matters was the only situation it didn't.
 *
 * The fallback now covers what a floor was presumably meant to: a height that
 * is NaN, or at or below the surface, would otherwise produce a destination
 * inside the Earth. Any usable height passes through untouched, however close.
 */
export function focusAltitudeM(currentHeightM: number): number {
  if (!Number.isFinite(currentHeightM) || currentHeightM <= 0) {
    return FALLBACK_FOCUS_ALTITUDE_M;
  }
  return currentHeightM;
}

/**
 * Where the globe faces at launch, and where the reset button returns it.
 *
 * **The longitude is the reader's own, taken from the system clock.** Cesium's
 * default view sits over North America for everyone, which is the wrong side of
 * the planet for most of the world. A UTC offset is 15° of longitude per hour
 * by definition, so it places the reader to within a time zone's width without
 * asking for a location, a permission or a network call. That is coarse — zones
 * are political, and daylight saving shifts it another 15° — and it does not
 * need to be better: this is a whole-globe view, where 15° is a small turn.
 *
 * `utcOffsetMinutes` is minutes **east** of UTC — the negation of
 * `Date.prototype.getTimezoneOffset()`, which counts the other way.
 */
export function homeLongitudeDeg(utcOffsetMinutes: number): number {
  if (!Number.isFinite(utcOffsetMinutes)) return 0;
  const degrees = (utcOffsetMinutes / 60) * 15;
  // UTC+14 (Kiribati) is 210° east, which is 150° west.
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

/**
 * The home view's latitude, the same for everyone.
 *
 * A clock says nothing about north or south. 20°N keeps the northern
 * mid-latitudes, where most readers are, near the middle of the disc while
 * leaving Sydney and Santiago well inside it.
 */
export const HOME_LATITUDE_DEG = 20;

/** Used only if the camera's own starting height cannot be read. */
export const FALLBACK_HOME_ALTITUDE_M = 22_000_000;

/**
 * The home view's height: the one Cesium started the camera at, so the globe
 * is the size it has always opened at. The fallback covers a height that is
 * not a usable whole-globe distance.
 */
export function homeAltitudeM(startingHeightM: number): number {
  if (!Number.isFinite(startingHeightM) || startingHeightM < 1_000_000) return FALLBACK_HOME_ALTITUDE_M;
  return startingHeightM;
}

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * How far off its axis a camera must be aimed for whatever is straight ahead
 * of it to appear at `target` instead of the middle of the window — as the
 * tangents of the two angles, right and up positive.
 *
 * `fovRad` is Cesium's frustum angle, which spans the **larger** of the
 * viewport's two dimensions; the focal length follows from it.
 */
export function aimForPixel(
  viewport: { width: number; height: number },
  target: { x: number; y: number },
  fovRad: number,
): { tanRight: number; tanUp: number } {
  const focalPx = Math.max(viewport.width, viewport.height) / 2 / Math.tan(fovRad / 2);
  if (!Number.isFinite(focalPx) || focalPx <= 0) return { tanRight: 0, tanUp: 0 };
  return {
    tanRight: (target.x - viewport.width / 2) / focalPx,
    // Screen y runs down; "up" is positive here.
    tanUp: (viewport.height / 2 - target.y) / focalPx,
  };
}
