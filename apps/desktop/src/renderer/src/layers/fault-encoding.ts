import type { BackdropTone } from '@terra-pulse/schema';

/**
 * Visual encoding for active faults. Pure and Cesium-free so it can be
 * unit-tested without a WebGL context, matching `earthquake-encoding.ts` and
 * `subduction-encoding.ts`.
 */

/**
 * One muted grey, not a colour scale.
 *
 * There are 664,447 km of mapped fault here. Colouring them by slip type would
 * put three saturated hues across the whole globe and make them compete with
 * the earthquake marks, which are the point of the app. Faults are context, so
 * they're styled as context and recede.
 *
 * Validated with the dataviz script against the set faults can actually be
 * confused with — the other *line* features (plate boundaries and trenches).
 * Worst normal-vision separation: ΔE 18.0 light, 15.7 dark, both clearing the
 * 15 floor. Contrast against the basemap surface is 4.55:1 light, 6.64:1 dark.
 *
 * Deliberately *not* compared against the earthquake depth ramp. That ramp
 * spans the full lightness range on the dark basemap (#cde2fb to #256abf), so
 * no neutral grey could clear ΔE 15 against all five of its steps — but the
 * comparison is meaningless: faults are hairline strokes and events are haloed
 * dots. Shape separates them, not hue.
 */
const FAULT_COLORS: Record<BackdropTone, string> = {
  light: '#7a736c',
  dark: '#a89f96',
};

export function faultColorHex(tone: BackdropTone): string {
  return FAULT_COLORS[tone];
}

/**
 * Thinner than any plate boundary (1.5-2.5 px), so that even where a fault
 * traces a boundary the two read as different things.
 */
export const FAULT_LINE_WIDTH = 1;

/** Zoom tier assigned by the vendor script from each fault's length. */
export type FaultZoomTier = 0 | 1 | 2;

/**
 * Camera distance, in metres, past which a fault stops drawing.
 *
 * All 13,696 faults at once is an unreadable hairball at global zoom — the
 * user's own words were that these "will get real busy". So only the 1,279
 * long faults (>=100 km) draw from orbit; the 5,712 medium ones appear at
 * roughly continental zoom, and the 6,705 short ones only when close enough
 * for them to be individually meaningful.
 *
 * Cesium treats the far value as inclusive of everything nearer, so these are
 * ceilings rather than bands.
 */
const TIER_MAX_DISTANCE_M: Record<FaultZoomTier, number> = {
  0: Number.MAX_VALUE, // long — always drawn
  1: 8_000_000, // medium — continental zoom and closer
  2: 2_000_000, // short — regional zoom and closer
};

export function faultMaxDistanceMeters(tier: number): number {
  return TIER_MAX_DISTANCE_M[tier as FaultZoomTier] ?? TIER_MAX_DISTANCE_M[0];
}

export function isFaultZoomTier(value: unknown): value is FaultZoomTier {
  return value === 0 || value === 1 || value === 2;
}
