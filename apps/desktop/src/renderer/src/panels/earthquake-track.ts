import type { EarthquakeEvent } from '@terra-pulse/schema';
import { EMPHASIS_MAGNITUDE_THRESHOLD } from '../layers/earthquake-encoding';

/**
 * Earthquake markers for the multi-track timeline — §5.5's third row.
 *
 * Pure, like `space-weather-track.ts` beside it: the arithmetic that decides
 * what appears where lives apart from the component that draws it.
 *
 * ## Why this doesn't reuse `layoutTrack`
 *
 * That function buckets a mostly-contiguous hourly *sample stream* — Kp and
 * wind speed are measured on a clock, so "typical vs. peak within an hour"
 * is a real statistic. An earthquake is an irregular point event: there is
 * no "typical magnitude" of a bucket the way there is a typical Kp, and
 * averaging magnitudes would repeat the exact mistake this project already
 * ruled out for Kp — both are quasi-logarithmic scales where a mean isn't a
 * physical quantity. The one meaningful number per bucket is its **largest**
 * event, so that's the only thing kept.
 *
 * ## Why bins are cut directly from the window, not from sample density
 *
 * `downsampleSpaceWeather` buckets by array index because its input is
 * (mostly) one sample per hour, so equal-index slices are close enough to
 * equal-time slices. Earthquakes cluster in time — a swarm can put a
 * thousand events in an hour and none in the surrounding week — so index
 * slicing would size bins by *event count*, not by time, and silently
 * distort the shared x-axis every other row is drawn against. Bins here are
 * cut directly from `[startMs, endMs)`, which is also what guarantees this
 * row lines up with the other two without having to replicate their scheme.
 */

export interface EarthquakeBar {
  /** Fraction of the track, 0-1 — same coordinate space `layoutTrack` uses. */
  x: number;
  width: number;
  /** Events whose time fell in this bin. */
  count: number;
  /** The bin's largest magnitude, or null if it saw nothing. */
  magnitude: number | null;
  timeUtc: string;
  /** The bin's largest event reached the app's M5.5+ "is this a big one" line. */
  emphasized: boolean;
}

/**
 * A fixed magnitude ceiling for sizing markers — the same idea as Kp's fixed
 * 0-9 scale, so a dot means the same thing in a 72-hour view and a
 * 130-year one. 9.5 clears the largest instrumentally recorded earthquake
 * (Valdivia 1960, M9.5) without ever clamping in practice.
 */
export const EARTHQUAKE_MAGNITUDE_MAX = 9.5;

/**
 * Bins events into `bucketCount` equal-time slices across the window and
 * keeps each slice's count and largest magnitude.
 *
 * Half-open like the rest of this app's time-window handling isn't quite
 * right here — the *last* bin needs to include `endMs` itself, or an event
 * exactly on the trailing edge (the playhead, in live mode) silently drops.
 * `Math.min` on the computed index folds that edge into the final bin
 * instead of discarding it.
 */
export function layoutEarthquakeTrack(
  events: readonly EarthquakeEvent[],
  startMs: number,
  endMs: number,
  bucketCount: number,
): EarthquakeBar[] {
  const span = endMs - startMs;
  if (span <= 0 || bucketCount <= 0) return [];

  const binMs = span / bucketCount;
  const counts = new Array<number>(bucketCount).fill(0);
  const magnitudes = new Array<number | null>(bucketCount).fill(null);

  for (const event of events) {
    const eventMs = Date.parse(event.timeUtc);
    if (!Number.isFinite(eventMs) || eventMs < startMs || eventMs > endMs) continue;

    const index = Math.min(bucketCount - 1, Math.floor((eventMs - startMs) / binMs));
    counts[index] = (counts[index] ?? 0) + 1;
    const current = magnitudes[index] ?? null;
    if (current === null || event.magnitude > current) magnitudes[index] = event.magnitude;
  }

  const width = 1 / bucketCount;
  const bars: EarthquakeBar[] = [];
  for (let i = 0; i < bucketCount; i += 1) {
    const magnitude = magnitudes[i] ?? null;
    bars.push({
      x: i * width,
      width,
      count: counts[i] ?? 0,
      magnitude,
      timeUtc: new Date(startMs + i * binMs).toISOString(),
      emphasized: magnitude !== null && magnitude >= EMPHASIS_MAGNITUDE_THRESHOLD,
    });
  }

  return bars;
}

/** The largest magnitude and total count across every bar, for the row's caption. */
export function peakEarthquake(bars: readonly EarthquakeBar[]): {
  magnitude: number | null;
  count: number;
} {
  let magnitude: number | null = null;
  let count = 0;
  for (const bar of bars) {
    count += bar.count;
    if (bar.magnitude !== null && (magnitude === null || bar.magnitude > magnitude)) {
      magnitude = bar.magnitude;
    }
  }
  return { magnitude, count };
}
