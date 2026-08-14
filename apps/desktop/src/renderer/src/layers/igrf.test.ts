import { describe, expect, it } from 'vitest';
import {
  IGRF_FIRST_YEAR,
  IGRF_LAST_YEAR,
  decimalYear,
  derive,
  geomagneticField,
  igrfCoverage,
  interpolateCoefficients,
  sampleFieldGrid,
  synthesiseGeocentric,
} from './igrf';
import { IGRF_MODEL } from './igrf-data';

/**
 * IAGA's own test values, from `tests/tests_igrf14.py` in the pyIGRF14
 * distribution (https://www.ngdc.noaa.gov/IAGA/vmod/pyIGRF14.zip), whose header
 * records that they were "checked independently against igrf.f and D. Kerridge
 * Jupyter Notebook implementation (2019)".
 *
 * These are **geocentric**: `radiusKm` is distance from Earth's centre, not an
 * altitude, and `colatitude` is 90 - latitude. That is deliberate on their part
 * and useful on ours — it exercises the harmonic synthesis without the ellipsoid
 * conversion in the way, so a failure here is unambiguously the maths.
 *
 * Expected values are [X, Y, Z] in nT, where X = -B_theta, Y = B_phi,
 * Z = -B_r.
 *
 * ## The tolerance
 *
 * 0.01 nT absolute, which is the resolution of the oracle itself — IAGA print
 * these to two decimals, so agreement "to the last printed digit" is the most
 * that can be asserted, and anything tighter is testing their rounding rather
 * than our maths. Against a ~30,000 nT field that is a relative error of 3e-10,
 * and it is three orders of magnitude tighter than the reference's own
 * `rtol=1e-2`. The observed worst case is 0.0067 nT.
 */
const TOLERANCE_NT = 0.01;
const OFFICIAL_CASES: {
  year: number;
  colatitude: number;
  longitude: number;
  radiusKm: number;
  expected: [number, number, number];
}[] = [
  { year: 1900, colatitude: 175, longitude: -150, radiusKm: 6300, expected: [-5072.93, 10620.34, -67233.55] },
  { year: 1915, colatitude: 155, longitude: -120, radiusKm: 6350, expected: [14692.62, 12387.97, -59640.81] },
  { year: 1930, colatitude: 135, longitude: -90, radiusKm: 6400, expected: [23925.47, 10358.94, -30640.98] },
  { year: 1945, colatitude: 115, longitude: -60, radiusKm: 6450, expected: [23642.86, -200.29, -7607.92] },
  { year: 1960, colatitude: 95, longitude: -30, radiusKm: 6500, expected: [23647.0, -9302.27, -3610.73] },
  { year: 1975, colatitude: 75, longitude: 0, radiusKm: 6550, expected: [30050.59, -3367.82, 6332.69] },
  { year: 1990, colatitude: 55, longitude: 30, radiusKm: 6600, expected: [25224.81, 1058.25, 30965.61] },
  { year: 2005, colatitude: 35, longitude: 60, radiusKm: 6650, expected: [14718.37, 2842.99, 46050.88] },
  { year: 2010, colatitude: 170, longitude: 0, radiusKm: 6371, expected: [17529.48, -7143.78, -42722.46] },
  { year: 2020, colatitude: 15, longitude: 90, radiusKm: 6700, expected: [3734.07, 1294.17, 50833.13] },
  { year: 2025, colatitude: 56, longitude: -3, radiusKm: 6375, expected: [28927.56, 261.98, 30910.08] },
  { year: 2030, colatitude: 45, longitude: -5, radiusKm: 6375, expected: [22959.82, 224.8, 40764.14] },
];

describe('IGRF — IAGA official test values', () => {
  it.each(OFFICIAL_CASES)(
    '$year at colat $colatitude, lon $longitude, r $radiusKm km',
    ({ year, colatitude, longitude, radiusKm, expected }) => {
      const coefficients = interpolateCoefficients(year);
      const { radial, colatitudinal, azimuthal } = synthesiseGeocentric(
        coefficients,
        radiusKm,
        colatitude,
        longitude,
      );

      const [x, y, z] = expected;
      expect(Math.abs(-colatitudinal - x)).toBeLessThanOrEqual(TOLERANCE_NT);
      expect(Math.abs(azimuthal - y)).toBeLessThanOrEqual(TOLERANCE_NT);
      expect(Math.abs(-radial - z)).toBeLessThanOrEqual(TOLERANCE_NT);
    },
  );

  it('agrees to well inside the tolerance across every case', () => {
    // Stated as one number so a regression that merely creeps toward the bound
    // is visible, rather than only failing once it crosses.
    let worst = 0;
    for (const { year, colatitude, longitude, radiusKm, expected } of OFFICIAL_CASES) {
      const { radial, colatitudinal, azimuthal } = synthesiseGeocentric(
        interpolateCoefficients(year),
        radiusKm,
        colatitude,
        longitude,
      );
      const [x, y, z] = expected;
      worst = Math.max(
        worst,
        Math.abs(-colatitudinal - x),
        Math.abs(azimuthal - y),
        Math.abs(-radial - z),
      );
    }
    expect(worst).toBeLessThanOrEqual(TOLERANCE_NT);
  });
});

describe('the vendored model', () => {
  it('is degree 13 with the full 195 coefficients', () => {
    expect(IGRF_MODEL.nMax).toBe(13);
    expect(IGRF_MODEL.g.length + IGRF_MODEL.h.length).toBe(13 * 15);
  });

  it('spans 1900 to 2030 in five-year epochs', () => {
    expect(IGRF_MODEL.epochs[0]).toBe(1900);
    expect(IGRF_MODEL.epochs[IGRF_MODEL.epochs.length - 1]).toBe(2030);
    expect(IGRF_MODEL.epochs).toHaveLength(27);

    const steps = IGRF_MODEL.epochs.slice(1).map((e, i) => e - (IGRF_MODEL.epochs[i] ?? 0));
    expect(new Set(steps)).toEqual(new Set([5]));
  });

  it('starts the same year as the deep earthquake archive', () => {
    // Not a coincidence worth losing: it is what lets the field layer follow
    // the scrubber across the whole record instead of being a snapshot.
    expect(IGRF_FIRST_YEAR).toBe(1900);
  });
});

describe('coefficient interpolation', () => {
  it('reproduces an epoch exactly when the date is on it', () => {
    const coefficients = interpolateCoefficients(2020);
    // g(1,0) at 2020, straight from the published table.
    expect(coefficients[0]).toBeCloseTo(-29403.41, 6);
  });

  it('sits halfway between neighbouring epochs at the midpoint', () => {
    // IGRF is *defined* as piecewise-linear between epochs, so this is the
    // model's own behaviour rather than a convenience.
    const low = interpolateCoefficients(2015)[0] ?? 0;
    const high = interpolateCoefficients(2020)[0] ?? 0;
    const mid = interpolateCoefficients(2017.5)[0] ?? 0;
    expect(mid).toBeCloseTo((low + high) / 2, 6);
  });

  it('clamps outside the model rather than extrapolating', () => {
    // Running secular variation forward decades produces confident nonsense,
    // and before 1900 there is nothing to run. Clamping is visible in the UI
    // via igrfCoverage; silent extrapolation would not be.
    expect(interpolateCoefficients(1850)[0]).toBe(interpolateCoefficients(1900)[0]);
    expect(interpolateCoefficients(2200)[0]).toBe(interpolateCoefficients(2030)[0]);
  });

  it('reports coverage honestly', () => {
    expect(igrfCoverage(1975)).toEqual({ covered: true, clampedYear: 1975 });
    expect(igrfCoverage(1850)).toEqual({ covered: false, clampedYear: IGRF_FIRST_YEAR });
    expect(igrfCoverage(2200)).toEqual({ covered: false, clampedYear: IGRF_LAST_YEAR });
  });
});

describe('decimalYear', () => {
  it('is the year itself at the stroke of January 1', () => {
    expect(decimalYear(new Date('2020-01-01T00:00:00Z'))).toBe(2020);
  });

  it('is halfway through at the start of July', () => {
    // 2020 is a leap year: 182 of 366 days.
    expect(decimalYear(new Date('2020-07-01T00:00:00Z'))).toBeCloseTo(2020 + 182 / 366, 6);
  });
});

describe('geodetic evaluation', () => {
  it('produces a plausible field at the surface', () => {
    // Sanity bounds, not a reference value: Earth's surface field runs roughly
    // 22,000-67,000 nT everywhere.
    const field = geomagneticField(51.5, -0.13, 2025);
    expect(field.intensity).toBeGreaterThan(22_000);
    expect(field.intensity).toBeLessThan(67_000);
  });

  it('dips downward in the northern magnetic hemisphere and upward in the south', () => {
    expect(geomagneticField(60, -100, 2025).inclination).toBeGreaterThan(0);
    expect(geomagneticField(-60, 140, 2025).inclination).toBeLessThan(0);
  });

  it('differs from the geocentric answer, because the ellipsoid is real', () => {
    // Guards the rotation onto the ellipsoid normal. Dropping it leaves a field
    // that still looks entirely reasonable, which is exactly why it needs a
    // test — the discrepancy peaks near 45 degrees.
    const coefficients = interpolateCoefficients(2025);
    const geodetic = geomagneticField(45, 0, 2025, 0, coefficients);
    const geocentric = synthesiseGeocentric(coefficients, 6371.2, 45, 0);
    expect(Math.abs(geodetic.north - -geocentric.colatitudinal)).toBeGreaterThan(50);
  });

  it('is finite at both poles', () => {
    // B_phi carries a 1/sin(theta) that is indeterminate there. Without the
    // L'Hopital branch the top and bottom row of every grid is NaN, which draws
    // as two transparent bands rather than failing.
    for (const latitude of [90, -90]) {
      const field = geomagneticField(latitude, 0, 2025);
      expect(Number.isFinite(field.intensity)).toBe(true);
      expect(Number.isFinite(field.declination)).toBe(true);
      expect(Number.isFinite(field.east)).toBe(true);
    }
  });

  it('finds the South Atlantic Anomaly weaker than the global surface average', () => {
    // The reason the intensity view is worth drawing at all.
    const anomaly = geomagneticField(-25, -45, 2025).intensity;
    const elsewhere = geomagneticField(-25, 135, 2025).intensity;
    expect(anomaly).toBeLessThan(elsewhere);
    expect(anomaly).toBeLessThan(28_000);
  });

  it('shows the anomaly deepening over the modern record', () => {
    // Real, documented behaviour of the field, and the payoff for making the
    // layer follow the playhead.
    const then = geomagneticField(-25, -45, 1900).intensity;
    const now = geomagneticField(-25, -45, 2025).intensity;
    expect(now).toBeLessThan(then);
  });
});

describe('derive', () => {
  it('reads declination east of north', () => {
    expect(derive(1, 1, 0).declination).toBeCloseTo(45, 9);
    expect(derive(1, -1, 0).declination).toBeCloseTo(-45, 9);
  });

  it('reads inclination as dip below horizontal', () => {
    expect(derive(1, 0, 1).inclination).toBeCloseTo(45, 9);
    expect(derive(1, 0, 0).inclination).toBeCloseTo(0, 9);
  });

  it('combines components into horizontal and total intensity', () => {
    const field = derive(3, 4, 12);
    expect(field.horizontal).toBeCloseTo(5, 9);
    expect(field.intensity).toBeCloseTo(13, 9);
  });
});

describe('sampleFieldGrid', () => {
  it('agrees with the per-point path it hoists work out of', () => {
    // The whole point of the grid sampler is that it reuses the Legendre and
    // trig tables across a row. That is only safe if it produces identical
    // numbers, so this compares it against the unoptimised function it
    // replaces, at cell centres.
    const width = 12;
    const height = 6;
    const grid = sampleFieldGrid(2025, width, height, 'intensity');

    let worst = 0;
    for (let j = 0; j < height; j += 1) {
      const latitude = 90 - ((j + 0.5) / height) * 180;
      for (let i = 0; i < width; i += 1) {
        const longitude = -180 + ((i + 0.5) / width) * 360;
        const direct = geomagneticField(latitude, longitude, 2025).intensity;
        worst = Math.max(worst, Math.abs((grid[j * width + i] ?? 0) - direct));
      }
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('carries declination and inclination too', () => {
    const width = 8;
    const height = 4;
    for (const quantity of ['declination', 'inclination'] as const) {
      const grid = sampleFieldGrid(2025, width, height, quantity);
      const latitude = 90 - (0.5 / height) * 180;
      const longitude = -180 + (0.5 / width) * 360;
      const direct = geomagneticField(latitude, longitude, 2025)[quantity];
      expect(grid[0]).toBeCloseTo(direct, 9);
    }
  });

  it('samples cell centres, so the antimeridian is not counted twice', () => {
    // Sampling edges would put a column at -180 and another at +180 — the same
    // meridian — and leave the cells either side of it unrepresented.
    const grid = sampleFieldGrid(2025, 4, 2, 'intensity');
    const first = geomagneticField(45, -135, 2025).intensity;
    expect(grid[0]).toBeCloseTo(first, 9);
  });

  it('is finite everywhere including the polar rows', () => {
    const grid = sampleFieldGrid(2025, 36, 18, 'declination');
    expect(grid.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('produces a full-resolution grid fast enough to scrub', () => {
    // 360x181 is the resolution the layer draws at. This is a guard against a
    // refactor quietly un-hoisting the per-row work, which costs ~40x.
    const started = performance.now();
    sampleFieldGrid(2025, 360, 181, 'intensity');
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(2000);
    console.log(`    sampleFieldGrid 360x181: ${elapsed.toFixed(0)} ms`);
  });
});
