import type { BackdropTone } from '@terra-pulse/schema';

/**
 * Visual encoding for active faults. Pure and Cesium-free so it can be
 * unit-tested without a WebGL context, matching `earthquake-encoding.ts` and
 * `subduction-encoding.ts`.
 */

/**
 * One colour, not a scale.
 *
 * There are 664,447 km of mapped fault here. Colouring them by slip type would
 * put three more saturated hues across the whole globe and make them compete
 * with the earthquake marks, which are the point of the app. So faults get a
 * single colour regardless of what kind of fault they are.
 *
 * ## Why red, and the cost that was accepted knowingly
 *
 * This was a muted grey (#7a736c / #a89f96) on the reasoning that faults are
 * context and should recede. That failed in practice on the GEBCO seafloor
 * basemap, where grey measured 1.50:1 against the water and simply got lost.
 *
 * Red is a deliberate trade, made with the numbers on the table. It **clashes
 * with the convergent boundary colour** — `#d95926` is a warm orange-red, and
 * the best available red separates from it by only **ΔE 10.5**, under the 15
 * floor. `#ff1744` was picked precisely because its slight magenta lean
 * maximises that separation; the pure reds tested scored 8.2-8.7.
 *
 * The clash is tolerable here for two specific reasons: faults are a layer you
 * toggle, so the two are rarely being read against each other under pressure,
 * and the boundary lines are cased and heavier, which distinguishes them by
 * weight even where hue nearly matches.
 *
 * **A known limit, recorded rather than hidden.** Red is far more visible than
 * grey on land, where most mapped faults are, but on the *palest* shallow water
 * (~#3388bb, mid-ocean ridge crests) it measures around 1.05:1 and will still
 * wash out. Hue alone cannot fix that — it's the same trap the boundary colours
 * fell into. The fix, if it ever matters, is the casing device from
 * `plate-kinematics.ts`, not another hue.
 *
 * Deliberately *not* compared against the earthquake depth ramp: that ramp
 * spans the full lightness range on the dark basemap (#cde2fb to #256abf), and
 * the comparison is meaningless anyway — faults are hairline strokes and events
 * are haloed dots. Shape separates them, not hue.
 */
const FAULT_COLORS: Record<BackdropTone, string> = {
  // Deeper on pale OSM so it doesn't glare; brighter over imagery.
  light: '#d90429',
  dark: '#ff1744',
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
