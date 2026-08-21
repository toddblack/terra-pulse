import type { BackdropTone } from '@terra-pulse/schema';
import { rampAt, type Rgb } from './field-encoding';

/**
 * Colour for the lunisolar equilibrium tide.
 *
 * Pure and Cesium-free, like the other encodings, so the ramp can be tested
 * without a WebGL context.
 *
 * ## A diverging ramp, because zero means something
 *
 * The equilibrium tide is signed: positive where the Moon and Sun raise the
 * surface, negative on the belt between the two bulges where they lower it. The
 * zero line is the boundary between the two, and it is a real feature — so this
 * gets a diverging ramp with a **light neutral midpoint**, exactly as
 * declination and inclination do, and for the reason recorded there: both arms
 * run light near the centre out to dark at the poles, so a dark midpoint would
 * punch a dark notch through zero and make the quietest band the loudest thing
 * on screen.
 *
 * ## Why teal and amber
 *
 * Hue is how four rasters stay apart. Already claimed: **aurora green**,
 * **field viridis** with a **blue/red** diverging pair, **magnetopause and
 * magnetometers cyan**, **TEC magenta** with a **purple/orange** diverging
 * pair. This layer takes **teal (low) and amber (high)**.
 *
 * The cool arm is where the separation actually lives. With a light midpoint
 * both poles must be dark, and every dark warm colour converges on brown — so
 * the three diverging ramps here are necessarily similar on their warm side and
 * are told apart by their cool side: blue, purple, teal.
 *
 * **Validated, not eyeballed**, with the same tool and against the same two
 * backdrops as the field ramp. The poles separate at **CVD dE 11.8 (protan)**
 * and **23.5 (tritan)** against a floor of 8, with **20.7 normal-vision**
 * separation against a floor of 15, and both sit inside the lightness band on
 * the light *and* dark basemaps.
 *
 * One check does not pass and is recorded rather than hidden: the teal pole's
 * chroma is **0.097 against a 0.10 floor**. That check exists to stop a
 * *categorical* slot reading grey beside its neighbours; teal is intrinsically
 * low-chroma at this lightness, and as one pole of a diverging ramp against a
 * light neutral it is unambiguous. If a future revision can raise it without
 * losing the CVD separation above, it should.
 */

/** Low arm — the belt between the bulges, where the surface is drawn down. */
const LOW_ARM = ['#cfe9e5', '#a3d6cf', '#71c1b8', '#3aa89e', '#12938a', '#00857c'] as const;

/** High arm — under the Moon, and directly opposite it. */
const HIGH_ARM = ['#f9e6c8', '#f3cf96', '#e9b25f', '#db9531', '#c9810f', '#b8730c'] as const;

/**
 * Neutral midpoint, light on both backdrops.
 *
 * The same values the field ramp settled on, and for the same reason — see
 * `field-encoding.ts`, where taking the palette's dark chart surface here was a
 * real bug.
 */
const MIDPOINT: Record<BackdropTone, string> = {
  light: '#f0efec',
  dark: '#eceae6',
};

/**
 * Each arm runs to **its own** physical extreme, and this reverses an earlier
 * symmetric domain on measurement.
 *
 * The degree-2 tide is intrinsically lopsided: `(3cos^2(psi) - 1) / 2` runs
 * from **-0.5 to +1**, so a trough can only ever be half as deep as a bulge is
 * tall. With one symmetric domain of +/-60 cm the low arm was therefore capped
 * at **49% of its range for all time** — half the ramp unreachable by
 * construction, and teal never darker than a wash.
 *
 * Measured over the globe, area-weighted, that was worse than it sounds because
 * the *high* arm collapses too at neap tide, when the Sun and Moon partly
 * cancel:
 *
 *     spring   low 49% of arm   high 98%   53% of globe within 40% of neutral
 *     neap     low 47%          high 50%   87% of globe within 40% of neutral
 *
 * Half the month, seven eighths of the planet was pale. That is the declination
 * mistake in `field-encoding.ts` repeated exactly: **a domain taken from the
 * definition rather than from the distribution.**
 *
 * ## Why per-arm scaling is legitimate here and is not for declination
 *
 * A diverging ramp normally owes the reader that equal colour distance means
 * equal magnitude either side of zero, and declination depends on it — east and
 * west are two directions of one quantity, and a reader genuinely compares
 * "20 east" against "20 west".
 *
 * Raised and lowered ground are not that. They are physically different states
 * with different reachable ranges, and nobody asks whether a -20 cm trough
 * "beats" a +20 cm bulge. What the reader actually does is locate the bulges
 * and the trough belt within a frame, and compare a frame against another frame
 * — and both survive per-arm scaling, while both were being lost to the wash.
 *
 * The spring/neap signal survives too, and stays on the arm that carries it:
 * the trough depth is nearly constant (-28 to -30 cm at every phase measured)
 * while the bulge swings 30 to 59 cm, so it is the **amber** that deepens at
 * spring. The legend prints both ends so the asymmetry is stated, not implied.
 */
export const TIDE_LOW_DOMAIN_M = 0.31;
export const TIDE_HIGH_DOMAIN_M = 0.62;

/** What the legend calls it. Centimetres, because metres would be all zeroes. */
export const TIDE_UNIT = 'cm';

/**
 * Each end is the quantity's own physical limit, reached only when a perigean
 * Moon and a perihelion Sun line up — so saturation means "as extreme as this
 * gets", not "off the scale". Nothing is truncated.
 */
export const TIDE_CLAMPED = false;

/** Colour for one equilibrium tide height, in metres. */
export function tideColor(heightM: number, tone: BackdropTone): Rgb {
  const domain = heightM < 0 ? TIDE_LOW_DOMAIN_M : TIDE_HIGH_DOMAIN_M;
  const strength = Math.min(1, Math.abs(heightM) / domain);
  const arm = heightM < 0 ? LOW_ARM : HIGH_ARM;
  return rampAt([MIDPOINT[tone], ...arm], strength);
}

/**
 * The whole grid as RGBA, row-major from the north edge.
 *
 * **Every cell fully opaque, and the see-through-ness lives on the layer.**
 * The aurora makes transparency carry meaning because ~70% of its cells are
 * genuine zeroes — an absence. There is no such thing as an absent tide: every
 * point on Earth has one at every instant, and a see-through cell would state
 * something false about coverage.
 *
 * The raster's opacity over the globe is `TIDE_ALPHA` on the `ImageryLayer`
 * instead, because alpha there is also the cross-fade control between frames —
 * baking it into the pixels would leave nothing to fade with.
 */
export function paintTideRgba(
  values: Float64Array,
  tone: BackdropTone,
  alpha = 255,
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    const [r, g, b] = tideColor(values[i]!, tone);
    const at = i * 4;
    rgba[at] = r;
    rgba[at + 1] = g;
    rgba[at + 2] = b;
    rgba[at + 3] = alpha;
  }
  return rgba;
}

/**
 * Discrete legend steps, low to high.
 *
 * Drawn as steps rather than a CSS gradient for the reason the field legend
 * records: a gradient interpolates in sRGB between the ends and would quietly
 * disagree with the raster it claims to describe.
 */
export function tideLegendStops(tone: BackdropTone, steps = 11): { color: Rgb; valueCm: number }[] {
  const stops: { color: Rgb; valueCm: number }[] = [];
  for (let i = 0; i < steps; i++) {
    // -1 at the low extreme, 0 at neutral, +1 at the high one. Each half of the
    // strip covers its own arm's range, so the printed end labels differ in
    // magnitude — which is the point, and what the legend has to show.
    const fraction = (i / (steps - 1)) * 2 - 1;
    const heightM = fraction * (fraction < 0 ? TIDE_LOW_DOMAIN_M : TIDE_HIGH_DOMAIN_M);
    stops.push({ color: tideColor(heightM, tone), valueCm: Math.round(heightM * 100) });
  }
  return stops;
}
