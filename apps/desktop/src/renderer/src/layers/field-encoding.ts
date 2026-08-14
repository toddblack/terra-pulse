import type { BackdropTone } from '@terra-pulse/schema';
import type { FieldQuantity } from './igrf';

/**
 * Colour encoding for the geomagnetic field raster.
 *
 * Pure and Cesium-free, like `earthquake-encoding.ts`, so the ramps can be
 * tested without a WebGL context.
 *
 * ## The two ramp jobs, and why neither is a rainbow
 *
 * Conventional geomagnetic charts use a rainbow, and it is the wrong tool twice
 * over: its lightness rises *and* falls, so it invents contour boundaries the
 * data does not contain, and because brightness then carries almost no
 * information, hue is left doing the work alone — which fails in greyscale, in
 * print, and for colour vision deficiency. The rule here is not "avoid many
 * hues", it is **lightness must encode magnitude on its own**:
 *
 * - **Intensity is magnitude** — viridis, dark (weak) to light (strong).
 *   Multi-hue so it has the visual range a single hue lacks, and monotonic in
 *   OKLab lightness (0.29 -> 0.92) so it still reads as greyscale. See the note
 *   on `SEQUENTIAL_VIRIDIS` for the measurements that chose it over both a
 *   single blue and a true rainbow.
 * - **Declination and inclination have a meaningful zero** — a diverging pair,
 *   blue and red with a neutral light midpoint. The neutral band is not
 *   decoration: for declination it *is* the agonic line, where a compass points
 *   true north, and for inclination it is the magnetic equator.
 *
 * The diverging poles were validated with the palette validator rather than by
 * eye: they separate at CVD dE 19.2 (protan) on the light basemap and 23.6 on
 * the dark, against a floor of 8; normal-vision separation is 28.7 and 31.9
 * against a floor of 15.
 */

/**
 * Viridis: the sequential ramp for field strength, dark (weak) to light
 * (strong).
 *
 * ## Why this and not the palette's single blue
 *
 * The blue was correct and unreadable. A single hue gives one visual dimension,
 * and at 41 nT/yr of change against a 50,000 nT range there is not much contrast
 * to spend — the South Atlantic Anomaly came out as a pale smudge rather than
 * the basin it is.
 *
 * ## Why this and not the rainbow every geomagnetic chart uses
 *
 * Measured, in OKLab lightness:
 *
 *     blue      monotonic   L 0.91 -> 0.34   biggest step 0.049
 *     viridis   monotonic   L 0.29 -> 0.92   biggest step 0.088
 *     turbo     NOT mono    L 0.25 -> 0.37   biggest step 0.199
 *
 * That is the whole argument. A rainbow's lightness rises and falls, which
 * manufactures contour bands the data does not contain, and its *net* lightness
 * range is 0.25->0.37 — so brightness carries almost no information and hue
 * does all the work alone. That is what fails in greyscale, in print, and for
 * the ~8% of men with colour vision deficiency.
 *
 * Viridis is multi-hue *and* monotonic, which is the combination worth having:
 * it looks like a full-colour scale and still encodes magnitude in brightness.
 * It is matplotlib's default for exactly this reason.
 *
 * **This is a deliberate departure from the palette's "sequential = one hue"
 * rule**, taken on the rule's own rationale rather than against it. Don't
 * revert it to a single hue without re-reading the numbers above.
 */
const SEQUENTIAL_VIRIDIS = [
  '#440154', '#472d7b', '#3b528b', '#2c728e', '#21918c',
  '#28ae80', '#5ec962', '#addc30', '#fde725',
] as const;

/**
 * The diverging arms, each running from the neutral midpoint out to its pole.
 *
 * Equal step count per arm, as a diverging ramp requires — unequal arms make
 * one sign look like it covers more ground than it does.
 */
const DIVERGING_BLUE_ARM = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#2a78d6', '#1c5cab'] as const;
const DIVERGING_RED_ARM = ['#fbdcd9', '#f5b0ab', '#ea807a', '#e34948', '#cf3b3b', '#b93232'] as const;

/**
 * Neutral midpoint. Greyscale by design — it means "nothing".
 *
 * **Light on both backdrops, and the dark variant was a bug worth remembering.**
 * The palette publishes a per-mode midpoint (`#f0efec` light, `#383835` dark)
 * because in a *chart* the midpoint should match the surface, so zero vanishes
 * into the background. This raster does not sit on a chart surface — it sits on
 * the globe, and both arms run light near the centre out to dark at the poles.
 * A dark midpoint therefore punched a dark notch through the middle of the ramp:
 * lightness went dark, light, dark, and the neutral band rendered as the most
 * salient thing on screen. The magnetic equator came out as a drawn black line
 * and the agonic lines as dark seams.
 *
 * A light neutral keeps lightness monotonic from pole to pole through zero,
 * which is what a diverging ramp is supposed to do: strongest at the extremes,
 * quietest in the middle.
 */
const MIDPOINT: Record<BackdropTone, string> = {
  light: '#f0efec',
  dark: '#eceae6',
};

/** What a quantity is called, its unit, and the range the ramp covers. */
export interface FieldScale {
  label: string;
  unit: string;
  /**
   * Fixed, and that is the whole point.
   *
   * A domain rescaled to each date's own min and max would renormalise the
   * colours on every scrub tick, which would hide precisely the thing this
   * layer exists to show — the South Atlantic Anomaly deepening, the field
   * weakening. A constant domain means the same colour is the same field
   * strength in 1900 and in 2030.
   */
  domain: [number, number];
  /**
   * True when the domain is narrower than the quantity's real range, so values
   * beyond it saturate. The legend must say so — a clamped end is a floor or a
   * ceiling, not a measurement.
   */
  clamped?: boolean;
  diverging: boolean;
}

/**
 * Domains measured over the model's whole span, not guessed.
 *
 * Intensity across 1900-2030 runs 21,909 to 69,432 nT; the domain is rounded
 * outward to 20,000-70,000 so clamping never bites at either end. Declination
 * and inclination are bounded by their own definitions.
 */
export const FIELD_SCALES: Record<FieldQuantity, FieldScale> = {
  intensity: {
    label: 'Total intensity',
    unit: 'nT',
    domain: [20_000, 70_000],
    diverging: false,
  },
  declination: {
    label: 'Declination',
    unit: '° east of true north',
    /**
     * **Not the definitional range, and that was a real bug.**
     *
     * Declination is defined on [-180, 180], and using that renders almost the
     * whole planet as the neutral midpoint: measured at 2026, the median |D| is
     * **13.1 degrees** and **77% of the surface is within 30 degrees**. On a
     * +/-180 scale that is 7% off centre — grey. The only places that reached a
     * pole colour were the magnetic poles themselves, where D genuinely swings
     * through the full circle. The layer looked broken and was arithmetically
     * correct.
     *
     * +/-30 clamped puts that 77% across the full ramp, keeps the agonic line
     * (D = 0) as the neutral band it should be, and saturates the polar regions
     * — which is honest, because they *are* off the scale. The legend says so
     * rather than letting the clamp pass for a measurement.
     */
    domain: [-30, 30],
    clamped: true,
    diverging: true,
  },
  inclination: {
    label: 'Inclination',
    unit: '° below horizontal',
    // The definitional range is right here, because the data fills it: median
    // |I| is 61.7 degrees and only 16% of the surface is within 30. The neutral
    // band lands on the magnetic equator, which is the feature worth seeing.
    domain: [-90, 90],
    diverging: true,
  },
};

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * A colour from a ramp at position `t` in [0, 1].
 *
 * Interpolates between neighbouring *published* steps rather than between the
 * ramp's endpoints. The steps are already perceptually spaced, so blending
 * across one short gap in sRGB is close enough to be invisible, whereas
 * interpolating end-to-end in sRGB would bow through a muddy middle.
 */
export function rampAt(steps: readonly string[], t: number): Rgb {
  if (steps.length === 0) return [0, 0, 0];
  const clamped = Math.min(Math.max(t, 0), 1);
  const scaled = clamped * (steps.length - 1);
  const index = Math.min(Math.floor(scaled), steps.length - 2);
  const frac = scaled - index;

  const a = hexToRgb(steps[index] ?? '#000000');
  const b = hexToRgb(steps[index + 1] ?? steps[index] ?? '#000000');

  return [
    Math.round((a[0] ?? 0) + frac * ((b[0] ?? 0) - (a[0] ?? 0))),
    Math.round((a[1] ?? 0) + frac * ((b[1] ?? 0) - (a[1] ?? 0))),
    Math.round((a[2] ?? 0) + frac * ((b[2] ?? 0) - (a[2] ?? 0))),
  ];
}

/** The colour for one value of a quantity, on a given backdrop. */
export function fieldColor(
  value: number,
  quantity: FieldQuantity,
  tone: BackdropTone,
): Rgb {
  const scale = FIELD_SCALES[quantity];
  const [lo, hi] = scale.domain;

  if (!scale.diverging) {
    return rampAt(SEQUENTIAL_VIRIDIS, (value - lo) / (hi - lo));
  }

  // Diverging: distance from zero along the appropriate arm, with the neutral
  // midpoint as the shared origin of both.
  const extent = Math.max(Math.abs(lo), Math.abs(hi));
  const magnitude = Math.min(Math.abs(value) / extent, 1);
  const arm = value >= 0 ? DIVERGING_RED_ARM : DIVERGING_BLUE_ARM;
  const withMidpoint = [MIDPOINT[tone], ...arm];
  return rampAt(withMidpoint, magnitude);
}

/**
 * Paints a sampled grid into RGBA bytes, row-major from the north edge.
 *
 * Separate from any canvas so it can be tested as a pure function; the layer
 * hands the result to `putImageData`.
 *
 * `alpha` is uniform across the raster on purpose. Varying opacity with the
 * value would make the basemap show through more in some places than others,
 * which reads as a second, contradictory encoding of the same number.
 */
export function paintFieldRgba(
  values: Float64Array,
  width: number,
  height: number,
  quantity: FieldQuantity,
  tone: BackdropTone,
  alpha = 255,
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);

  for (let i = 0; i < width * height; i += 1) {
    const [r, g, b] = fieldColor(values[i] ?? 0, quantity, tone);
    const o = i * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = alpha;
  }

  return rgba;
}

/** Evenly spaced sample colours and values, for the legend. */
export function fieldLegendStops(
  quantity: FieldQuantity,
  tone: BackdropTone,
  count = 5,
): { value: number; color: string }[] {
  const [lo, hi] = FIELD_SCALES[quantity].domain;
  return Array.from({ length: count }, (_, i) => {
    const value = lo + ((hi - lo) * i) / (count - 1);
    const [r, g, b] = fieldColor(value, quantity, tone);
    return { value, color: `rgb(${String(r)} ${String(g)} ${String(b)})` };
  });
}
