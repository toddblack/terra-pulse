import type { QuakeReplay, ReplayArrival, ReplayMagnitudeStep, ReplayPick } from '@terra-pulse/schema';
import type { ChannelBuffer } from './waveform-buffer';

/**
 * Playing a quake replay back: pure, so the clock, what has "arrived" and what
 * the detector knew at each instant are all tests rather than effects.
 *
 * **The replay's clock is arrival time.** Main computed when every record would
 * have reached us live; a row shows a record only once the playhead passes
 * that instant, and a pick only once the record carrying it has arrived. That
 * is the whole honesty of the replay — the same rule the graded script applies
 * — so the waiting you watch is the waiting live would have done.
 */

export const REPLAY_SPEEDS = [1, 2, 5] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export interface Playback {
  playing: boolean;
  speed: ReplaySpeed;
  /** The replay's "now": an instant inside the replayed window. */
  positionMs: number;
}

/** Real time from the window's start — the waiting is what is being shown. */
export function startPlayback(replay: Pick<QuakeReplay, 'windowStartMs'>): Playback {
  return { playing: true, speed: 1, positionMs: replay.windowStartMs };
}

/** Moves the clock on by `dtMs` of wall time, stopping at the end of the window. */
export function advance(playback: Playback, dtMs: number, endMs: number): Playback {
  if (!playback.playing || dtMs <= 0) return playback;
  const positionMs = Math.min(endMs, playback.positionMs + dtMs * playback.speed);
  return { ...playback, positionMs, playing: positionMs < endMs };
}

/**
 * Whether the clock crossed `atMs` moving forward. The alert sound plays on
 * this and on nothing else: never on a backward scrub, and again if the reader
 * goes back and plays through it — the crossing re-arms itself.
 */
export function crossedForward(previousMs: number, nextMs: number, atMs: number): boolean {
  return previousMs < atMs && nextMs >= atMs;
}

/** How many arrivals have landed by `positionMs`. Arrivals are in arrival order. */
export function arrivedCount(arrivals: readonly { arrivedAtMs: number }[], positionMs: number): number {
  let lo = 0;
  let hi = arrivals.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((arrivals[mid]?.arrivedAtMs ?? Infinity) <= positionMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Each row's buffer from the first `count` arrivals. Sorted by start time per
 * channel, as `ChannelBuffer` requires — arrival order and start order agree
 * within a channel almost always, but "almost" is not a property to build on.
 */
export function buffersFromArrivals(arrivals: readonly ReplayArrival[], count: number): Map<string, ChannelBuffer> {
  const byChannel = new Map<string, ReplayArrival['segment'][]>();
  for (let i = 0; i < count; i += 1) {
    const arrival = arrivals[i];
    if (arrival === undefined) break;
    const list = byChannel.get(arrival.segment.channelId) ?? [];
    list.push(arrival.segment);
    byChannel.set(arrival.segment.channelId, list);
  }
  const buffers = new Map<string, ChannelBuffer>();
  for (const [channelId, segments] of byChannel) {
    segments.sort((a, b) => a.startTimeMs - b.startTimeMs);
    buffers.set(channelId, { segments, droppedOverlapping: 0, droppedDuplicate: 0 });
  }
  return buffers;
}

/** The detector's magnitude as it stood at `positionMs`, or null before it had one. */
export function magnitudeAt(steps: readonly ReplayMagnitudeStep[], positionMs: number): ReplayMagnitudeStep | null {
  let found: ReplayMagnitudeStep | null = null;
  for (const step of steps) {
    if (step.atMs > positionMs) break;
    found = step;
  }
  return found;
}

/** Pick onsets known by `positionMs`, by channel. */
export function knownPicks(picks: readonly ReplayPick[], positionMs: number): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const pick of picks) {
    if (pick.arrivedAtMs > positionMs) continue;
    const list = out.get(pick.channelId) ?? [];
    list.push(pick.timeMs);
    out.set(pick.channelId, list);
  }
  return out;
}

/**
 * How far along the surface a wavefront has travelled, km — or null before it
 * reaches the surface at all.
 *
 * The wave leaves a source at depth, so the surface radius is the horizontal
 * leg of a triangle whose long side is `v·t`: √((v·t)² − depth²). The same
 * fixed depth and single velocity the detector assumes, so the ring the reader
 * watches is the one the detector's own timing is built on — including its
 * simplifications, which the replay guide states.
 */
export function wavefrontRadiusKm(elapsedMs: number, velocityKmS: number, depthKm: number): number | null {
  if (elapsedMs <= 0) return null;
  const travelledKm = (velocityKmS * elapsedMs) / 1000;
  if (travelledKm <= depthKm) return null;
  return Math.sqrt(travelledKm ** 2 - depthKm ** 2);
}

/**
 * A circle of `radiusKm` around a point, as `[longitude, latitude]` pairs on
 * the sphere — what a ring on the globe is drawn through. Closed: the last
 * point repeats the first.
 */
export function circlePoints(
  centre: { latitude: number; longitude: number },
  radiusKm: number,
  steps = 72,
): [number, number][] {
  const toRad = Math.PI / 180;
  const angular = radiusKm / 6371;
  const lat1 = centre.latitude * toRad;
  const lon1 = centre.longitude * toRad;
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const bearing = (i / steps) * 2 * Math.PI;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing));
    const lon2 =
      lon1 +
      Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
    out.push([((((lon2 / toRad + 540) % 360) + 360) % 360) - 180, lat2 / toRad]);
  }
  return out;
}

/** "+12.3 s" near the origin; "+11:32" once minutes matter (a distant quake). */
export function formatSinceOrigin(ms: number): string {
  const sign = ms < 0 ? '−' : '+';
  const abs = Math.abs(ms) / 1000;
  if (abs < 600) return `${sign}${abs.toFixed(1)} s`;
  const minutes = Math.floor(abs / 60);
  const seconds = Math.floor(abs % 60);
  return `${sign}${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}
