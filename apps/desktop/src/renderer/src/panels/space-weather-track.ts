import {
  KP_MAX,
  KP_STORM_THRESHOLD,
  type SpaceWeatherSample,
} from '@terra-pulse/schema';

/**
 * Geometry for the Kp/Dst track — pure, so it can be tested without a DOM.
 *
 * Same convention as `event-list-window.ts`: the arithmetic that decides what
 * appears where lives apart from the component that draws it.
 */

/** One drawn bar. `x` and `width` are fractions of the track, 0-1. */
export interface TrackBar {
  x: number;
  width: number;
  /** 0-1 up the track. */
  height: number;
  stormy: boolean;
  timeUtc: string;
  kp: number | null;
  dst: number | null;
}

/**
 * Lays samples out across a fixed window.
 *
 * Positions come from each sample's **own timestamp against the window**, not
 * from its index in the array. Gaps in the record are common — OMNI has them,
 * and a partial backfill has whole missing years — and index-based spacing
 * would silently close those gaps, drawing a continuous record that does not
 * exist. A missing year has to *look* missing.
 */
export function layoutTrack(
  samples: readonly SpaceWeatherSample[],
  startMs: number,
  endMs: number,
  barWidth: number,
): TrackBar[] {
  const span = endMs - startMs;
  if (span <= 0) return [];

  const bars: TrackBar[] = [];

  for (const sample of samples) {
    const timeMs = Date.parse(sample.timeUtc);
    if (!Number.isFinite(timeMs)) continue;
    if (timeMs < startMs || timeMs > endMs) continue;

    // Kp drives the bar height: it is bounded 0-9, which makes a fixed scale
    // honest. Dst has no bound, so it colours rather than sizes — a single
    // -589 nT hour would otherwise flatten every other bar in the record to
    // nothing, and that hour is exactly what you want to see in context.
    const height = sample.kp === null ? 0 : Math.min(sample.kp / KP_MAX, 1);

    bars.push({
      x: (timeMs - startMs) / span,
      width: barWidth,
      height,
      stormy: sample.kp !== null && sample.kp >= KP_STORM_THRESHOLD,
      timeUtc: sample.timeUtc,
      kp: sample.kp,
      dst: sample.dst,
    });
  }

  return bars;
}

/**
 * How many buckets to downsample into for a given pixel width.
 *
 * One bucket per two pixels: a bar narrower than that cannot be seen and cannot
 * be hovered, so any finer is work whose only effect is to make the track
 * slower.
 */
export function bucketsForWidth(pixelWidth: number): number {
  return Math.max(1, Math.floor(pixelWidth / 2));
}

/** The strongest storm in view, for the track's caption. */
export function peakOf(samples: readonly SpaceWeatherSample[]): {
  kp: number | null;
  dst: number | null;
} {
  let kp: number | null = null;
  let dst: number | null = null;

  for (const sample of samples) {
    if (sample.kp !== null && (kp === null || sample.kp > kp)) kp = sample.kp;
    if (sample.dst !== null && (dst === null || sample.dst < dst)) dst = sample.dst;
  }

  return { kp, dst };
}
