import {
  AURORA_MAX_PROBABILITY,
  AURORA_MIN_LATITUDE,
  AURORA_VISIBLE_THRESHOLD,
  type AuroraGrid,
} from '@terra-pulse/schema';
import { rampAt } from './field-encoding';

/**
 * Colour encoding for the auroral oval.
 *
 * ## Why green, when the field layer is viridis
 *
 * Not decoration and not convention-following: **green is what the aurora
 * actually is.** The dominant emission is atomic oxygen at 557.7 nm, and it is
 * why every photograph and every NOAA product looks like this. Encoding a
 * phenomenon in its own colour is the one case where hue can be literal.
 *
 * It also keeps the two space-weather rasters apart. They can be on at once and
 * they mean completely different things — one is the main field from the core,
 * drifting over decades; the other is the atmosphere responding to the Sun
 * within hours.
 *
 * Monotonic in OKLab lightness (0.17 -> 0.96), so magnitude survives being read
 * as greyscale, same rule the field ramp follows.
 */
const AURORA_GREEN = [
  '#04140c', '#0a3a24', '#0f6b3f', '#128a4d', '#16a05a',
  '#28ba6c', '#3fd07e', '#63dd94', '#8ceaa8', '#b6f4c8', '#d9fbe3',
] as const;

/**
 * Where alpha finishes fading in, as a probability.
 *
 * The oval has no edge in nature — it fades. Cutting straight from transparent
 * to opaque at the visibility threshold would draw a hard contour that is an
 * artefact of the threshold rather than anything in the data.
 *
 * Deliberately a *narrow* fade at the very bottom of the range rather than
 * alpha tracking probability all the way up. Opacity climbing with value across
 * the whole scale would encode magnitude twice — once in hue, once in how much
 * basemap shows through — and the two read at different rates.
 */
const ALPHA_FADE_UNTIL = 6;

/** Opacity of the oval proper. Sheer enough to keep the coastline under it. */
const FULL_ALPHA = 216;

/** The colour and opacity for one probability value. */
export function auroraColor(probability: number): [number, number, number, number] {
  if (probability < AURORA_VISIBLE_THRESHOLD) return [0, 0, 0, 0];

  const t = Math.min(probability / AURORA_MAX_PROBABILITY, 1);
  const [r, g, b] = rampAt(AURORA_GREEN, t);

  const fade = Math.min(
    (probability - AURORA_VISIBLE_THRESHOLD) /
      Math.max(ALPHA_FADE_UNTIL - AURORA_VISIBLE_THRESHOLD, 1),
    1,
  );

  return [r, g, b, Math.round(FULL_ALPHA * fade)];
}

/**
 * Paints a grid into RGBA bytes, row-major from the north edge.
 *
 * **Most of this image is transparent, and that is the encoding.** On a quiet
 * grid about 70% of cells are zero — measured 45,284 of 65,160 against the live
 * product. Those are absences, not small values; painting them with the bottom
 * of the ramp would wash the whole planet faintly green and imply a global
 * phenomenon. The IGRF layer does the exact opposite with uniform alpha,
 * because a magnetic field is never absent.
 */
export function paintAuroraRgba(grid: AuroraGrid): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(grid.width * grid.height * 4);

  for (let i = 0; i < grid.values.length; i += 1) {
    // Rows are north-first, so row 0 is +90.
    const latitude = 90 - Math.floor(i / grid.width);
    // NOAA's equatorial seam — see `AURORA_MIN_LATITUDE`. Dropped here rather
    // than in the adapter, which stays faithful to its source
    // (non-negotiable #7); policy lives at the call site.
    const value = Math.abs(latitude) < AURORA_MIN_LATITUDE ? 0 : (grid.values[i] ?? 0);
    const [r, g, b, a] = auroraColor(value);
    const o = i * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = a;
  }

  return rgba;
}

/** Evenly spaced sample colours, for the legend. */
export function auroraLegendStops(count = 5): { value: number; color: string }[] {
  return Array.from({ length: count }, (_, i) => {
    const value = Math.round((AURORA_MAX_PROBABILITY * (i + 1)) / count);
    const [r, g, b] = auroraColor(value);
    return { value, color: `rgb(${String(r)} ${String(g)} ${String(b)})` };
  });
}
