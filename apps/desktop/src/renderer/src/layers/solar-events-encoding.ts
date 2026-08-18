/**
 * Visual encoding for the two DONKI marker layers — pure and Cesium-free, like
 * `earthquake-encoding.ts`, so it can be unit-tested without a WebGL context.
 */
import { isDirectImpact, type CmeArrival, type FlareClass } from '@terra-pulse/schema';

/**
 * Orange is a fresh hue: nothing else on the globe represents solar-surface
 * activity, unlike CME arrivals (below), which are the same phenomenon family
 * as the magnetopause/magnetometers and reuse their cyan.
 *
 * X-class reuses the app's existing emphasis red (`#f87171` — the recent-quake
 * stroke, the disturbed-magnetometer ring) rather than a new hue: X flares
 * *are* this layer's severe tier, so borrowing the app's one "this is notable"
 * colour is a deliberate echo, not a collision — an X marker and a red quake
 * stroke never appear on the same object, so there's nothing to disambiguate.
 */
const FLARE_M_COLOR = '#fb923c';
const FLARE_X_COLOR = '#f87171';

export function flareMarkerColorHex(flareClass: FlareClass): string {
  return flareClass === 'X' ? FLARE_X_COLOR : FLARE_M_COLOR;
}

const FLARE_BASE_PIXEL_SIZE = { M: 8, X: 14 } as const;
/** Magnitude within a class is already linear (M2.4 is not logarithmically
 * bigger than M1.0 the way M-class is bigger than C-class) — clamped so an
 * X28 (near the largest ever recorded) can't blow out the marker. */
const FLARE_MAGNITUDE_BOOST_CAP = 10;
const FLARE_MAGNITUDE_BOOST_PER_UNIT = 0.4;

export function flareMarkerPixelSize(flareClass: FlareClass, magnitude: number): number {
  const base = flareClass === 'X' ? FLARE_BASE_PIXEL_SIZE.X : FLARE_BASE_PIXEL_SIZE.M;
  const clampedMagnitude = Math.min(Math.max(magnitude, 0), FLARE_MAGNITUDE_BOOST_CAP);
  return base + clampedMagnitude * FLARE_MAGNITUDE_BOOST_PER_UNIT;
}

/**
 * Cyan, the same one `magnetopause-layer.ts` and `magnetometer-layer.ts` use
 * — a CME arrival is what compresses the boundary those layers draw, so this
 * reads as the same phenomenon family rather than a fourth unrelated hue.
 * Glancing/minor impacts get a neutral grey: they grazed rather than hit, the
 * same "this didn't really happen" role neutral grey plays for an
 * unreporting magnetometer station.
 */
const CME_DIRECT_COLOR = '#67e8f9';
const CME_GLANCING_COLOR = '#94a3b8';

export function cmeMarkerColorHex(arrival: CmeArrival): string {
  return isDirectImpact(arrival) ? CME_DIRECT_COLOR : CME_GLANCING_COLOR;
}

const CME_MIN_PIXEL_SIZE = 8;
const CME_MAX_PIXEL_SIZE = 16;
/** Kp is bounded 0-9 — a fixed scale is honest, same reasoning the space-weather track uses. */
const CME_KP_SCALE_MAX = 9;

/**
 * Sized by the model's predicted Kp, when it has one. A run that produced no
 * estimate draws at the floor rather than a guessed size — the same rule
 * `insertSpaceWeather` follows for a genuinely missing reading versus zero.
 */
export function cmeMarkerPixelSize(predictedKp: number | null): number {
  if (predictedKp === null) return CME_MIN_PIXEL_SIZE;
  const clamped = Math.min(Math.max(predictedKp, 0), CME_KP_SCALE_MAX);
  const t = clamped / CME_KP_SCALE_MAX;
  return CME_MIN_PIXEL_SIZE + t * (CME_MAX_PIXEL_SIZE - CME_MIN_PIXEL_SIZE);
}
