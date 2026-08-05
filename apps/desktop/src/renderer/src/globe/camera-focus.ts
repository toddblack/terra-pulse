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
