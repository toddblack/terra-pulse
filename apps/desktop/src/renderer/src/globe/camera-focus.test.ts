import { describe, expect, it } from 'vitest';
import {
  FALLBACK_FOCUS_ALTITUDE_M,
  FALLBACK_HOME_ALTITUDE_M,
  focusAltitudeM,
  homeAltitudeM,
  homeLongitudeDeg,
} from './camera-focus';

describe('focusAltitudeM', () => {
  it('keeps a close-in zoom when selecting another event', () => {
    // The reported bug, as a test. Zoomed in to inspect a sequence, clicking a
    // neighbouring quake used to fly the camera back out to 250 km.
    expect(focusAltitudeM(50_000)).toBe(50_000);
    expect(focusAltitudeM(2_000)).toBe(2_000);
  });

  it('keeps a zoomed-out view too', () => {
    expect(focusAltitudeM(12_000_000)).toBe(12_000_000);
  });

  it('never pulls the camera to a fixed altitude for any usable height', () => {
    // The old implementation was Math.max(height, 250_000), so everything
    // below the floor collapsed onto it. Nothing may do that now.
    const heights = [1, 100, 10_000, 249_999, 250_000, 250_001, 5_000_000];
    expect(heights.map(focusAltitudeM)).toEqual(heights);
  });

  it('falls back when the camera height is unusable', () => {
    // At or below the surface the destination would be inside the Earth. This
    // is the only job the old floor should have had.
    expect(focusAltitudeM(0)).toBe(FALLBACK_FOCUS_ALTITUDE_M);
    expect(focusAltitudeM(-1_000)).toBe(FALLBACK_FOCUS_ALTITUDE_M);
    expect(focusAltitudeM(Number.NaN)).toBe(FALLBACK_FOCUS_ALTITUDE_M);
    expect(focusAltitudeM(Number.POSITIVE_INFINITY)).toBe(FALLBACK_FOCUS_ALTITUDE_M);
  });
});

describe('the home view', () => {
  it('faces the reader’s own longitude, at 15° per hour of UTC offset', () => {
    expect(homeLongitudeDeg(0)).toBe(0);
    // Los Angeles in winter, Tokyo, and India's half-hour offset.
    expect(homeLongitudeDeg(-480)).toBe(-120);
    expect(homeLongitudeDeg(540)).toBe(135);
    expect(homeLongitudeDeg(330)).toBe(82.5);
  });

  it('wraps offsets past the date line instead of leaving the legal range', () => {
    // UTC+14 is 210° east, which is the same meridian as 150° west.
    expect(homeLongitudeDeg(840)).toBe(-150);
    expect(homeLongitudeDeg(-720)).toBe(-180);
    expect(homeLongitudeDeg(720)).toBe(-180);
  });

  it('falls back to the prime meridian on a clock that reports nothing usable', () => {
    expect(homeLongitudeDeg(Number.NaN)).toBe(0);
  });

  it('opens at the height Cesium started at, unless that is not a whole-globe height', () => {
    expect(homeAltitudeM(22_107_000)).toBe(22_107_000);
    expect(homeAltitudeM(Number.NaN)).toBe(FALLBACK_HOME_ALTITUDE_M);
    expect(homeAltitudeM(0)).toBe(FALLBACK_HOME_ALTITUDE_M);
  });
});
