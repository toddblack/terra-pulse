import { describe, expect, it } from 'vitest';
import { haversineKm, type ReplayArrival, type ReplayMagnitudeStep } from '@terra-pulse/schema';
import {
  advance,
  arrivedCount,
  buffersFromArrivals,
  circlePoints,
  crossedForward,
  formatSinceOrigin,
  knownPicks,
  magnitudeAt,
  startPlayback,
  wavefrontRadiusKm,
} from './replay-playback';
import { markX } from './waveform-trace';

function arrival(channelId: string, startTimeMs: number, arrivedAtMs: number): ReplayArrival {
  return { segment: { channelId, startTimeMs, sampleRateHz: 100, samples: new Int32Array(10) }, arrivedAtMs };
}

describe('the playback clock', () => {
  it('starts at the window start, playing, in real time', () => {
    expect(startPlayback({ windowStartMs: 1_000 })).toEqual({ playing: true, speed: 1, positionMs: 1_000 });
  });

  it('runs at the chosen speed and stops at the end', () => {
    const at5 = { playing: true, speed: 5 as const, positionMs: 0 };
    expect(advance(at5, 100, 10_000).positionMs).toBe(500);
    const nearEnd = { ...at5, positionMs: 9_900 };
    expect(advance(nearEnd, 100, 10_000)).toEqual({ playing: false, speed: 5, positionMs: 10_000 });
  });

  it('does not move while paused', () => {
    const paused = { playing: false, speed: 1 as const, positionMs: 0 };
    expect(advance(paused, 1_000, 10_000)).toBe(paused);
  });
});

describe('crossedForward — when the alert sound plays', () => {
  it('fires on the tick that passes the alert going forward, once', () => {
    expect(crossedForward(900, 1_000, 1_000)).toBe(true);
    expect(crossedForward(1_000, 1_100, 1_000)).toBe(false);
  });

  it('stays silent going backwards', () => {
    expect(crossedForward(1_200, 800, 1_000)).toBe(false);
  });

  it('re-arms: playing through again after going back fires again', () => {
    // Scrubbed back before the alert, then played through it.
    expect(crossedForward(950, 1_050, 1_000)).toBe(true);
  });
});

describe('what has arrived by the playhead', () => {
  const arrivals = [arrival('A', 0, 2_000), arrival('B', 0, 3_000), arrival('A', 1_000, 4_000)];

  it('counts only records whose arrival has passed', () => {
    expect(arrivedCount(arrivals, 1_999)).toBe(0);
    expect(arrivedCount(arrivals, 3_000)).toBe(2);
    expect(arrivedCount(arrivals, 9_999)).toBe(3);
  });

  it('builds each row from its own arrived records, in start order', () => {
    const shuffled = [arrival('A', 1_000, 2_000), arrival('A', 0, 2_500)];
    const buffers = buffersFromArrivals(shuffled, 2);
    expect(buffers.get('A')?.segments.map((s) => s.startTimeMs)).toEqual([0, 1_000]);
    expect(buffersFromArrivals(arrivals, 1).has('B')).toBe(false);
  });

  it('knows a pick only once the record carrying it has arrived', () => {
    // The onset is at 500, but nobody could know until 2,500.
    const picks = [{ channelId: 'A', timeMs: 500, arrivedAtMs: 2_500 }];
    expect(knownPicks(picks, 2_000).size).toBe(0);
    expect(knownPicks(picks, 2_500).get('A')).toEqual([500]);
  });
});

describe('magnitudeAt', () => {
  const step = (atMs: number, magnitude: number): ReplayMagnitudeStep => ({
    atMs,
    magnitude,
    stations: 4,
    complete: false,
    intensityAtHome: 2,
  });
  const steps = [step(1_000, 6.1), step(2_000, 6.4), step(5_000, 7.1)];

  it('is the estimate as it stood then — climbing, not final', () => {
    expect(magnitudeAt(steps, 999)).toBeNull();
    expect(magnitudeAt(steps, 2_500)?.magnitude).toBe(6.4);
    expect(magnitudeAt(steps, 99_999)?.magnitude).toBe(7.1);
  });
});

describe('the wavefronts', () => {
  it('reach the surface only once they have climbed from the source depth', () => {
    expect(wavefrontRadiusKm(0, 6.2, 8)).toBeNull();
    expect(wavefrontRadiusKm(1_000, 6.2, 8)).toBeNull(); // 6.2 km travelled, still below 8 km
    // 10 s of S at 3.6 km/s from 8 km: √(36² − 8²) ≈ 35.1 km.
    expect(wavefrontRadiusKm(10_000, 3.6, 8)).toBeCloseTo(35.1, 1);
  });

  it('draws a closed ring at the radius it claims', () => {
    const centre = { latitude: 35.77, longitude: -117.6 };
    const ring = circlePoints(centre, 100, 36);
    expect(ring).toHaveLength(37);
    expect(ring[0]).toEqual(ring[36]);
    for (const [longitude, latitude] of ring) {
      expect(haversineKm(centre, { latitude, longitude })).toBeCloseTo(100, 0);
    }
  });

  it('wraps across the antimeridian rather than drawing the long way round', () => {
    const ring = circlePoints({ latitude: 0, longitude: 179.5 }, 200, 36);
    for (const [longitude] of ring) {
      expect(longitude).toBeGreaterThanOrEqual(-180);
      expect(longitude).toBeLessThanOrEqual(180);
    }
  });
});

describe('labels and marks', () => {
  it('reads time from the origin in seconds, or minutes for a distant quake', () => {
    expect(formatSinceOrigin(11_800)).toBe('+11.8 s');
    expect(formatSinceOrigin(-60_000)).toBe('−60.0 s');
    expect(formatSinceOrigin(692_000)).toBe('+11:32');
  });

  it('places a mark on the same mapping as the trace, and nowhere outside it', () => {
    expect(markX(1_500, 1_000, 2_000)).toBe(50);
    expect(markX(500, 1_000, 2_000)).toBeNull();
    expect(markX(2_500, 1_000, 2_000)).toBeNull();
  });
});
