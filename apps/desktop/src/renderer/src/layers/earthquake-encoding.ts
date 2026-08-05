import type { BackdropTone } from '@terra-pulse/schema';

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

/**
 * Depth genuinely unknown — a handful of pre-1980 archive events.
 *
 * **The same colour on both basemaps, unlike every other mark here.** The
 * ordinal ramp flips direction per basemap so shallow always reads loudest;
 * this value isn't *on* that ramp, so flipping it would imply an ordering it
 * doesn't have.
 *
 * A warm grey, chosen by measurement rather than convention. Neutral is the
 * standard "no data" treatment, but the obvious light greys fail on the dark
 * basemap: that ramp runs pale, so its top step (#cde2fb) is already in the
 * light-neutral region — #d6d3d1 lands at ΔE 5.8 from it. The free perceptual
 * room on both basemaps turned out to be *below* the ramp, not above.
 *
 * Measured OKLab ΔE against the nearest ramp step: 16.3 on the light basemap,
 * 16.3 on the dark, against this project's floor of 15. Also ≥20 from every
 * halo, ring and recency stroke it can appear beside.
 *
 * Contrast against the basemap itself is deliberately not the bar — the halo
 * does figure-ground separation here, as it does for every other fill.
 */
export const UNKNOWN_DEPTH_COLOR = '#78716c';

// The halo is what makes a mark readable over an arbitrary photograph. It
// contrasts with the *fill*, not the basemap — that decouples figure-ground
// separation from the fill's job of carrying depth, so the ramp doesn't also
// have to out-contrast every pixel of terrain underneath it.
const HALO_LIGHT_BASEMAP = '#ffffff';
const HALO_DARK_BASEMAP = '#0b0b0b';

// ---------------------------------------------------------------------------
// Recency → halo colour
// ---------------------------------------------------------------------------

/**
 * Events at or under this age get a red halo instead of the neutral one.
 *
 * The display window reaches four days, so "happened today" is otherwise
 * invisible — a 6-hour-old event and a 90-hour-old one look identical. This is
 * the one distinction the mark couldn't already make: size is magnitude, fill
 * is depth, and the concentric ring is reserved for M5.5+.
 *
 * Deliberately binary rather than a fade with age. A continuous ramp would have
 * to live in opacity or lightness, and both of those are already carrying depth
 * — dimming an old shallow event would make it read as a deeper one.
 */
export const RECENT_WINDOW_HOURS = 24;

/**
 * Red because it means the same thing here as everywhere else: *look at this
 * one*. It replaces the halo rather than adding a second ring, so a recent
 * M5.5+ event still gets its emphasis ring and the two encodings stay
 * independent — a red-stroked dot inside a ring reads as "big, and today".
 *
 * The stroke has to read against the **fill**, not the basemap, so these follow
 * the same inversion as the neutral halos above: the light basemap's depth ramp
 * runs dark, so its recency stroke is a bright red; the dark basemap's ramp runs
 * pale, so its stroke is deep.
 *
 * Verified by perceptual distance (OKLab ΔE), not WCAG contrast ratio — red on
 * blue works through *hue*, and a luminance-only measure scores it badly while
 * the eye finds it obvious. Measured ΔE 29-44 light, 31-50 dark, against a
 * project-wide floor of 15. For scale, plain white manages only 2.50:1 WCAG
 * against the lightest depth fill, so that metric was never the right bar for
 * an edge like this.
 */
const RECENT_HALO_LIGHT_BASEMAP = '#ff5468';
const RECENT_HALO_DARK_BASEMAP = '#a1001a';

/**
 * Slightly heavier than the neutral halo, because hue alone is easy to miss on
 * a 5px dot. Still well under the emphasis ring's weight, so it reads as an
 * attribute of the dot rather than a second ring around it.
 */
export const HALO_WIDTH = 1.5;
export const RECENT_HALO_WIDTH = 2;

/**
 * Whether an event happened within the recency window.
 *
 * `nowMs` is injected rather than read from the clock so this is testable and
 * so a whole layer build shares one consistent "now" — otherwise events near
 * the boundary could disagree within a single render.
 */
export function isRecentEvent(timeUtc: string, nowMs: number): boolean {
  const eventMs = Date.parse(timeUtc);
  // An unparseable timestamp can't be shown to be recent. Falling back to
  // "recent" would light up the globe on bad data.
  if (!Number.isFinite(eventMs)) return false;

  const ageMs = nowMs - eventMs;
  // Future-dated events are a clock-skew artefact, not something to hide; a
  // small negative age still counts as recent.
  return ageMs <= RECENT_WINDOW_HOURS * 60 * 60 * 1000;
}

export function recentHaloColorHex(tone: BackdropTone): string {
  return tone === 'dark' ? RECENT_HALO_DARK_BASEMAP : RECENT_HALO_LIGHT_BASEMAP;
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

export function depthColorHex(depthKm: number | null, tone: BackdropTone): string {
  // Null is "the catalogue doesn't know", which is not a depth and must not be
  // binned as one — binning it would paint it as shallow.
  if (depthKm === null) return UNKNOWN_DEPTH_COLOR;
  return depthLegendColors(tone)[depthBinIndex(depthKm)]!;
}

/** Ordered swatches for the legend, matching the active backdrop. */
export function depthLegendColors(tone: BackdropTone): readonly string[] {
  return tone === 'dark' ? DEPTH_COLORS_DARK_BASEMAP : DEPTH_COLORS_LIGHT_BASEMAP;
}

export function haloColorHex(tone: BackdropTone): string {
  return tone === 'dark' ? HALO_DARK_BASEMAP : HALO_LIGHT_BASEMAP;
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
 *
 * **Fixed, not relative to the view's floor.** A floor-relative version was
 * tried: in an archive view that is already M5.5+ it meant every mark carried a
 * ring, which is a second Cesium entity each and most of why that view costs
 * 590 ms to build against 110 ms without. It was reverted anyway, because M5.5
 * means the same thing on every screen — the ring answers "is this a big one?",
 * and that question does not change because the surrounding view narrowed.
 * The entity cost is the price of a consistent encoding.
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

export function emphasisRingColorHex(tone: BackdropTone): string {
  return tone === 'dark' ? EMPHASIS_RING_DARK_BASEMAP : EMPHASIS_RING_LIGHT_BASEMAP;
}

export function emphasisRingPixelSize(magnitude: number): number {
  return magnitudePixelSize(magnitude) + EMPHASIS_RING_GAP_PX * 2;
}

/**
 * The conventional three-way class, for display alongside a raw depth.
 *
 * Null in, null out. There is no fourth class here on purpose — "unknown" is
 * the absence of a classification, not another one, and returning a string
 * would let it be formatted as though the catalogue had made a call.
 */
export function depthClass(depthKm: number | null): 'shallow' | 'intermediate' | 'deep' | null {
  if (depthKm === null) return null;
  if (depthKm < 70) return 'shallow';
  if (depthKm < 300) return 'intermediate';
  return 'deep';
}

// ---------------------------------------------------------------------------
// Magnitude → size
// ---------------------------------------------------------------------------

// Must match the lowest floor the UI offers, or every event below it clamps
// to the same size and the encoding goes dead across that range. This was
// 2.5 while that was the display floor; the M1 selector exposed the bug.
const MIN_MAGNITUDE = 1;
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
