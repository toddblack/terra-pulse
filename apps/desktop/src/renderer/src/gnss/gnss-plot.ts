import {
  GNSS_AFTER_DAYS,
  gnssQuakeDayMs,
  type GnssDailyPosition,
  type GnssStationSeries,
  type GnssStep,
  type GnssVelocity,
} from '@terra-pulse/schema';

/**
 * What the GPS window draws, as numbers. Pure, like the timeline's track
 * modules, so every rule below is tested without a DOM.
 *
 * Each component — east, north, up — is its own row with its own scale. They
 * are never drawn on one axis: up is noisier than the horizontals by about
 * three times, and on a shared scale it would set the scale for all three.
 */

const DAY_MS = 86_400_000;
const YEAR_MS = 365.25 * DAY_MS;

export type GnssComponent = 'east' | 'north' | 'up';

export const GNSS_COMPONENTS: readonly {
  id: GnssComponent;
  label: string;
  /** The smallest span the scale may show, mm — see `fitDomain`. */
  minSpanMm: number;
}[] = [
  { id: 'east', label: 'East', minSpanMm: 4 },
  { id: 'north', label: 'North', minSpanMm: 4 },
  { id: 'up', label: 'Up', minSpanMm: 12 },
];

function positionOf(position: GnssDailyPosition, component: GnssComponent): number {
  return component === 'east' ? position.eastM : component === 'north' ? position.northM : position.upM;
}

function velocityOf(velocity: GnssVelocity, component: GnssComponent): number {
  return component === 'east'
    ? velocity.eastMPerYr
    : component === 'north'
      ? velocity.northMPerYr
      : velocity.upMPerYr;
}

/** One plotted day: millimetres from where the station was the week before. */
export interface PlotSample {
  dayMs: number;
  /** The middle of the day, where the point is drawn: a daily solution averages the whole day. */
  atMs: number;
  mm: number;
  /** Before, on, or after the quake's own day. The quake's day is a mix of both. */
  side: 'before' | 'quake-day' | 'after';
}

/**
 * How many days before the quake set the zero line.
 *
 * "Where the station was in the last week before the quake", so that each row
 * reads as movement away from that. A week rather than one day because a
 * single day's position scatters by a couple of millimetres on its own.
 */
export const BASELINE_DAYS = 7;

/**
 * One component's days for one span, in millimetres from the baseline.
 *
 * With `removeDrift`, the station's published steady velocity is taken off
 * first — measured from the quake, so the baseline week barely moves and the
 * graph shows departures from what the station always does. The velocity is
 * the lab's, fitted over the station's whole record; nothing here is fitted to
 * the window, which is what keeps something unusual inside it from being
 * absorbed into the trend that is removed.
 */
export function componentSamples(
  station: Pick<GnssStationSeries, 'positions' | 'velocity'>,
  component: GnssComponent,
  originMs: number,
  spanDays: number,
  removeDrift: boolean,
): PlotSample[] {
  const quakeDay = gnssQuakeDayMs(originMs);
  const startMs = quakeDay - spanDays * DAY_MS;
  const endMs = quakeDay + GNSS_AFTER_DAYS * DAY_MS;
  const velocity = removeDrift && station.velocity ? velocityOf(station.velocity, component) : 0;

  const values = station.positions.map((position) => {
    const atMs = position.dayMs + DAY_MS / 2;
    const metres = positionOf(position, component) - velocity * ((atMs - originMs) / YEAR_MS);
    return { position, atMs, metres };
  });

  const before = values.filter((v) => v.position.dayMs < quakeDay);
  const lastWeek = before.slice(-BASELINE_DAYS);
  if (lastWeek.length === 0) return [];
  const baseline = lastWeek.reduce((sum, v) => sum + v.metres, 0) / lastWeek.length;

  return values
    .filter((v) => v.position.dayMs >= startMs && v.position.dayMs <= endMs)
    .map((v) => ({
      dayMs: v.position.dayMs,
      atMs: v.atMs,
      mm: (v.metres - baseline) * 1000,
      side:
        v.position.dayMs < quakeDay ? 'before' : v.position.dayMs === quakeDay ? 'quake-day' : 'after',
    }));
}

/**
 * The y range, mm, **fitted to the days before the quake** — the user's
 * choice (2026-10-15).
 *
 * The point of the window is the weeks before, and the quake's own jump can be
 * hundreds of times larger: at Ridgecrest a station 20 km away moved 620 mm
 * east while its previous week varied by about 2. On one scale the "before"
 * would be a flat line. So the scale is set by the before-days alone and the
 * jump runs off the edge, with its size printed (`changeAcrossQuake`).
 *
 * `minSpanMm` keeps a very quiet station from having its scatter blown up to
 * fill the row: a span below a few millimetres would make noise look like
 * motion. Up gets a wider floor than the horizontals because its day-to-day
 * scatter is about three times theirs. Zero is always inside the range, since
 * it is the line every row is read against.
 */
export function fitDomain(samples: readonly PlotSample[], minSpanMm: number): { lo: number; hi: number } {
  let lo = 0;
  let hi = 0;
  for (const sample of samples) {
    if (sample.side !== 'before') continue;
    if (sample.mm < lo) lo = sample.mm;
    if (sample.mm > hi) hi = sample.mm;
  }
  const pad = (hi - lo) * 0.1;
  lo -= pad;
  hi += pad;
  const span = hi - lo;
  if (span < minSpanMm) {
    const grow = (minSpanMm - span) / 2;
    lo -= grow;
    hi += grow;
  }
  return { lo, hi };
}

/** How many days either side of the quake `changeAcrossQuake` compares. */
export const CHANGE_DAYS = 5;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * How far the station's position changed across the quake, mm: the median of
 * the first five days after against the median of the last five before.
 *
 * Medians, so one bad day either side cannot set the number. The quake's own
 * day is left out of both — it averages positions from before and after.
 *
 * **A change in position, not "what the quake did".** An antenna swap that
 * week, or another quake, would land in it too; the window marks both when
 * the lab knows of them.
 */
export function changeAcrossQuake(samples: readonly PlotSample[]): number | null {
  const before = samples.filter((s) => s.side === 'before').slice(-CHANGE_DAYS);
  const after = samples.filter((s) => s.side === 'after').slice(0, CHANGE_DAYS);
  if (before.length === 0 || after.length === 0) return null;
  return median(after.map((s) => s.mm)) - median(before.map((s) => s.mm));
}

/** Whether any day after the quake falls off the top or bottom of the scale. */
export function offScale(
  samples: readonly PlotSample[],
  domain: { lo: number; hi: number },
): 'above' | 'below' | null {
  let above = false;
  let below = false;
  for (const sample of samples) {
    if (sample.side === 'before') continue;
    if (sample.mm > domain.hi) above = true;
    if (sample.mm < domain.lo) below = true;
  }
  // Both at once is a station that swung past each edge; the larger excursion
  // is the one worth the arrow.
  if (above && below) {
    const max = Math.max(...samples.map((s) => s.mm));
    const min = Math.min(...samples.map((s) => s.mm));
    return max - domain.hi >= domain.lo - min ? 'above' : 'below';
  }
  return above ? 'above' : below ? 'below' : null;
}

/** The time span drawn: `spanDays` before the quake's day to the end of the 30th day after. */
export function timeExtent(originMs: number, spanDays: number): { startMs: number; endMs: number } {
  const quakeDay = gnssQuakeDayMs(originMs);
  return {
    startMs: quakeDay - spanDays * DAY_MS,
    endMs: quakeDay + (GNSS_AFTER_DAYS + 1) * DAY_MS,
  };
}

/**
 * The points joined by lines: runs of consecutive days.
 *
 * **A missing day is never bridged.** Stations drop days, and a line drawn
 * straight across a gap claims a position nobody measured — across the quake
 * itself, it would draw a gradual slide where there was a jump. Every day is
 * also drawn as a dot, so a day standing alone still shows.
 */
export function consecutiveRuns(samples: readonly PlotSample[]): PlotSample[][] {
  const runs: PlotSample[][] = [];
  let run: PlotSample[] = [];
  for (const sample of samples) {
    const previous = run.at(-1);
    if (previous && sample.dayMs - previous.dayMs !== DAY_MS) {
      runs.push(run);
      run = [];
    }
    run.push(sample);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

export interface RelativeTick {
  /** Days from the quake's day. */
  days: number;
  atMs: number;
  label: string;
}

/**
 * Axis ticks in days from the quake, which is what this graph is about — a
 * label reading "−30 d" says more here than a date does. The quake itself is
 * marked by its own line, not a tick.
 */
export function relativeTicks(originMs: number, spanDays: number): RelativeTick[] {
  const quakeDay = gnssQuakeDayMs(originMs);
  const step = spanDays <= 30 ? 10 : spanDays <= 90 ? 30 : 90;
  const after = Math.min(step, GNSS_AFTER_DAYS);
  const ticks: RelativeTick[] = [];
  for (let days = -Math.floor(spanDays / step) * step; days < 0; days += step) {
    ticks.push({ days, atMs: quakeDay + days * DAY_MS, label: `−${String(-days)} d` });
  }
  for (let days = after; days <= GNSS_AFTER_DAYS; days += after) {
    ticks.push({ days, atMs: quakeDay + days * DAY_MS, label: `+${String(days)} d` });
  }
  return ticks;
}

/**
 * The lab's known steps that fall inside the span, minus the quake itself.
 *
 * An earthquake step on the quake's own day (or the day after, for a quake
 * late in the UTC day) is this quake or its sequence, which the quake line
 * already marks. Every other step is drawn, because each is a reason the
 * position could jump that is not the ground moving here.
 */
export function visibleSteps(
  steps: readonly GnssStep[],
  originMs: number,
  spanDays: number,
): GnssStep[] {
  const quakeDay = gnssQuakeDayMs(originMs);
  const { startMs, endMs } = timeExtent(originMs, spanDays);
  const seen = new Set<string>();
  return steps.filter((step) => {
    if (step.dayMs < startMs || step.dayMs >= endMs) return false;
    if (step.kind === 'earthquake' && step.dayMs >= quakeDay && step.dayMs <= quakeDay + DAY_MS) {
      return false;
    }
    // An antenna and a receiver changed the same day are one event on a graph.
    const key = `${step.kind}:${String(step.dayMs)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The lab's step labels are identifiers (`Antenna_Type_Changed`); this is what to print. */
export function describeStep(step: GnssStep): string {
  if (step.kind === 'earthquake') {
    const magnitude = step.magnitude === null ? 'a quake' : `M${step.magnitude.toFixed(1)}`;
    // The lab measures from the station, not from the quake being looked at.
    const distance =
      step.distanceKm === null ? '' : `, ${String(Math.round(step.distanceKm))} km from the station`;
    return `${magnitude}${distance}`;
  }
  return step.detail.replace(/_/g, ' ').toLowerCase();
}

/** Millimetres, signed, at a precision that suits the size. */
export function formatMm(mm: number): string {
  const sign = mm > 0 ? '+' : mm < 0 ? '−' : '';
  const abs = Math.abs(mm);
  const text = abs >= 100 ? abs.toFixed(0) : abs >= 10 ? abs.toFixed(0) : abs.toFixed(1);
  return text === '0.0' ? '0 mm' : `${sign}${text} mm`;
}

/** The sample nearest an instant, or null. */
export function nearestSample(samples: readonly PlotSample[], atMs: number): PlotSample | null {
  let best: PlotSample | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const sample of samples) {
    const gap = Math.abs(sample.atMs - atMs);
    if (gap < bestGap) {
      best = sample;
      bestGap = gap;
    }
  }
  // Half a day either side: pointing into a gap names no day.
  return bestGap <= DAY_MS / 2 ? best : null;
}
