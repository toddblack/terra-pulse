import { describe, expect, it } from 'vitest';
import { bearingDeg, haversineKm, type WaveformStation } from '@terra-pulse/schema';
import { WATCH_ALERT_RULE } from './quake-alert';
import {
  LiveQuakeWatch,
  TEST_ALERT,
  WATCH_MAX_STATIONS,
  WATCH_RADIUS_KM,
  climbTestAlert,
  testWatchAlert,
  watchNetwork,
  watchReach,
} from './quake-watch';

const PIN = { latitude: 34.1808, longitude: -118.309, label: 'Burbank' };
const KM_PER_DEG = 111.195;

let serial = 0;
/** A station `km` from the pin, on `bearing` degrees (north-ish geometry; fine at these scales). */
function station(km: number, bearing: number, rate = 100): WaveformStation {
  serial += 1;
  const rad = (bearing * Math.PI) / 180;
  const latitude = PIN.latitude + (km * Math.cos(rad)) / KM_PER_DEG;
  const longitude = PIN.longitude + (km * Math.sin(rad)) / (KM_PER_DEG * Math.cos((PIN.latitude * Math.PI) / 180));
  return {
    network: 'XX',
    station: `S${String(serial)}`,
    location: '',
    channel: 'HHZ',
    latitude,
    longitude,
    site: `S${String(serial)}`,
    sampleRateHz: rate,
  };
}

describe('watchNetwork', () => {
  it('keeps every station ≥20 Hz within the radius when they fit under the cap, nearest first', () => {
    const near = station(10, 0);
    const far = station(250, 90);
    const slow = station(20, 180, 10);
    const outside = station(WATCH_RADIUS_KM + 5, 270);
    expect(watchNetwork([far, slow, outside, near], PIN)).toEqual([near, far]);
  });

  it('thins a dense cluster by spacing, not by distance: the far ring survives', () => {
    // 300 stations piled within 5 km of the pin (a volcano network), plus a
    // sparse ring at 200 km. Nearest-N would keep only the pile.
    const pile = Array.from({ length: 300 }, (_, i) => station(0.5 + (i % 50) * 0.09, (i * 37) % 360));
    const ring = Array.from({ length: 12 }, (_, i) => station(200, i * 30));
    const network = watchNetwork([...ring, ...pile], PIN);
    expect(network.length).toBeLessThanOrEqual(WATCH_MAX_STATIONS);
    for (const r of ring) expect(network).toContain(r);
    // The nearest station always survives — `too-far` is measured from it.
    const nearest = [...pile].sort((a, b) => haversineKm(PIN, a) - haversineKm(PIN, b))[0];
    expect(network[0]).toBe(nearest);
  });

  it('fills the cap rather than overshooting the spacing', () => {
    const grid = Array.from({ length: 400 }, (_, i) => station(5 + (i % 20) * 14, Math.floor(i / 20) * 18));
    const network = watchNetwork(grid, PIN);
    expect(network.length).toBeLessThanOrEqual(WATCH_MAX_STATIONS);
    expect(network.length).toBeGreaterThan(WATCH_MAX_STATIONS * 0.8);
  });
});

describe('watchReach', () => {
  it('is watchable with four stations and one close to the pin', () => {
    const network = [station(10, 0), station(60, 90), station(80, 180), station(120, 270)];
    const reach = watchReach(network, PIN);
    expect(reach.limit).toBeNull();
    expect(reach.nearestKm).toBeCloseTo(10, 0);
  });

  it('says too-few-stations below four, and too-far when none is near the pin', () => {
    expect(watchReach([station(10, 0), station(20, 90), station(30, 180)], PIN).limit).toBe('too-few-stations');
    expect(watchReach([], PIN)).toEqual({ limit: 'too-few-stations', nearestKm: null });
    const distant = [station(120, 0), station(130, 90), station(140, 180), station(150, 270)];
    expect(watchReach(distant, PIN).limit).toBe('too-far');
  });
});

describe('LiveQuakeWatch', () => {
  it('ignores records from channels outside its network and counts no detections', () => {
    const watch = new LiveQuakeWatch({ pin: PIN, network: [station(10, 0)], gains: null, gainAtMs: 0, idPrefix: 'a' });
    const result = watch.push({ channelId: 'ZZ_NOPE__HHZ', startTimeMs: 0, sampleRateHz: 100, samples: [1, 2, 3] }, 1_000);
    expect(result).toEqual({ declared: [], raised: [], updated: [] });
    expect(watch.detections).toBe(0);
    expect(watch.magnitudeStations).toBe(0);
  });
});

describe('testWatchAlert', () => {
  it('is shaped like a real alert: 100 km NE, ~14 s of countdown, and over both alert thresholds', () => {
    const alert = testWatchAlert(PIN, 1_000_000, 'test-1');
    expect(alert.test).toBe(true);
    expect(alert.epicentralKm).toBeCloseTo(TEST_ALERT.distanceKm, 6);
    expect(haversineKm(PIN, alert)).toBeCloseTo(TEST_ALERT.distanceKm, 6);
    expect(bearingDeg(PIN, alert)).toBeCloseTo(TEST_ALERT.bearingDeg, 0);
    expect(alert.originMs).toBe(1_000_000 - TEST_ALERT.declaredAfterOriginMs);
    // S at 3.6 km/s over ~100 km is ~28 s after origin, 14 s of which has gone.
    const countdownS = (alert.sArrivalAtPinMs - alert.alertedAtMs) / 1000;
    expect(countdownS).toBeGreaterThan(12);
    expect(countdownS).toBeLessThan(16);
    // A real alert at these numbers would have been raised: the test shows nothing a real one could not.
    expect(alert.magnitude).toBeGreaterThanOrEqual(WATCH_ALERT_RULE.minMagnitude ?? 0);
    expect(alert.intensity).toBeGreaterThanOrEqual(WATCH_ALERT_RULE.minIntensity);
  });

  it('climbs in magnitude and intensity, and nothing else moves', () => {
    const alert = testWatchAlert(PIN, 1_000_000, 'test-1');
    const climbed = climbTestAlert(alert, TEST_ALERT.climbedMagnitude);
    expect(climbed.magnitude).toBe(TEST_ALERT.climbedMagnitude);
    expect(climbed.intensity).toBeGreaterThan(alert.intensity);
    expect({ ...climbed, magnitude: alert.magnitude, intensity: alert.intensity }).toEqual(alert);
  });

  it('stays a legal coordinate for a pin by the antimeridian', () => {
    const alert = testWatchAlert({ latitude: -17.7, longitude: 179.9, label: 'Fiji' }, 0, 't');
    expect(alert.longitude).toBeGreaterThanOrEqual(-180);
    expect(alert.longitude).toBeLessThan(180);
    expect(alert.epicentralKm).toBeCloseTo(TEST_ALERT.distanceKm, 6);
  });
});
