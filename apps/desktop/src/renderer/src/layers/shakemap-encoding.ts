import type { IntensityContour, ShakeMapContours } from '@terra-pulse/schema';

/**
 * Which of a ShakeMap's lines are drawn, and how — pure, so it can be tested
 * without a WebGL context, like `earthquake-encoding.ts`.
 *
 * ## The lines drawn are the boundaries between intensities
 *
 * USGS contours every half step: 4, 4.5, 5, 5.5 … Intensity is reported in
 * whole numbers, and a place rounds to V when its value is between 4.5 and
 * 5.5 — so **the half-step lines are the edges of the zones**, and they are
 * the isoseismals of a classic intensity map. The whole-number lines run
 * through the middle of a zone and bound nothing. USGS draws the half steps
 * twice as heavy for the same reason (weight 4 against 2 in its own file).
 *
 * So only the half steps are drawn, each named for the zone it encloses: the
 * 4.5 line is the edge of V. Drawing all of them would double the ink — up to
 * 14 nested lines — to add lines that mean less.
 */

export interface Isoseismal {
  /** The whole-number intensity this line encloses: 5 for the 4.5 line. */
  intensity: number;
  lines: [number, number][][];
}

/**
 * The weakest zone drawn: III.
 *
 * II is "felt by a few people at rest", and its edge is where a ShakeMap is
 * mostly model and least certain. On the maps measured its line is also the
 * most fragmented or absent altogether. III is USGS's own "weak" class and the
 * first most people would notice.
 */
export const MIN_INTENSITY_DRAWN = 3;

/**
 * A line piece shorter than this many points is not drawn.
 *
 * A ShakeMap is a grid, and where soft ground or one loud station lifts a few
 * cells over a threshold the contouring leaves a tiny closed loop. Measured on
 * six real maps (2026-10-13): at the outer levels about three quarters of the
 * pieces are under 12 points — Ridgecrest's IV edge is 43 pieces, 33 of them
 * that small — and together they hold a quarter of the points or less. The
 * main loop of the same level is 385. They are real output and they read as
 * speckle, so they are left out.
 *
 * **The strongest level is exempt**, and that came from the same measurement:
 * the innermost line is small because the zone is. Panama 2026's edge of VIII
 * is a single piece of 9 points, and filtering it would delete the peak of the
 * map — the one line a reader most wants.
 */
export const MIN_LINE_POINTS = 12;

function isHalfStep(mmi: number): boolean {
  return Math.abs((mmi % 1) - 0.5) < 1e-9;
}

/**
 * The isoseismals to draw for a map, weakest first.
 *
 * Falls back to the whole-number lines if a map has no half steps at all. All
 * eight measured did, but an older product that contours only at integers
 * should still draw something, and its lines are then named for their own
 * value.
 */
export function isoseismalsToDraw(contours: readonly IntensityContour[]): Isoseismal[] {
  const halves = contours.filter((contour) => isHalfStep(contour.mmi));
  const chosen: Isoseismal[] =
    halves.length > 0
      ? halves.map((contour) => ({ intensity: contour.mmi + 0.5, lines: contour.lines }))
      : contours
          .filter((contour) => Number.isInteger(contour.mmi))
          .map((contour) => ({ intensity: contour.mmi, lines: contour.lines }));

  const offered = chosen
    .filter((isoseismal) => isoseismal.intensity >= MIN_INTENSITY_DRAWN)
    .sort((a, b) => a.intensity - b.intensity);
  const strongest = offered[offered.length - 1]?.intensity;

  return offered
    .map((isoseismal) => ({
      intensity: isoseismal.intensity,
      lines:
        isoseismal.intensity === strongest
          ? longestOrSubstantial(isoseismal.lines)
          : isoseismal.lines.filter((line) => line.length >= MIN_LINE_POINTS),
    }))
    .filter((isoseismal) => isoseismal.lines.length > 0);
}

/** The substantial pieces, or the single longest when none is. */
function longestOrSubstantial(lines: [number, number][][]): [number, number][][] {
  const substantial = lines.filter((line) => line.length >= MIN_LINE_POINTS);
  if (substantial.length > 0) return substantial;

  let longest: [number, number][] | null = null;
  for (const line of lines) {
    if (longest === null || line.length > longest.length) longest = line;
  }
  return longest === null ? [] : [longest];
}

/**
 * USGS's own colour for each intensity — the ShakeMap scale, which is what
 * anyone who has seen one of these maps already knows how to read.
 *
 * III to IX were read out of real contour files (2026-10-13), not recalled.
 * X is from USGS's published scale: no file measured reached it.
 *
 * This is the one place the app uses a rainbow, and deliberately. Everywhere
 * else a rainbow is refused because it invents boundaries in smooth data.
 * These are not smooth data — they are eight named classes, already drawn as
 * separate lines and each labelled with its numeral, so colour is the second
 * encoding rather than the only one.
 */
const INTENSITY_COLORS: Record<number, string> = {
  3: '#a0e5ff',
  4: '#80ffff',
  5: '#7cff90',
  6: '#ffff00',
  7: '#ffc600',
  8: '#ff9100',
  9: '#fd0000',
  10: '#c80000',
};

/** Dark casing behind every line: most of the scale is pale, and the light basemap is too. */
export const ISOSEISMAL_CASING = '#111827';

export function intensityColor(intensity: number): string {
  const clamped = Math.min(10, Math.max(MIN_INTENSITY_DRAWN, Math.round(intensity)));
  return INTENSITY_COLORS[clamped] ?? '#ffffff';
}

const NUMERALS = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/** Intensity is written in Roman numerals so it is never mistaken for a magnitude. */
export function intensityNumeral(intensity: number): string {
  const rounded = Math.round(intensity);
  if (rounded < 1) return 'I';
  return NUMERALS[Math.min(rounded, 10)] ?? 'X';
}

/** USGS's word for how each intensity is perceived. */
export function intensityWord(intensity: number): string {
  const rounded = Math.round(intensity);
  if (rounded <= 1) return 'not felt';
  if (rounded <= 3) return 'weak';
  if (rounded === 4) return 'light';
  if (rounded === 5) return 'moderate';
  if (rounded === 6) return 'strong';
  if (rounded === 7) return 'very strong';
  if (rounded === 8) return 'severe';
  if (rounded === 9) return 'violent';
  return 'extreme';
}

/**
 * Where a line's label goes: the northernmost point of its longest piece.
 *
 * One label per intensity, on the piece that is the zone's main edge. North,
 * because the lines nest, so their northern edges step outward in order and
 * the numerals stack in sequence instead of landing on each other.
 */
export function labelPoint(isoseismal: Isoseismal): [number, number] | null {
  let longest: [number, number][] | null = null;
  for (const line of isoseismal.lines) {
    if (longest === null || line.length > longest.length) longest = line;
  }
  if (longest === null) return null;

  let best: [number, number] | null = null;
  for (const point of longest) {
    if (best === null || point[1] > best[1]) best = point;
  }
  return best;
}

const EARTH_RADIUS_KM = 6371;

function distanceKm(a: [number, number], b: { latitude: number; longitude: number }): number {
  const toRad = Math.PI / 180;
  const dLat = (a[1] - b.latitude) * toRad;
  const dLon = (a[0] - b.longitude) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * toRad) * Math.cos(b.latitude * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * How far the drawn lines reach from the epicentre, in km — what the camera
 * has to fit when the lines are asked for.
 *
 * Measured on the drawn lines, not on the whole product: the II line is left
 * out and can reach hundreds of kilometres further than anything on screen.
 */
export function isoseismalReachKm(
  isoseismals: readonly Isoseismal[],
  epicentre: { latitude: number; longitude: number },
): number {
  let reach = 0;
  for (const isoseismal of isoseismals) {
    for (const line of isoseismal.lines) {
      for (const point of line) reach = Math.max(reach, distanceKm(point, epicentre));
    }
  }
  return reach;
}

/**
 * The line of text under the button once a map has arrived.
 *
 * Names the peak in the same numeral the lines carry, and says whose estimate
 * it is. "Peak" is the map's own maximum, which sits inside the innermost
 * line, so it can be a class above the highest numeral drawn.
 */
export function shakeMapSummary(map: ShakeMapContours): string {
  const peak =
    map.maxMmi === null
      ? ''
      : `peak ${intensityNumeral(map.maxMmi)} (${intensityWord(map.maxMmi)}) · `;
  const origin = map.source === 'atlas' ? 'USGS ShakeMap Atlas' : 'USGS ShakeMap';
  return `${peak}${origin}`;
}
