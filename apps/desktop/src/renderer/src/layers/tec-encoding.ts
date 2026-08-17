import {
  TEC_ANOMALY_RANGE_TECU,
  TEC_MAX_TECU,
  type TecGrid,
  type TecQuantity,
} from '@terra-pulse/schema';
import type { BackdropTone } from '@terra-pulse/schema';
import { rampAt, type Rgb } from './field-encoding';

/**
 * Colour for total electron content.
 *
 * ## Two quantities, two kinds of ramp
 *
 * **TEC** is a magnitude with no meaningful zero on the scale — the ionosphere
 * is never absent — so it gets a *sequential* ramp, dark to light, monotonic in
 * OKLab lightness. **Anomaly** is a signed departure from the quiet-time
 * expectation, so it gets a *diverging* ramp with a neutral midpoint, exactly as
 * declination and inclination do.
 *
 * ## Why magenta, when the field layer already has a perfectly good viridis
 *
 * Because four space-weather layers can now be on at once and hue is how a
 * reader tells one raster from another:
 *
 *   - **aurora** — green (557.7 nm atomic oxygen, literal rather than decorative)
 *   - **geomagnetic field** — viridis, purple through blue and green to yellow
 *   - **magnetopause / magnetometers** — cyan, with red for the notable state
 *   - **TEC** — magenta
 *
 * Magenta is the sizeable gap left in that set. It is a **single hue**, which is
 * the palette's default rule for sequential data; the field layer's departure to
 * viridis was taken because one blue could not resolve the South Atlantic
 * Anomaly, and TEC has no equivalently fine structure — its subject is the
 * broad equatorial crests, which a single hue carries easily.
 *
 * Brighter means more, matching the aurora and the field: the other two rasters
 * already establish that direction, and reversing it here would make a bright
 * patch mean opposite things on two layers a reader may flip between.
 */
const SEQUENTIAL_MAGENTA = [
  '#2a0a29',
  '#4d1049',
  '#75186c',
  '#a02089',
  '#c8359f',
  '#e263b8',
  '#f39ad2',
  '#fbcfe8',
] as const;

/**
 * The anomaly's arms, from the neutral midpoint out to each pole.
 *
 * **Purple for depleted, orange for enhanced** — deliberately not the field
 * layer's blue/red. Both layers can be on at once, and two diverging rasters
 * sharing a hue pair would be indistinguishable where they overlap. Purple and
 * orange are a standard diverging pair and neither collides with the green,
 * cyan or viridis already in use.
 *
 * Equal step count per arm, as a diverging ramp requires — unequal arms make one
 * sign look like it covers more ground than it does.
 */
const DEPLETED_ARM = ['#e6dcec', '#c9b3d8', '#a985c2', '#8b5fa8', '#6f4490', '#552f75'] as const;
const ENHANCED_ARM = ['#f8e4cd', '#f2c795', '#e8a457', '#d9822b', '#bd6618', '#994f10'] as const;

/**
 * Neutral midpoint, light on both backdrops.
 *
 * The same decision as the field layer's, for the same reason — and that one was
 * a bug first. A midpoint matching a *dark* surface makes lightness run dark,
 * light, dark across the ramp, which punches a notch through zero and turns the
 * quietest band into the most salient thing on screen. A light neutral keeps
 * lightness monotonic from each pole in to zero, which is what a diverging ramp
 * is for.
 */
const MIDPOINT: Record<BackdropTone, string> = {
  light: '#f0efec',
  dark: '#eceae6',
};

/** What each quantity is called and the range its ramp covers. */
export interface TecScale {
  label: string;
  unit: string;
  min: number;
  max: number;
  /** True when the domain is narrower than the data, so the legend says `≥`. */
  clamped: boolean;
  diverging: boolean;
}

export const TEC_SCALES: Record<TecQuantity, TecScale> = {
  tec: {
    label: 'Total electron content',
    unit: 'TECU',
    min: 0,
    /**
     * 60, against the product's declared maximum of 300.
     *
     * Measured over five maps spanning a month: p50 12.9, p95 41.9, max 60.5.
     * The declared range is the *definition*; this is the *distribution*, and
     * the difference is the mistake the declination ramp already made once.
     */
    max: TEC_MAX_TECU,
    clamped: true,
    diverging: false,
  },
  anomaly: {
    label: 'TEC anomaly',
    unit: 'TECU',
    min: -TEC_ANOMALY_RANGE_TECU,
    max: TEC_ANOMALY_RANGE_TECU,
    clamped: true,
    diverging: true,
  },
};

/** Colour for one value of one quantity. */
export function tecColor(
  value: number,
  quantity: TecQuantity,
  tone: BackdropTone,
): Rgb {
  const scale = TEC_SCALES[quantity];

  if (!scale.diverging) {
    const t = clamp01((value - scale.min) / (scale.max - scale.min));
    return rampAt(SEQUENTIAL_MAGENTA, t);
  }

  // Each arm runs outward from the shared midpoint, so zero is the same colour
  // whichever side it is approached from.
  const strength = clamp01(Math.abs(value) / scale.max);
  const arm = value < 0 ? DEPLETED_ARM : ENHANCED_ARM;
  return rampAt([MIDPOINT[tone], ...arm], strength);
}

function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

/**
 * Paints a grid into RGBA bytes, row-major, for a canvas of the grid's size.
 *
 * ## Uniform alpha, unlike the aurora
 *
 * The auroral layer makes transparency carry meaning: ~70% of its cells are
 * genuine zeroes, and painting them with the ramp's low end would imply a
 * global phenomenon. **TEC is the opposite** — the ionosphere is everywhere, so
 * every cell has a real value and a transparent cell would be a lie about
 * coverage rather than an honest absence.
 *
 * The one thing that *is* transparent is a cell the product did not supply.
 * Those stay fully clear so a gap reads as a gap, not as a low value.
 */
export function paintTecRgba(
  grid: TecGrid,
  quantity: TecQuantity,
  tone: BackdropTone,
  alpha = 190,
): Uint8ClampedArray {
  const values = quantity === 'tec' ? grid.tec : grid.anomaly;
  const bytes = new Uint8ClampedArray(values.length * 4);

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === null || value === undefined) continue; // left transparent

    const [r, g, b] = tecColor(value, quantity, tone);
    const at = i * 4;
    bytes[at] = r;
    bytes[at + 1] = g;
    bytes[at + 2] = b;
    bytes[at + 3] = alpha;
  }

  return bytes;
}

/**
 * Legend stops, drawn as discrete steps rather than a CSS gradient.
 *
 * A gradient would interpolate in sRGB between the ends and quietly disagree
 * with the raster, which interpolates in the ramp's own steps — the same reason
 * the field legend draws steps.
 */
export function tecLegendStops(
  quantity: TecQuantity,
  tone: BackdropTone,
  steps = 12,
): { value: number; color: string }[] {
  const scale = TEC_SCALES[quantity];
  return Array.from({ length: steps }, (_, i) => {
    const value = scale.min + ((scale.max - scale.min) * i) / (steps - 1);
    const [r, g, b] = tecColor(value, quantity, tone);
    return { value, color: `rgb(${String(r)} ${String(g)} ${String(b)})` };
  });
}
