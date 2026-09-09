import { describe, expect, it } from 'vitest';
import { faultVectors, resolvedShearPa, tidalTensor } from './tidal-stress';

const GM_SUN = 1.327_124_400_412_794_19e20;
const GM_MOON = 4.902_800_118e12;

function normalise(v: readonly [number, number, number]): readonly [number, number, number] {
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
}

describe('tidalTensor', () => {
  it('is traceless — the harmonic-potential identity, same check test_tides.py runs', () => {
    // A sign error in n̂n̂ᵀ still produces a smooth, plausible-looking tensor;
    // this is the check that actually catches it.
    const direction = normalise([0.6, -0.3, 0.75]);
    const tensor = tidalTensor(direction, 3.84e8, GM_MOON);
    const trace = tensor[0][0] + tensor[1][1] + tensor[2][2];
    expect(trace).toBeCloseTo(0, 6);
  });

  it('is symmetric, as (GM/d³)(3n̂n̂ᵀ − I) must be', () => {
    const direction = normalise([0.1, 0.9, -0.4]);
    const tensor = tidalTensor(direction, 1.496e11, GM_SUN);
    expect(tensor[0][1]).toBeCloseTo(tensor[1][0], 10);
    expect(tensor[0][2]).toBeCloseTo(tensor[2][0], 10);
    expect(tensor[1][2]).toBeCloseTo(tensor[2][1], 10);
  });
});

describe('faultVectors', () => {
  it('returns unit vectors for the normal and slip direction', () => {
    const { normal, slip } = faultVectors(30, 45, 90);
    expect(Math.hypot(...normal)).toBeCloseTo(1, 10);
    expect(Math.hypot(...slip)).toBeCloseTo(1, 10);
  });

  it('keeps the normal and slip direction perpendicular, as a fault plane requires', () => {
    const { normal, slip } = faultVectors(200, 25, -45);
    const dot = normal[0] * slip[0] + normal[1] * slip[1] + normal[2] * slip[2];
    expect(dot).toBeCloseTo(0, 10);
  });
});

describe('resolvedShearPa', () => {
  /**
   * Cross-checked against `engine/terra_pulse_engine/pipeline/tides.py`'s
   * `resolved_shear` directly — same synthetic (site, geometry, body
   * direction/distance) inputs run through both implementations, matching
   * to 10 decimal places. Reconnaissance, not a live dependency, the same
   * posture `tides.ts`'s own Skyfield cross-check documents rather than
   * re-running on every test pass.
   */
  it('matches the Python reference implementation exactly', () => {
    const bodies = {
      sun: {
        x: 0.943_456_353_049_726_5,
        y: 0.314_485_451_016_575_5,
        z: 0.104_828_483_672_191_83,
        distanceM: 1.496e11,
        gm: GM_SUN,
        sublatitudeDeg: 0,
        sublongitudeDeg: 0,
      },
      moon: {
        x: 0.620_173_672_946_042_2,
        y: -0.744_208_407_535_250_6,
        z: 0.248_069_469_178_416_9,
        distanceM: 3.84e8,
        gm: GM_MOON,
        sublatitudeDeg: 0,
        sublongitudeDeg: 0,
      },
    };

    expect(resolvedShearPa(bodies, 35, 139, 30, 45, 90)).toBeCloseTo(43.638_941_812_8, 6);
  });

  it('matches a second Python-checked case, including a negative result', () => {
    const bodies = {
      sun: {
        x: -0.205_737_799_949_455_9,
        y: 0.977_254_549_759_915_4,
        z: 0.051_434_449_987_363_975,
        distanceM: 1.47e11,
        gm: GM_SUN,
        sublatitudeDeg: 0,
        sublongitudeDeg: 0,
      },
      moon: {
        x: 0.100_458_129_113_152_04,
        y: 0.200_916_258_226_304_07,
        z: -0.974_443_852_397_574_7,
        distanceM: 4.0e8,
        gm: GM_MOON,
        sublatitudeDeg: 0,
        sublongitudeDeg: 0,
      },
    };

    expect(resolvedShearPa(bodies, -20, -70, 200, 25, -45)).toBeCloseTo(-144.508_874_868_3, 5);
  });

  it('vanishes for a fault whose normal is perpendicular to both bodies — the degenerate check', () => {
    const bodies = {
      sun: { x: 1, y: 0, z: 0, distanceM: 1.5e11, gm: GM_SUN, sublatitudeDeg: 0, sublongitudeDeg: 0 },
      moon: { x: 0, y: 1, z: 0, distanceM: 3.6e8, gm: GM_MOON, sublatitudeDeg: 0, sublongitudeDeg: 0 },
    };

    expect(resolvedShearPa(bodies, 0, 0, 90, 90, 0)).toBeCloseTo(0, 6);
  });
});
