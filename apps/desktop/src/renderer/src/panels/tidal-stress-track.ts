import { resolvedShearPa } from '../layers/tidal-stress';
import { tidalBodies } from '../layers/tides';

/**
 * Lunisolar tidal shear stress on one fault plane, over the visible window —
 * §5.5's fifth row.
 *
 * Pure, like `space-weather-track.ts` and `earthquake-track.ts` beside it. The
 * physics is `tidal-stress.ts`'s (itself a port of H6's `tides.py`); this
 * module only decides *when* to evaluate it and how the result maps onto the
 * shared time axis.
 *
 * ## Why this is neither a `TrackSpec` nor an `EarthquakeBar`
 *
 * `layoutTrack` buckets a *measured* hourly stream and reports a median and a
 * peak per bucket, because Kp and wind speed are sampled on a clock and can be
 * missing. `layoutEarthquakeTrack` bins irregular point events. This is neither:
 * tidal stress is a **continuous analytic function** that can be evaluated at
 * any instant and is never absent, so there is no median/peak pair to draw, no
 * "unmeasured" state to distinguish from a real zero, and no reason to tie the
 * sample count to the pixel width. It is a curve, and it is drawn as one.
 *
 * ## The row plots the SIGNED value, unlike `TidalShear.tsx`'s readout
 *
 * That panel shows a magnitude because the *sign* of a single instant is not
 * trustworthy: `faultStrikeDeg` derives strike from a mapped trace's arbitrary
 * digitisation order, which may or may not match the Aki & Richards sense GEM's
 * own dip and rake were measured against.
 *
 * That ambiguity is **one constant sign per fault, not a per-instant error**.
 * So the waveform's *shape* is correct either way and only its polarity label is
 * unknown — which is exactly what a time series needs and a single number does
 * not. Taking `Math.abs()` here would fold the negative half of every cycle
 * upward and draw a semidiurnal tide at twice its real frequency, inventing a
 * signal rather than hedging one. The guide says the polarity is unresolved
 * instead; see `TIDAL_SHEAR_MAX_PA` for the scale that shape is drawn against.
 */

/** A fault's geometry, already resolved — this module never sees a `FaultRecord`. */
export interface FaultPlane {
  latitudeDeg: number;
  longitudeDeg: number;
  /** Degrees clockwise from north, from the trace — see `faultStrikeDeg`. */
  strikeDeg: number;
  dipDeg: number;
  rakeDeg: number;
}

/**
 * The M2 principal lunar semidiurnal period, hours — the fastest component
 * carrying most of the amplitude, and therefore what has to be resolved.
 */
export const TIDAL_PERIOD_HOURS = 12.42;

/**
 * Full-scale shear, Pa, at each end of the signed row.
 *
 * **Measured, not assumed**, over 400 real GEM faults carrying dip and rake,
 * sampled hourly across a full synodic month (288,000 evaluations): |τ| runs
 * p50 265, p90 673, p99 1,155 Pa, with an observed maximum of 1,662. A ceiling
 * of 1,500 Pa clips **0.065%** of samples — about one in 1,500 — which is the
 * same trade `WIND_SPEED_MAX` makes for the same reason: a ceiling of 1,700
 * clips nothing and spends a good fraction of the row on values that never
 * occur, while 1,000 would look tidier and clip 2.34%.
 *
 * **Fixed across faults and across windows, deliberately.** Rescaling per fault
 * would make a weakly-stressed trace look identical to the most strongly
 * stressed one; rescaling per window would flatten the spring/neap cycle, which
 * is the slowest structure this row exists to show — measured at a **2.4×**
 * swing in daily peak across one month (1,662 Pa down to 685 and back). That is
 * the same mistake `field-encoding.ts` records for declination and the tide
 * layer records for its own domain: set a domain from the distribution, never
 * from the definition, and never renormalise it per frame.
 */
export const TIDAL_SHEAR_MAX_PA = 1500;

/**
 * Longest window this row will draw across, hours (30 days).
 *
 * **The limit is legibility, not arithmetic.** One lunar month is ~58 tidal
 * cycles, so even on a wide track that is roughly 8–15 px per cycle — about
 * where a waveform stops being a waveform and becomes a filled band. Past it
 * the curve would still be *computed* correctly and would read as noise, which
 * is worse than not drawing: the row would look like data.
 *
 * 30 days is also exactly one spring/neap cycle, so it is the longest span over
 * which the row's slowest real structure completes once rather than repeating
 * into a texture.
 *
 * The globe's own windows reach 130 years. At that span 300 buckets would put
 * 158 days between samples — over 300 tidal cycles apart — and alias into a
 * curve that moves convincingly and means nothing at all.
 */
export const TIDAL_TRACK_MAX_WINDOW_HOURS = 30 * 24;

/**
 * Sample spacing target and hard cap on point count.
 *
 * Deliberately independent of the pixel width every other row buckets by: the
 * fidelity a curve needs is set by the period it has to resolve, not by how
 * wide the panel happens to be. At the 30-day maximum the cap binds and gives
 * 36-minute spacing — ~20 samples per tidal cycle, comfortably past Nyquist.
 * Each evaluation is ~1.7 µs (measured), so the worst case is ~2 ms.
 */
export const TIDAL_SAMPLE_MINUTES = 20;
export const TIDAL_TRACK_MAX_POINTS = 1200;

export interface TidalStressPoint {
  /** Fraction of the track, 0-1 — the same coordinate space every other row uses. */
  x: number;
  /** Signed resolved shear, Pa. Positive encourages slip *if* the strike sense is right. */
  shearPa: number;
  timeMs: number;
}

export interface TidalStressSeries {
  points: TidalStressPoint[];
  /** Largest |shear| in the window, Pa — 0 when nothing was sampled. */
  peakPa: number;
  /**
   * The window is longer than `TIDAL_TRACK_MAX_WINDOW_HOURS`, so nothing was
   * sampled. Reported rather than silently returning an empty series, because
   * "no fault selected" and "this window cannot show a tide" are different
   * things the row has to say differently.
   */
  tooLong: boolean;
}

const EMPTY: TidalStressSeries = { points: [], peakPa: 0, tooLong: false };

/** How many points to evaluate across a span, honouring both the target and the cap. */
export function samplePointCount(spanMs: number): number {
  const target = Math.ceil(spanMs / (TIDAL_SAMPLE_MINUTES * 60_000));
  return Math.min(TIDAL_TRACK_MAX_POINTS, Math.max(2, target));
}

/**
 * Evaluates the resolved shear across `[startMs, endMs]`.
 *
 * Inclusive of both ends, unlike this app's half-open time windows elsewhere: a
 * curve is defined at its endpoints and clipping the last one would leave the
 * line stopping short of the right edge by one sample.
 */
export function sampleTidalStress(
  plane: FaultPlane,
  startMs: number,
  endMs: number,
): TidalStressSeries {
  const spanMs = endMs - startMs;
  if (spanMs <= 0) return EMPTY;
  if (spanMs > TIDAL_TRACK_MAX_WINDOW_HOURS * 3_600_000) {
    return { points: [], peakPa: 0, tooLong: true };
  }

  const count = samplePointCount(spanMs);
  const points: TidalStressPoint[] = [];
  let peakPa = 0;

  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    const timeMs = startMs + t * spanMs;
    const shearPa = resolvedShearPa(
      tidalBodies(new Date(timeMs)),
      plane.latitudeDeg,
      plane.longitudeDeg,
      plane.strikeDeg,
      plane.dipDeg,
      plane.rakeDeg,
    );
    points.push({ x: t, shearPa, timeMs });
    const abs = Math.abs(shearPa);
    if (abs > peakPa) peakPa = abs;
  }

  return { points, peakPa, tooLong: false };
}

/**
 * Where a signed shear sits up the row, 0-1, with **0.5 at zero stress**.
 *
 * Clamped at both ends rather than allowed to overflow: 0.065% of real samples
 * exceed the scale, and a line escaping its own plot would overlap the row above.
 */
export function shearHeight(shearPa: number): number {
  const clamped = Math.max(-1, Math.min(1, shearPa / TIDAL_SHEAR_MAX_PA));
  return 0.5 + clamped * 0.5;
}

/**
 * The point nearest a fraction of the track, or -1 when there are none.
 *
 * Mirrors `nearestBarIndex`: the reader aims at a *time*, and requiring the
 * pointer to land on one of up to 1,200 sample positions would leave the row
 * effectively dead to hover.
 */
export function nearestPointIndex(
  points: readonly TidalStressPoint[],
  fraction: number,
): number {
  if (points.length === 0) return -1;
  // Points are evenly spaced over [0,1], so the index follows directly rather
  // than needing a scan.
  const index = Math.round(fraction * (points.length - 1));
  return Math.max(0, Math.min(points.length - 1, index));
}

/**
 * The curve as an SVG polyline `points` attribute, in a 0-100 × 0-100 viewBox.
 *
 * Y is flipped here (`100 - height * 100`) because SVG's origin is top-left
 * while `shearHeight` measures up from the bottom, the same convention every
 * other row's CSS `bottom` uses.
 */
export function polylinePoints(points: readonly TidalStressPoint[]): string {
  return points
    .map((point) => {
      const x = (point.x * 100).toFixed(3);
      const y = (100 - shearHeight(point.shearPa) * 100).toFixed(3);
      return `${x},${y}`;
    })
    .join(' ');
}
