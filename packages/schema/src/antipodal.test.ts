import { describe, expect, it } from 'vitest';
import {
  ANTIPODAL_TARGET_MIN_MAGNITUDE,
  ANTIPODAL_TRIGGER_MIN_MAGNITUDE,
  ANTIPODAL_WINDOW_HOURS,
  antipodeOf,
  backgroundIntervalDays,
  normalizeLongitude,
  summariseAntipodal,
} from './antipodal';
import type { EarthquakeEvent } from './earthquake';

const TRIGGER = { latitude: 4.84, longitude: -76.24, timeUtc: '2026-08-10T12:34:00.000Z' };
const ORIGIN = Date.parse(TRIGGER.timeUtc);

function quake(id: string, lat: number, lon: number, hoursAfter: number, mag = 5.1): EarthquakeEvent {
  return {
    id, source: 'usgs', magnitude: mag, magnitudeType: 'mww', place: 'somewhere',
    timeUtc: new Date(ORIGIN + hoursAfter * 3600_000).toISOString(),
    updatedUtc: new Date(ORIGIN + hoursAfter * 3600_000).toISOString(),
    longitude: lon, latitude: lat, depthKm: 10, status: 'reviewed',
    tsunami: false, alertLevel: null, significance: null, url: 'https://example.test',
  };
}

describe('registered parameters', () => {
  /**
   * H5 was registered on 2026-07-24 at 0–72h. Shortening it after observing a
   * case that fits inside 24h is the free-parameter-after-the-fact that
   * non-negotiable #3 exists to prevent. Pinned so a change is deliberate.
   */
  it('keeps H5 window at the registered 72 hours', () => {
    expect(ANTIPODAL_WINDOW_HOURS).toBe(72);
  });

  it('keeps the registered trigger and target floors', () => {
    expect(ANTIPODAL_TRIGGER_MIN_MAGNITUDE).toBe(6);
    expect(ANTIPODAL_TARGET_MIN_MAGNITUDE).toBe(5);
  });
});

describe('antipodeOf', () => {
  it('mirrors latitude and turns longitude half a circle', () => {
    expect(antipodeOf({ latitude: 4.84, longitude: -76.24 })).toEqual({
      latitude: -4.84, longitude: 103.76,
    });
  });

  it('is its own inverse', () => {
    // To within floating point: a half-turn there and back is not bit-exact for
    // every input, and chasing that would be chasing ~1e-14 degrees — about a
    // nanometre on the ground.
    for (const p of [
      { latitude: -33.45, longitude: 174.78 },
      { latitude: 4.84, longitude: -76.24 },
      { latitude: 0, longitude: 0 },
      { latitude: 61.2, longitude: -149.9 },
    ]) {
      const round = antipodeOf(antipodeOf(p));
      expect(round.latitude).toBeCloseTo(p.latitude, 10);
      expect(Math.abs(round.longitude - p.longitude) % 360).toBeLessThan(1e-9);
    }
  });

  it('keeps longitude in [-180, 180)', () => {
    expect(normalizeLongitude(180)).toBe(-180);
    expect(antipodeOf({ latitude: 0, longitude: 0 }).longitude).toBe(-180);
  });

  it('ignores depth — the antipode is a surface point', () => {
    // A 600km-deep hypocentre is still below its surface point; treating depth
    // as geometry would put the far end inside the mantle.
    const shallow = antipodeOf({ latitude: 10, longitude: 20 });
    const deep = antipodeOf({ latitude: 10, longitude: 20 });
    expect(shallow).toEqual(deep);
  });
});

describe('summariseAntipodal', () => {
  const opts = (over = {}) => ({
    backgroundCount: 612, backgroundYears: 56.6,
    nowMs: ORIGIN + 100 * 3600_000, ...over,
  });

  it('measures distance from the antipode and delay from the trigger', () => {
    // The real pair: Sumatra M5.1, 197km from the antipode, 4.6h later.
    const w = summariseAntipodal(TRIGGER, [quake('a', -6.5, 103.2, 4.6)], opts());
    expect(w.antipode.latitude).toBeCloseTo(-4.84, 2);
    expect(w.events).toHaveLength(1);
    expect(w.events[0]?.distanceKm).toBeGreaterThan(150);
    expect(w.events[0]?.distanceKm).toBeLessThan(250);
    expect(w.events[0]?.delayHours).toBeCloseTo(4.6, 1);
  });

  it('orders nearest to the antipode first', () => {
    const w = summariseAntipodal(
      TRIGGER,
      [quake('far', -12, 103.76, 2), quake('near', -5.5, 103.76, 40)],
      opts(),
    );
    expect(w.events.map((e) => e.event.id)).toEqual(['near', 'far']);
  });

  /** The number that stops the panel being a coincidence generator. */
  it('reports the background rate the result must be judged against', () => {
    const w = summariseAntipodal(TRIGGER, [], opts());
    expect(w.backgroundPerYear).toBeCloseTo(612 / 56.6, 3);
    expect(backgroundIntervalDays(w)).toBeCloseTo(365.25 / (612 / 56.6), 1);
    expect(w.backgroundSilent).toBe(false);
  });

  /**
   * Roughly a third of antipodes fall in seismically dead ocean. There, an
   * empty window says nothing at all, and the panel must not present it as a
   * finding.
   */
  it('flags an antipode the catalogue has never recorded anything near', () => {
    const w = summariseAntipodal(TRIGGER, [], opts({ backgroundCount: 0 }));
    expect(w.backgroundSilent).toBe(true);
    expect(backgroundIntervalDays(w)).toBeNull();
  });

  it('reports a partially elapsed window rather than a final answer', () => {
    const w = summariseAntipodal(TRIGGER, [], opts({ nowMs: ORIGIN + 18 * 3600_000 }));
    expect(w.elapsedFraction).toBeCloseTo(18 / 72, 3);
  });

  it('clamps elapsed to 1 once the window has passed', () => {
    const w = summariseAntipodal(TRIGGER, [], opts({ nowMs: ORIGIN + 500 * 3600_000 }));
    expect(w.elapsedFraction).toBe(1);
  });

  it('handles an antipode across the date line without absurd distances', () => {
    // Trigger near the antimeridian: its antipode is near the prime meridian.
    const t = { latitude: 50, longitude: 179.9, timeUtc: TRIGGER.timeUtc };
    const w = summariseAntipodal(t, [quake('x', -50, -0.2, 1)], opts());
    expect(w.events[0]?.distanceKm).toBeLessThan(50);
  });
});
