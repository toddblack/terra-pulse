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

/** 10× is for replays whose far rows stretch the window past ten minutes. */
export const REPLAY_SPEEDS = [1, 2, 5, 10] as const;
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

const wrapLongitude = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

/**
 * Where the camera goes for a replay: the epicentre and every row, so the rings
 * can be watched reaching the stations — which, away from dense networks, can
 * be a thousand kilometres and more apart.
 *
 * **Framed for the chrome, not the viewport.** A replay has the dock open
 * across the bottom and usually the inspector left of centre; a frame fitted to
 * the whole window put the subject behind the inspector. So it is extended west
 * and south — empty map under those panels — leaving the subject in the clear
 * upper-right of the globe.
 *
 * Longitudes are taken as offsets from the epicentre, so a replay straddling
 * the antimeridian (Fiji, the Aleutians) frames the short way across it. The
 * result can have `west > east`, which Cesium reads as crossing 180°.
 */
export function replayFrame(
  epicentre: { latitude: number; longitude: number },
  rows: readonly { latitude: number; longitude: number }[],
): { west: number; south: number; east: number; north: number } {
  const points = [epicentre, ...rows];
  const offsets = points.map((p) => wrapLongitude(p.longitude - epicentre.longitude));
  const lats = points.map((p) => p.latitude);
  const pad = 1.5;
  const minOff = Math.min(...offsets) - pad;
  const maxOff = Math.max(...offsets) + pad;
  const minLat = Math.min(...lats) - pad;
  const maxLat = Math.max(...lats) + pad;
  // Never wider than most of the planet, or the frame would wrap onto itself.
  const westOff = Math.max(maxOff - 300, minOff - (maxOff - minOff) * 0.9);
  return {
    west: wrapLongitude(epicentre.longitude + westOff),
    east: wrapLongitude(epicentre.longitude + maxOff),
    south: Math.max(-89, minLat - (maxLat - minLat) * 0.8),
    north: Math.min(89, maxLat),
  };
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
