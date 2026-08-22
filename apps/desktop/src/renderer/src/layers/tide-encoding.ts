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
 * ## Why violet and red-orange
 *
 * This ramp was **teal and amber** and it disappeared into the terrain. The
 * user's report — that it "gets a little lost on the relief and seafloor globe
 * settings" — was exact, and measuring it produced a stronger statement than
 * the complaint: **the two poles sat in the two worst hue regions available.**
 *
 * Both basemaps were fetched and decoded (1024x512, area-weighted by cos(lat)),
 * then every hue was taken to the most chroma sRGB will hold for it, composited
 * over every real pixel at this layer's own `TIDE_ALPHA`, and scored on how far
 * it separates from the neutral midpoint **in units of the terrain's own
 * variation along that same direction** — signal over noise, where the noise is
 * the planet underneath. That curve has two troughs:
 *
 *     hue 160-250 (teal - cyan - blue)     ratio 3.5-4.6   <- old low arm, 187
 *     hue  60-110 (amber - olive)          ratio 4.4-4.9   <- old high arm, 68
 *     hue 270-330 (blue-violet - magenta)  ratio 7.6-8.4
 *     hue   0- 30 (pink-red - red)         ratio 7.2-7.3
 *
 * **Teal was also at the sRGB gamut ceiling.** The most chroma hue 187 can hold
 * at that lightness *is* 0.097, which is what it used. That arm could not be
 * made more vibrant. It could only be moved.
 *
 * The underlying cause is worth keeping, because it applies to any raster drawn
 * over imagery: **terrain varies almost entirely in lightness.** Its principal
 * axis is 99.3% lightness on relief and 95.0% on seafloor, explaining 94% and
 * 92% of all variance, while its chroma barely moves (sd 0.013-0.029 in OKLab).
 * Chroma is a nearly empty channel — and a light-midpoint diverging ramp spends
 * its signal in lightness by construction, head-on against the basemap's
 * loudest dimension. The fix is chroma, and hue matters mostly through how much
 * chroma sRGB allows there.
 *
 * Violet is the pick because **neither basemap contains it at any strength**
 * and it holds **0.264 chroma, 2.7x the teal it replaces**. Worst-case ratio
 * across both arms and both basemaps goes **5.01 -> 6.63**.
 *
 * ## What this costs
 *
 * Hue is how the rasters stay apart, and this lands near **TEC's purple/orange
 * diverging pair**. Taken deliberately, with the user's sign-off: both layers
 * are off by default and both are *global* rasters, so they were never legible
 * simultaneously whatever their hues. The remaining budget is **aurora green**,
 * **field viridis** with a blue/red pair, **magnetopause and magnetometers
 * cyan**, and now **TEC magenta and this violet sharing a region**.
 *
 * A blue/orange-red pair was the alternative and was rejected on measurement,
 * not taste: it scores **5.35**, barely above the ramp it replaces, because its
 * cool arm still shares a region with ocean.
 *
 * **Validated, not eyeballed**, with the same tool and against the same two
 * backdrops as the field ramp. All six checks pass in both modes — including
 * the **chroma floor, which teal never passed**. The poles separate at **CVD
 * dE 32.0 (protan) / 27.0 (tritan)** against a floor of 8, and **35.8
 * normal-vision** against a floor of 15.
 */

/**
 * Low arm — the belt between the bulges, where the surface is drawn down.
 *
 * **The stops are paced by equal perceptual distance, not by eye**, generated
 * along a straight OKLab line from the midpoint to the pole. `rampAt`
 * interpolates by *index*, so evenly-spaced stops are what makes position along
 * the ramp mean the same amount of colour change everywhere.
 *
 * The old ramp was not: its steps ran 3.8, 7.5, 8.5, 9.0, 6.6, 4.1 dE — bunched
 * at both ends, with the smallest step exactly where most of the globe's cells
 * sit at neap tide. `tide-encoding.test.ts` pins the evenness, because a
 * hand-edited stop would reintroduce it silently.
 */
const LOW_ARM = ['#dacfeb', '#cab4ef', '#b997f1', '#aa7af2', '#9c58f1', '#8e2af0'] as const;

/** High arm — under the Moon, and directly opposite it. Paced as above. */
const HIGH_ARM = ['#f3d0c7', '#f7b7a9', '#f99c8b', '#f97f6c', '#f85f4b', '#f43523'] as const;

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
 * construction, and the cool arm never darker than a wash.
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
 * while the bulge swings 30 to 59 cm, so it is the **red-orange** that deepens
 * at spring. The legend prints both ends so the asymmetry is stated, not
 * implied.
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

/**
 * Position within an arm is `strength ** TIDE_STRENGTH_GAMMA`, not `strength`.
 *
 * The globe's cells are not spread evenly across an arm. Measured area-weighted
 * at neap tide, the median cell sits at **strength 0.199** — so a linear mapping
 * spends most of the ramp on values most of the planet never has, and half the
 * month the map reads as a wash. A mild gamma moves ramp onto where the cells
 * actually are: neap median colour distance from neutral goes **3.6 -> 7.5 dE**
 * and the share of the globe within dE 5 of neutral falls **60% -> 33%**.
 *
 * **This is a display transform and it is legitimate *here* specifically.** The
 * layer draws the potential and makes no statistical claim — nothing downstream
 * reads a colour back as a number, and `tideLegendStops` is generated from this
 * same function, so the non-linearity shows up as non-uniformly spaced value
 * labels rather than being hidden. Do not carry it onto an Analyze surface.
 *
 * **0.8 and not lower, deliberately.** The honest target is that perceived
 * spring/neap contrast tracks the physical one: the median strength ratio
 * between those phases is **2.82**. Evenly-paced stops alone give 2.93 — nearly
 * exact. Gamma trades that fidelity for legibility, and it goes one way only:
 * 0.6 shows a 2.8x physical difference as 1.9x. 0.8 keeps it at ~2.5 while
 * still doubling what the quiet half of the month shows. Going lower to "make
 * it pop" is spending the spring/neap signal, which is the thing the layer
 * exists to show.
 */
export const TIDE_STRENGTH_GAMMA = 0.8;

/** Colour for one equilibrium tide height, in metres. */
export function tideColor(heightM: number, tone: BackdropTone): Rgb {
  const domain = heightM < 0 ? TIDE_LOW_DOMAIN_M : TIDE_HIGH_DOMAIN_M;
  const strength = Math.min(1, Math.abs(heightM) / domain) ** TIDE_STRENGTH_GAMMA;
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
