import type { BasemapId } from '@terra-pulse/schema';

/**
 * The visual grammar for earthquake marks. Pure — no Cesium imports — so the
 * encoding rules can be tested directly without a WebGL context.
 */

// ---------------------------------------------------------------------------
// Depth → color
// ---------------------------------------------------------------------------

// Bin edges chosen so the standard seismological classification falls exactly
// on boundaries and stays recoverable by grouping:
//   shallow      < 70 km   = bins 0–1
//   intermediate 70–300 km = bin 2
//   deep         > 300 km  = bins 3–4
// The extra split at 20 km exists because real catalogs pile up there — USGS
// pins poorly-constrained events at a fixed 10 km, so without it the single
// most populous band would be undifferentiated.
export interface DepthBin {
  /** Inclusive lower bound, km. */
  minKm: number;
  /** Exclusive upper bound, km. `null` on the deepest (unbounded) bin. */
  maxKm: number | null;
  label: string;
}

export const DEPTH_BINS: readonly DepthBin[] = [
  { minKm: 0, maxKm: 20, label: '0–20 km' },
  { minKm: 20, maxKm: 70, label: '20–70 km' },
  { minKm: 70, maxKm: 300, label: '70–300 km' },
  { minKm: 300, maxKm: 500, label: '300–500 km' },
  { minKm: 500, maxKm: null, label: '500+ km' },
];

// Five steps, not six: a single-hue ordinal ramp needs ~0.06 lightness between
// adjacent steps to stay separable, and six steps require a span wide enough
// that the pale end drops below the readability floor over OSM's light
// terrain. Verified with the dataviz skill's validator against the actual
// basemap colors rather than a generic chart surface.
//
// Direction flips per basemap so that *shallow always reads as the most
// prominent* — shallow quakes are the consequential ones, and a fixed
// direction would make them nearly vanish on one of the two basemaps.
// Both orderings pass all ordinal checks against their real surface.
const DEPTH_COLORS_LIGHT_BASEMAP = [
  '#0d366b',
  '#184f95',
  '#256abf',
  '#3987e5',
  '#6da7ec',
] as const;

const DEPTH_COLORS_DARK_BASEMAP = [
  '#cde2fb',
  '#9ec5f4',
  '#6da7ec',
  '#3987e5',
  '#256abf',
] as const;

// The halo is what makes a mark readable over an arbitrary photograph. It
// contrasts with the *fill*, not the basemap — that decouples figure-ground
// separation from the fill's job of carrying depth, so the ramp doesn't also
// have to out-contrast every pixel of terrain underneath it.
const HALO_LIGHT_BASEMAP = '#ffffff';
const HALO_DARK_BASEMAP = '#0b0b0b';

function isDarkBasemap(basemap: BasemapId): boolean {
  return basemap === 'satellite';
}

/** Index into `DEPTH_BINS`. Depths outside the range clamp to an end bin. */
export function depthBinIndex(depthKm: number): number {
  if (!Number.isFinite(depthKm)) return 0;

  for (let i = DEPTH_BINS.length - 1; i >= 1; i--) {
    if (depthKm >= DEPTH_BINS[i]!.minKm) return i;
  }
  // Falls through for anything below the second bin's floor — including the
  // small negative depths USGS reports for events above sea level.
  return 0;
}

export function depthColorHex(depthKm: number, basemap: BasemapId): string {
  const palette = isDarkBasemap(basemap)
    ? DEPTH_COLORS_DARK_BASEMAP
    : DEPTH_COLORS_LIGHT_BASEMAP;
  return palette[depthBinIndex(depthKm)]!;
}

/** Ordered swatches for the legend, matching the active basemap. */
export function depthLegendColors(basemap: BasemapId): readonly string[] {
  return isDarkBasemap(basemap) ? DEPTH_COLORS_DARK_BASEMAP : DEPTH_COLORS_LIGHT_BASEMAP;
}

export function haloColorHex(basemap: BasemapId): string {
  return isDarkBasemap(basemap) ? HALO_DARK_BASEMAP : HALO_LIGHT_BASEMAP;
}

// ---------------------------------------------------------------------------
// Magnitude emphasis
// ---------------------------------------------------------------------------

/**
 * Above this, an event gets a second concentric ring so it reads at a glance.
 *
 * This marks size, NOT danger — an M6 at 600 km under open ocean is harmless,
 * while a shallow M5.5 under a city is not. USGS's own modelled impact
 * estimate is the `alertLevel` (PAGER) field, which is a separate thing and
 * deliberately not what this encodes.
 */
export const EMPHASIS_MAGNITUDE_THRESHOLD = 5.5;

// Unlike the halo — which sits against the fill — the emphasis ring sits out
// on bare terrain, so it takes the opposite treatment: dark over light
// basemaps, light over dark imagery.
const EMPHASIS_RING_LIGHT_BASEMAP = '#0b0b0b';
const EMPHASIS_RING_DARK_BASEMAP = '#ffffff';

/** Clear space between the dot's edge and the ring, in pixels per side. */
const EMPHASIS_RING_GAP_PX = 4;

export function isEmphasized(magnitude: number): boolean {
  return Number.isFinite(magnitude) && magnitude >= EMPHASIS_MAGNITUDE_THRESHOLD;
}

export function emphasisRingColorHex(basemap: BasemapId): string {
  return isDarkBasemap(basemap) ? EMPHASIS_RING_DARK_BASEMAP : EMPHASIS_RING_LIGHT_BASEMAP;
}

export function emphasisRingPixelSize(magnitude: number): number {
  return magnitudePixelSize(magnitude) + EMPHASIS_RING_GAP_PX * 2;
}

/** The conventional three-way class, for display alongside a raw depth. */
export function depthClass(depthKm: number): 'shallow' | 'intermediate' | 'deep' {
  if (depthKm < 70) return 'shallow';
  if (depthKm < 300) return 'intermediate';
  return 'deep';
}

// ---------------------------------------------------------------------------
// Magnitude → size
// ---------------------------------------------------------------------------

const MIN_MAGNITUDE = 2.5;
const MAX_MAGNITUDE = 8;
const MIN_PIXEL_SIZE = 5;
const MAX_PIXEL_SIZE = 22;

/**
 * Linear in magnitude, deliberately. Magnitude is *already* logarithmic in
 * released energy, so a linear pixel mapping is the honest one — applying a
 * further exponential curve on top would visually oversell large events by
 * compounding a scale that's already compressed.
 *
 * Clamped at both ends so a great earthquake can't blow out the viewport and a
 * micro event can't shrink below clickability.
 */
export function magnitudePixelSize(magnitude: number): number {
  if (!Number.isFinite(magnitude)) return MIN_PIXEL_SIZE;

  const clamped = Math.min(Math.max(magnitude, MIN_MAGNITUDE), MAX_MAGNITUDE);
  const t = (clamped - MIN_MAGNITUDE) / (MAX_MAGNITUDE - MIN_MAGNITUDE);
  return MIN_PIXEL_SIZE + t * (MAX_PIXEL_SIZE - MIN_PIXEL_SIZE);
}
