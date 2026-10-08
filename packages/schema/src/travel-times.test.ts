import { describe, expect, it } from 'vitest';
import { travelSeconds, wavefrontKm } from './travel-times';

describe('travelSeconds', () => {
  it('reads the IASP91 table at its rows', () => {
    // 10° = 1,111.9 km.
    expect(travelSeconds('P', 1111.9)).toBeCloseTo(143.7, 1);
    expect(travelSeconds('S', 1111.9)).toBeCloseTo(257.1, 1);
  });

  it('is close to the crustal speed nearby and far faster than it at regional distance', () => {
    // 100 km: the detector's 6.2 km/s would say 16.1 s; IASP91's crust is a little slower.
    expect(travelSeconds('P', 100)).toBeGreaterThan(15);
    expect(travelSeconds('P', 100)).toBeLessThan(19);
    // 2,000 km: Pn/P through the mantle, not 2000/6.2 = 323 s.
    expect(travelSeconds('P', 2000)).toBeLessThan(270);
  });

  it('keeps S behind P everywhere', () => {
    for (let km = 0; km <= 10_000; km += 250) expect(travelSeconds('S', km)).toBeGreaterThan(travelSeconds('P', km));
  });
});

describe('wavefrontKm', () => {
  it('inverts travelSeconds', () => {
    for (const km of [5, 80, 400, 1500, 3000, 7000]) {
      expect(wavefrontKm('P', travelSeconds('P', km))).toBeCloseTo(km, 6);
      expect(wavefrontKm('S', travelSeconds('S', km))).toBeCloseTo(km, 6);
    }
  });

  it('is null before the wave reaches the surface and past the table', () => {
    expect(wavefrontKm('P', 1)).toBeNull();
    expect(wavefrontKm('P', 5000)).toBeNull();
  });

  it('only grows', () => {
    let last = 0;
    for (let s = 2; s < 1400; s += 5) {
      const km = wavefrontKm('S', s) ?? last;
      expect(km).toBeGreaterThanOrEqual(last);
      last = km;
    }
  });
});
