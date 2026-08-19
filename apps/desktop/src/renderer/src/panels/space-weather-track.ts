import {
  FAST_WIND_THRESHOLD,
  KP_MAX,
  KP_STORM_THRESHOLD,
  WIND_SPEED_MAX,
  XRAY_EMPHASIS_FLUX,
  XRAY_FLUX_MAX,
  XRAY_FLUX_MIN,
  type SpaceWeatherBucket,
  type SpaceWeatherSample,
} from '@terra-pulse/schema';

/**
 * Geometry for the Kp/Dst track — pure, so it can be tested without a DOM.
 *
 * Same convention as `event-list-window.ts`: the arithmetic that decides what
 * appears where lives apart from the component that draws it.
 */

/** One drawn interval. `x` and `width` are fractions of the track, 0-1. */
export interface TrackBar {
  x: number;
  width: number;
  /** 0-1 up the track — the level the interval mostly sat at. */
  typicalHeight: number;
  /** 0-1 up the track — its worst hour. Always >= `typicalHeight`. */
  peakHeight: number;
  /** The interval's worst hour crossed the row's emphasis threshold. */
  peakStormy: boolean;
  /** It *sat* above it, which is a different and rarer claim. */
  typicalStormy: boolean;
  timeUtc: string;
  /** The row's own quantity, unscaled, for the readout. */
  typical: number | null;
  peak: number | null;
  /** The row's second quantity — Dst on the geomagnetic row, Bz on the wind. */
  secondary: number | null;
  hours: number;
  /** Hours in the interval that carried a measurement of this row's quantity. */
  measuredHours: number;
  /**
   * Nothing was measured here, so the empty slot is an **absence, not a zero**.
   *
   * Drawn as a baseline mark rather than left blank: a bucket with no bar and a
   * bucket whose value was genuinely low look identical otherwise, and the
   * places this happens are the least ordinary hours in the record — ACE goes
   * blind during the biggest storms, and no spacecraft sat at L1 at all from
   * 1985 to 1994.
   */
  unmeasured: boolean;
}

/**
 * What one row of the track plots.
 *
 * The two rows are the same machinery with different fields: a bounded primary
 * quantity sizing the bars, a secondary one that only marks them, and a
 * threshold where the mark turns emphatic. Keeping it parameterised rather than
 * duplicating the layout means a change to how gaps or hover behave cannot
 * apply to one row and not the other.
 */
export interface TrackSpec {
  typicalOf: (bucket: SpaceWeatherBucket) => number | null;
  peakOf: (bucket: SpaceWeatherBucket) => number | null;
  secondaryOf: (bucket: SpaceWeatherBucket) => number | null;
  /** Full height of the row. Fixed, never fitted to the window. */
  scaleMax: number;
  /**
   * When present, the row is **log-scaled** between this and `scaleMax`
   * instead of linear from zero — X-ray flux is the one quantity here that
   * needs it, spanning nine decades from background to the largest flares.
   * Kp and wind speed leave this unset and stay linear, exactly as before.
   */
  scaleMin?: number;
  /** At or above this, the mark takes the emphasis colour. */
  emphasisAt: number;
  /** How many of the interval's hours carried this row's quantity. */
  measuredHoursOf: (bucket: SpaceWeatherBucket) => number;
}

/** Kp sized 0-9, marked by Dst. */
export const GEOMAGNETIC_SPEC: TrackSpec = {
  typicalOf: (b) => b.typicalKp,
  peakOf: (b) => b.peakKp,
  secondaryOf: (b) => b.peakDst,
  scaleMax: KP_MAX,
  emphasisAt: KP_STORM_THRESHOLD,
  measuredHoursOf: (b) => b.kpHours,
};

/** Wind speed sized 0-1000 km/s, marked by the most southward Bz. */
export const SOLAR_WIND_SPEC: TrackSpec = {
  typicalOf: (b) => b.typicalWindSpeed,
  peakOf: (b) => b.peakWindSpeed,
  secondaryOf: (b) => b.peakBzGsm,
  scaleMax: WIND_SPEED_MAX,
  emphasisAt: FAST_WIND_THRESHOLD,
  measuredHoursOf: (b) => b.windSpeedHours,
};

/**
 * X-ray flux, log-scaled 1e-9 to 1e-3 W/m² — the only row here with no
 * secondary quantity, since nothing else rides the same hour that flux would
 * meaningfully annotate the way Dst marks Kp and Bz marks wind speed.
 */
export const XRAY_SPEC: TrackSpec = {
  typicalOf: (b) => b.typicalXrayFlux,
  peakOf: (b) => b.peakXrayFlux,
  secondaryOf: () => null,
  scaleMax: XRAY_FLUX_MAX,
  scaleMin: XRAY_FLUX_MIN,
  emphasisAt: XRAY_EMPHASIS_FLUX,
  measuredHoursOf: (b) => b.xrayFluxHours,
};

/**
 * Lays buckets out across a fixed window.
 *
 * Positions come from each bucket's **own timestamp against the window**, not
 * from its index in the array. Gaps in the record are common — OMNI has them,
 * and a partial backfill has whole missing years — and index-based spacing
 * would silently close those gaps, drawing a continuous record that does not
 * exist. A missing year has to *look* missing.
 *
 * ## Two heights, because either alone lies at width
 *
 * The bar is the **typical** level and the cap is the **peak**. Drawing only
 * the peak — which is what this did before — makes a decade of quiet years with
 * one storm each look identical to a decade of continuous disturbance, since
 * every bucket reports its worst hour. Drawing only the typical loses the
 * storms, which are the subject.
 *
 * The gap between bar and cap is therefore the interval's variability, read
 * directly. At short windows a bucket is a single hour, the two coincide, and
 * the track degenerates to exactly what it drew before.
 */
export function layoutTrack(
  buckets: readonly SpaceWeatherBucket[],
  startMs: number,
  endMs: number,
  barWidth: number,
  spec: TrackSpec = GEOMAGNETIC_SPEC,
): TrackBar[] {
  const span = endMs - startMs;
  if (span <= 0) return [];

  const bars: TrackBar[] = [];

  for (const bucket of buckets) {
    const timeMs = Date.parse(bucket.timeUtc);
    if (!Number.isFinite(timeMs)) continue;
    if (timeMs < startMs || timeMs > endMs) continue;

    // The primary quantity drives both heights, against a fixed scale that
    // makes a bar mean the same thing in every view. The secondary one marks
    // rather than sizes, because neither Dst nor Bz is bounded the way Kp and
    // speed are — a single -589 nT hour would flatten every other bar in the
    // record, and that hour is exactly what you want to see in context.
    const typical = spec.typicalOf(bucket);
    const peak = spec.peakOf(bucket);
    const measuredHours = spec.measuredHoursOf(bucket);

    bars.push({
      x: (timeMs - startMs) / span,
      width: barWidth,
      typicalHeight: heightOf(typical, spec.scaleMax, spec.scaleMin),
      peakHeight: heightOf(peak, spec.scaleMax, spec.scaleMin),
      peakStormy: peak !== null && peak >= spec.emphasisAt,
      typicalStormy: typical !== null && typical >= spec.emphasisAt,
      timeUtc: bucket.timeUtc,
      typical,
      peak,
      secondary: spec.secondaryOf(bucket),
      hours: bucket.hours,
      measuredHours,
      unmeasured: measuredHours === 0,
    });
  }

  return bars;
}

/**
 * Clamped at the top, which is a deliberate loss.
 *
 * `WIND_SPEED_MAX` clips 0.035% of measured hours — about one in 2,900 — to
 * keep the ordinary range across most of the row rather than a third of it.
 * Kp cannot clip: 9 is the top of the scale by definition.
 *
 * With `scaleMin` given, the height is **log-scaled** between it and
 * `scaleMax` instead of linear from zero — X-ray flux needs this (it spans
 * nine decades) and Kp/wind speed don't (`scaleMin` is `undefined` for both,
 * so they take the exact linear path this always used). A non-positive value
 * has no logarithm and heights below `scaleMin` clamp to 0 rather than going
 * negative, the same direction `scaleMax` already clips at the top.
 */
export function heightOf(value: number | null, scaleMax: number, scaleMin?: number): number {
  if (value === null) return 0;
  if (scaleMin === undefined) return Math.min(value / scaleMax, 1);
  if (value <= 0) return 0;
  const t = (Math.log10(value) - Math.log10(scaleMin)) / (Math.log10(scaleMax) - Math.log10(scaleMin));
  return Math.min(Math.max(t, 0), 1);
}

/**
 * What fraction of the drawn window this row actually measured, 0-1.
 *
 * Reported beside the row's peak whenever it is not essentially complete,
 * because a peak drawn from a third of the hours is a different claim from one
 * drawn from all of them — and nothing else on screen distinguishes them.
 *
 * Returns 1 for an empty row so a window with no buckets at all reads through
 * the "not measured" caption rather than as "0% measured", which would imply
 * the row had looked and found nothing.
 */
export function measuredFraction(bars: readonly TrackBar[]): number {
  let hours = 0;
  let measured = 0;
  for (const bar of bars) {
    hours += bar.hours;
    measured += bar.measuredHours;
  }
  return hours === 0 ? 1 : measured / hours;
}

/**
 * Below this, the row says how much of the window it saw.
 *
 * Not 100%: OMNI carries scattered single-hour dropouts even in its best years,
 * and a caption reading "99% measured" on every view would be noise that stops
 * being read — which would cost it exactly when it matters.
 */
export const COVERAGE_CAPTION_BELOW = 0.95;

/**
 * How many buckets to downsample into for a given pixel width.
 *
 * One bucket per three pixels: a 2px mark with a 1px gap, so adjacent intervals
 * read as separate rather than as one continuous block. It was one per two —
 * touching — which was survivable when a bar was a solid column and is not now
 * that each carries a peak cap, since neighbouring caps would merge into a line
 * that looks like a plotted series.
 */
export function bucketsForWidth(pixelWidth: number): number {
  return Math.max(1, Math.floor(pixelWidth / 3));
}

/**
 * The most disturbed value of each quantity in view, for the row captions.
 *
 * "Most disturbed" is not the same direction for all four: Kp and speed go up,
 * Dst and Bz go down. Taking the maximum of the latter two would report the
 * calmest hour of the window as its headline.
 */
export function peakOf(samples: readonly SpaceWeatherSample[]): {
  kp: number | null;
  dst: number | null;
  windSpeed: number | null;
  bzGsm: number | null;
  xrayFlux: number | null;
} {
  let kp: number | null = null;
  let dst: number | null = null;
  let windSpeed: number | null = null;
  let bzGsm: number | null = null;
  let xrayFlux: number | null = null;

  for (const sample of samples) {
    if (sample.kp !== null && (kp === null || sample.kp > kp)) kp = sample.kp;
    if (sample.dst !== null && (dst === null || sample.dst < dst)) dst = sample.dst;
    if (sample.windSpeed !== null && (windSpeed === null || sample.windSpeed > windSpeed)) {
      windSpeed = sample.windSpeed;
    }
    if (sample.bzGsm !== null && (bzGsm === null || sample.bzGsm < bzGsm)) bzGsm = sample.bzGsm;
    if (sample.xrayFlux !== null && (xrayFlux === null || sample.xrayFlux > xrayFlux)) {
      xrayFlux = sample.xrayFlux;
    }
  }

  return { kp, dst, windSpeed, bzGsm, xrayFlux };
}

/**
 * A raw flux value as NOAA's own flare-class notation — "M1.2", "C4.5" — the
 * form every space-weather source uses instead of scientific notation.
 *
 * Each letter is exactly one decade of the 0.1-0.8 nm flux this row plots:
 * A ≥ 1e-8, B ≥ 1e-7, C ≥ 1e-6, M ≥ 1e-5, X ≥ 1e-4 W/m². The magnitude after
 * the letter is the flux divided by its decade's own floor, so "M1.2" means
 * 1.2e-5 exactly the way DONKI's own `classType` field does — this is the
 * inverse of `parseFlareClass` in `packages/ingest/src/nasa-donki.ts`, for a
 * continuous flux reading rather than a published class string.
 */
export function fluxToClassLabel(flux: number): string {
  if (!Number.isFinite(flux) || flux <= 0) return '—';

  const classes: readonly [string, number][] = [
    ['X', 1e-4],
    ['M', 1e-5],
    ['C', 1e-6],
    ['B', 1e-7],
    ['A', 1e-8],
  ];
  for (const [letter, floor] of classes) {
    if (flux >= floor) return `${letter}${(flux / floor).toFixed(1)}`;
  }
  // Below A-class — background level, which still has a well-defined
  // magnitude on the same A-decade rather than nothing to show at all.
  return `<A${(flux / 1e-8).toFixed(1)}`;
}

/* ------------------------------------------------------------------ ticks */

/** One labelled position on the time axis. `x` is a fraction of the track. */
export interface TrackTick {
  x: number;
  label: string;
  timeUtc: string;
  /**
   * Where the label sits relative to its tick.
   *
   * Centred everywhere except the two ends, where a centred label overhangs the
   * track — measured at up to 9px on the 30-day window, which would put it under
   * the panel edge. The ends anchor inward instead, which is the ordinary
   * treatment for a first and last axis label.
   */
  anchor: 'start' | 'middle' | 'end';
}

/**
 * The ladder of tick intervals, coarsest last.
 *
 * Calendar units rather than fixed durations above the day, because "every 3
 * months" has to mean January/April/July/October and not "every 91.3 days"
 * drifting off the month boundaries. The window this serves runs from 72 hours
 * to 130 years, which is why the ladder is this long.
 */
type TickUnit = 'hour' | 'day' | 'month' | 'year';
interface TickStep {
  unit: TickUnit;
  every: number;
}

const TICK_STEPS: readonly TickStep[] = [
  { unit: 'hour', every: 1 },
  { unit: 'hour', every: 3 },
  { unit: 'hour', every: 6 },
  { unit: 'hour', every: 12 },
  { unit: 'day', every: 1 },
  { unit: 'day', every: 2 },
  // 3 exists because without it the ladder jumps 2 -> 7, and a seven-day window
  // on a narrow track then lands on a single tick: 7/2 overshoots a 3-tick
  // budget, so the next rung has to be one that fits inside a week.
  { unit: 'day', every: 3 },
  { unit: 'day', every: 7 },
  { unit: 'day', every: 14 },
  { unit: 'month', every: 1 },
  { unit: 'month', every: 3 },
  { unit: 'month', every: 6 },
  { unit: 'year', every: 1 },
  { unit: 'year', every: 2 },
  { unit: 'year', every: 5 },
  { unit: 'year', every: 10 },
  { unit: 'year', every: 20 },
  { unit: 'year', every: 50 },
];

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Averages, used only to *choose* a step — never to place one. */
const MONTH_MS = 30.44 * DAY_MS;
const YEAR_MS = 365.25 * DAY_MS;

function approximateMs(step: TickStep): number {
  switch (step.unit) {
    case 'hour':
      return step.every * HOUR_MS;
    case 'day':
      return step.every * DAY_MS;
    case 'month':
      return step.every * MONTH_MS;
    case 'year':
      return step.every * YEAR_MS;
  }
}

/** Short month names, fixed rather than locale-derived so tests are stable. */
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Labelled ticks for the window, at round calendar boundaries.
 *
 * Without these the track has no time axis at all — a spike is visibly *there*
 * but there is nothing to say when "there" is, which over a 130-year window
 * makes the whole track unreadable.
 *
 * Ticks land on round boundaries (a midnight, the 1st of a month, Jan 1 of a
 * round year) rather than at even divisions of the window, because a label
 * reading `1994` is worth more than one reading `12 Mar 1994 04:17`. The
 * consequence is that the first tick is rarely at x = 0 and the count varies as
 * the window slides — which is correct: the axis describes the calendar, not
 * the viewport.
 */
export function trackTicks(startMs: number, endMs: number, maxTicks: number): TrackTick[] {
  const span = endMs - startMs;
  if (span <= 0 || maxTicks < 1) return [];

  const step =
    TICK_STEPS.find((candidate) => span / approximateMs(candidate) <= maxTicks) ??
    TICK_STEPS[TICK_STEPS.length - 1]!;

  const ticks: TrackTick[] = [];
  // A hard cap: a pathological window must not spin here even if the ladder
  // runs out of coarseness.
  const limit = Math.max(maxTicks * 4, 8);

  for (let at = firstBoundary(startMs, step); at <= endMs; at = advance(at, step)) {
    const x = (at - startMs) / span;
    ticks.push({
      x,
      label: labelFor(at, step.unit),
      timeUtc: new Date(at).toISOString(),
      // The thresholds are a fraction rather than a measured text width, which
      // the geometry cannot know. 0.04 of a 320px track is 13px — comfortably
      // more than the 9px worst-case overhang this exists to prevent.
      anchor: x < 0.04 ? 'start' : x > 0.96 ? 'end' : 'middle',
    });
    if (ticks.length >= limit) break;
  }

  return ticks;
}

/** The first boundary of this step at or after `fromMs`. */
function firstBoundary(fromMs: number, step: TickStep): number {
  const date = new Date(fromMs);

  if (step.unit === 'hour') {
    const aligned = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      Math.floor(date.getUTCHours() / step.every) * step.every,
    );
    return aligned >= fromMs ? aligned : aligned + step.every * HOUR_MS;
  }

  if (step.unit === 'day') {
    const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    return midnight >= fromMs ? midnight : midnight + DAY_MS;
  }

  if (step.unit === 'month') {
    const month = Math.floor(date.getUTCMonth() / step.every) * step.every;
    const aligned = Date.UTC(date.getUTCFullYear(), month, 1);
    return aligned >= fromMs ? aligned : Date.UTC(date.getUTCFullYear(), month + step.every, 1);
  }

  const year = Math.floor(date.getUTCFullYear() / step.every) * step.every;
  const aligned = Date.UTC(year, 0, 1);
  return aligned >= fromMs ? aligned : Date.UTC(year + step.every, 0, 1);
}

/** One step on, in calendar terms rather than by adding a duration. */
function advance(fromMs: number, step: TickStep): number {
  const date = new Date(fromMs);

  switch (step.unit) {
    case 'hour':
      return fromMs + step.every * HOUR_MS;
    case 'day':
      return fromMs + step.every * DAY_MS;
    case 'month':
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + step.every, 1);
    case 'year':
      return Date.UTC(date.getUTCFullYear() + step.every, 0, 1);
  }
}

/**
 * The shortest label that still identifies the instant at this zoom.
 *
 * One unit of context, never a full timestamp: at year spacing the month is
 * noise, and at hour spacing the year is. The scrubber beside this already
 * states the exact playhead time for anyone who needs it.
 *
 * **Midnight on an hour axis names the day instead of reading `00:00`.** A
 * 48-hour window drew `12:00 00:00 12:00 00:00` — two identical labels with
 * nothing to say which day either belonged to, which is worse than no axis
 * because it looks like it answered. The day boundary is the one tick in an
 * hour-stepped axis that carries different information from its neighbours, so
 * it gets the coarser label.
 */
function labelFor(atMs: number, unit: TickUnit): string {
  const date = new Date(atMs);

  switch (unit) {
    case 'hour':
      if (date.getUTCHours() === 0) return labelFor(atMs, 'day');
      return `${String(date.getUTCHours()).padStart(2, '0')}:00`;
    case 'day':
      return `${String(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] ?? ''}`;
    case 'month':
      return `${MONTHS[date.getUTCMonth()] ?? ''} ${String(date.getUTCFullYear())}`;
    case 'year':
      return String(date.getUTCFullYear());
  }
}

/** About one tick per 90px — closer than that and the labels collide. */
export function ticksForWidth(pixelWidth: number): number {
  return Math.max(2, Math.floor(pixelWidth / 90));
}

/* ------------------------------------------------------------------ hover */

/**
 * The bar nearest a pointer position, given as a fraction of the track.
 *
 * A nearest-x lookup rather than per-bar hit testing, because a bar is 2px wide
 * and there are a couple of hundred of them: requiring the pointer to land on
 * one would make most of the track dead. The reader aims at a *time* and the
 * column under the pointer answers — the same reason a crosshair exists on a
 * dense line chart.
 *
 * Structurally typed on just `x`/`width` rather than the full `TrackBar`, so
 * the earthquake row's `EarthquakeBar` — a different shape, laid out by
 * `earthquake-track.ts` rather than this module — can use the same lookup
 * instead of a duplicate. Every row resolves its *own* nearest bar from a
 * shared fraction this way; sharing one row's resolved *index* across rows
 * of different lengths was the actual bug this replaced (found in the
 * field: `downsampleSpaceWeather` caps its output at
 * `Math.min(bucketCount, samples.length)`, so a live window with fewer
 * hourly samples than the pixel-derived bucket count leaves the
 * space-weather rows shorter than the earthquake row, which always makes
 * exactly `bucketCount`).
 *
 * Returns -1 when there is nothing to point at.
 */
export function nearestBarIndex(
  bars: readonly { x: number; width: number }[],
  fraction: number,
): number {
  let best = -1;
  let bestDistance = Infinity;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (!bar) continue;
    // Measured to the bar's middle, so the boundary between two bars falls
    // halfway between them rather than at one's leading edge.
    const distance = Math.abs(bar.x + bar.width / 2 - fraction);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }

  return best;
}
