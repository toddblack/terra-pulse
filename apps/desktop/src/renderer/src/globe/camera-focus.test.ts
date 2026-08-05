import { describe, expect, it } from 'vitest';
import { FALLBACK_FOCUS_ALTITUDE_M, focusAltitudeM } from './camera-focus';

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
