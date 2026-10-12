import { describe, expect, it } from 'vitest';
import { HomeAlerter, WATCH_ALERT_RULE } from './quake-alert';
import type { MagnitudeEstimate } from './quake-magnitude';
import { AWW14_CALIFORNIA, intensityNumeral, predictIntensity } from './shaking-intensity';

const BURBANK = { latitude: 34.1808, longitude: -118.309 };
const GEOMETRY = { depthKm: 8, sVelocityKmS: 3.6 };
const T0 = Date.parse('2026-10-01T12:00:00Z');

function estimate(magnitude: number): MagnitudeEstimate {
  return { magnitude, stations: [], complete: false };
}

describe('predictIntensity (AWW14, California)', () => {
  it('is the published equation', () => {
    // M5 at 30 km: R = √(30² + 14²), inside 50 km so B = 0.
    const { c1, c2, c3, c4, c6 } = AWW14_CALIFORNIA;
    const r = Math.hypot(30, 14);
    expect(predictIntensity(5, 30)).toBeCloseTo(c1 + c2 * 5 + c3 * Math.log10(r) + c4 * r + c6 * 5 * Math.log10(r), 10);
  });

  it('brings in the far-field term beyond 50 km, continuously', () => {
    const justInside = Math.sqrt(50 ** 2 - 14 ** 2) - 1e-6;
    expect(predictIntensity(6, justInside)).toBeCloseTo(predictIntensity(6, justInside + 2e-6), 4);
  });

  it('reproduces what Burbank reported for the quakes it was checked against', () => {
    // Did You Feel It?, Burbank ZIPs: Ridgecrest M7.1 at 188 km reported 4.2
    // (161 reports); Highland Park M4.4 at 20 km reported 3.8 (404).
    expect(predictIntensity(7.1, 188)).toBeCloseTo(4.2, 1);
    expect(predictIntensity(4.4, 20)).toBeCloseTo(3.8, 1);
  });

  it('rises with magnitude and falls with distance across the range alerts use', () => {
    for (let m = 3; m <= 8; m += 0.5) {
      for (let km = 1; km <= 300; km += 7) {
        expect(predictIntensity(m + 0.1, km)).toBeGreaterThan(predictIntensity(m, km));
        expect(predictIntensity(m, km + 5)).toBeLessThan(predictIntensity(m, km));
      }
    }
  });

  it('names intensities by rounding, clamped to I-X', () => {
    expect(intensityNumeral(2.4)).toBe('II');
    expect(intensityNumeral(2.5)).toBe('III');
    expect(intensityNumeral(-1)).toBe('I');
    expect(intensityNumeral(12)).toBe('X');
  });
});

describe('HomeAlerter', () => {
  /** 20 km north of home. */
  const nearby = { id: 1, originMs: T0, latitude: BURBANK.latitude + 20 / 111.195, longitude: BURBANK.longitude };

  it('alerts when the shaking predicted at home crosses the threshold, not before', () => {
    const alerter = new HomeAlerter(BURBANK, { minIntensity: 3 }, GEOMETRY);
    expect(alerter.evaluate(nearby, estimate(2.5), T0 + 5_000)).toBeNull();
    expect(alerter.evaluate(nearby, null, T0 + 6_000)).toBeNull();
    const alert = alerter.evaluate(nearby, estimate(4.5), T0 + 7_000);
    expect(alert).not.toBeNull();
    expect(alert!.alertedAtMs).toBe(T0 + 7_000);
    expect(alert!.intensity).toBeGreaterThanOrEqual(3);
  });

  it('decides on distance as well as magnitude', () => {
    const alerter = new HomeAlerter(BURBANK, { minIntensity: 3 }, GEOMETRY);
    const far = { ...nearby, id: 2, latitude: BURBANK.latitude + 200 / 111.195 };
    expect(alerter.evaluate(far, estimate(4.5), T0)).toBeNull();
    expect(alerter.evaluate(nearby, estimate(4.5), T0)).not.toBeNull();
  });

  it('latches: a dipping estimate updates the alert but never withdraws it or repeats it', () => {
    const alerter = new HomeAlerter(BURBANK, { minIntensity: 3 }, GEOMETRY);
    expect(alerter.evaluate(nearby, estimate(4.5), T0 + 7_000)).not.toBeNull();
    expect(alerter.evaluate(nearby, estimate(2.0), T0 + 8_000)).toBeNull();
    expect(alerter.evaluate(nearby, estimate(5.0), T0 + 9_000)).toBeNull();
    const alert = alerter.alertFor(nearby.id)!;
    expect(alert.alertedAtMs).toBe(T0 + 7_000);
    expect(alert.magnitude).toBe(5.0);
  });

  it('with a magnitude floor, waits for the estimate to reach it even when home would feel it', () => {
    const alerter = new HomeAlerter(BURBANK, { minIntensity: 2.5, minMagnitude: 4.5 }, GEOMETRY);
    // An M4.2 20 km away is felt at home (MMI > 2.5) but is under the floor.
    expect(alerter.intensityAtHome(nearby, 4.2)).toBeGreaterThan(2.5);
    expect(alerter.evaluate(nearby, estimate(4.2), T0 + 5_000)).toBeNull();
    expect(alerter.evaluate(nearby, estimate(4.5), T0 + 6_000)?.alertedAtMs).toBe(T0 + 6_000);
  });

  it('with a magnitude floor, still needs the shaking at home', () => {
    const alerter = new HomeAlerter(BURBANK, WATCH_ALERT_RULE, GEOMETRY);
    const far = { ...nearby, id: 2, latitude: BURBANK.latitude + 300 / 111.195 };
    expect(alerter.evaluate(far, estimate(4.8), T0)).toBeNull();
  });

  it('says when strong shaking reaches home, from the origin at S speed', () => {
    const alerter = new HomeAlerter(BURBANK, { minIntensity: 1 }, GEOMETRY);
    const alert = alerter.evaluate(nearby, estimate(5), T0 + 3_000)!;
    expect(alert.epicentralKm).toBeCloseTo(20, 0);
    expect(alert.sArrivalAtHomeMs - T0).toBeCloseTo((1000 * Math.hypot(alert.epicentralKm, 8)) / 3.6, 3);
  });
});
