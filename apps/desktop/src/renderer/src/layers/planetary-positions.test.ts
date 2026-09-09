import { describe, expect, it } from 'vitest';
import { celestialBodies } from './planetary-positions';
import { lunarBody, solarBody } from './tides';

/** Real Earth-distance ranges (AU), generously bounded — a self-consistency
 * check independent of any reference ephemeris: if a planet's computed
 * distance ever falls outside its true possible range, something in the
 * orbital elements or the geocentric conversion is wrong regardless of what
 * any external source says. */
const DISTANCE_RANGE_AU: Record<string, [number, number]> = {
  mercury: [0.5, 1.5],
  venus: [0.25, 1.75],
  mars: [0.35, 2.7],
  jupiter: [3.9, 6.5],
  saturn: [7.9, 11.2],
  uranus: [17.2, 21.2],
  neptune: [28.7, 31.4],
};

const AU_M = 1.495_978_707e11;

/**
 * Cross-checked against Skyfield/DE440 (the same kernel H6 downloads),
 * geometric position (no light-time correction, matching this module's own
 * instantaneous two-body model) at 2026-09-08T21:00:00Z. Reconnaissance
 * only — not re-run live, the same posture `tides.ts`'s and
 * `magnetopause.ts`'s doc comments describe for their own Skyfield checks.
 *
 * Tolerance is 1 degree for sublatitude/sublongitude and 2% for distance —
 * generous against the ~0.3-0.4 degree agreement actually measured at this
 * date, because this module carries no perturbation terms for the outer
 * planets and that gap widens (slowly) the further from 2000 the instant is.
 */
const SKYFIELD_REFERENCE_2026_09_08T21 = {
  mercury: { sublatitudeDeg: 2.2202, sublongitudeDeg: -125.7316, distanceAu: 1.366_36 },
  venus: { sublatitudeDeg: -15.1081, sublongitudeDeg: -97.936, distanceAu: 0.494_83 },
  mars: { sublatitudeDeg: 22.8782, sublongitudeDeg: 166.632, distanceAu: 1.805_77 },
  jupiter: { sublatitudeDeg: 16.8659, sublongitudeDeg: -165.3413, distanceAu: 6.138_85 },
  saturn: { sublatitudeDeg: 2.5992, sublongitudeDeg: 69.9031, distanceAu: 8.533_34 },
  uranus: { sublatitudeDeg: 21.034, sublongitudeDeg: 120.4908, distanceAu: 19.235_82 },
  neptune: { sublatitudeDeg: -0.0724, sublongitudeDeg: 60.4601, distanceAu: 28.915_17 },
} as const;

describe('celestialBodies', () => {
  it('returns all nine bodies', () => {
    const bodies = celestialBodies(new Date('2026-09-08T21:00:00Z'));
    expect(Object.keys(bodies).sort()).toEqual(
      ['jupiter', 'mars', 'mercury', 'moon', 'neptune', 'saturn', 'sun', 'uranus', 'venus'].sort(),
    );
  });

  it('reads the Sun and Moon straight off tides.ts, not a second computation', () => {
    const at = new Date('2026-09-08T21:00:00Z');
    const bodies = celestialBodies(at);
    const sun = solarBody(at);
    const moon = lunarBody(at);

    expect(bodies.sun.sublatitudeDeg).toBe(sun.sublatitudeDeg);
    expect(bodies.sun.sublongitudeDeg).toBe(sun.sublongitudeDeg);
    expect(bodies.sun.distanceM).toBe(sun.distanceM);
    expect(bodies.moon.sublatitudeDeg).toBe(moon.sublatitudeDeg);
    expect(bodies.moon.sublongitudeDeg).toBe(moon.sublongitudeDeg);
    expect(bodies.moon.distanceM).toBe(moon.distanceM);
  });

  it('keeps every planet within its true possible Earth-distance range', () => {
    // Sampled across a wide span, not just one instant — a phase bug (like
    // the Earth-position sign error this module's own doc comment records)
    // can put a planet at the wrong point of its range without leaving it,
    // so this alone would not have caught that bug. It catches a wrong
    // semi-major axis or a broken Kepler solve, which this alone would.
    const instants = [
      new Date('1990-01-01T00:00:00Z'),
      new Date('2005-06-15T12:00:00Z'),
      new Date('2026-09-08T21:00:00Z'),
      new Date('2045-11-20T06:00:00Z'),
    ];
    for (const at of instants) {
      const bodies = celestialBodies(at);
      for (const [planet, [min, max]] of Object.entries(DISTANCE_RANGE_AU)) {
        const distanceAu = bodies[planet as keyof typeof bodies].distanceM / AU_M;
        expect(distanceAu, `${planet} at ${at.toISOString()}`).toBeGreaterThanOrEqual(min);
        expect(distanceAu, `${planet} at ${at.toISOString()}`).toBeLessThanOrEqual(max);
      }
    }
  });

  it('agrees with Skyfield/DE440 to within a degree and 2% distance', () => {
    const bodies = celestialBodies(new Date('2026-09-08T21:00:00Z'));

    for (const [planet, expected] of Object.entries(SKYFIELD_REFERENCE_2026_09_08T21)) {
      const body = bodies[planet as keyof typeof bodies];
      expect(
        Math.abs(body.sublatitudeDeg - expected.sublatitudeDeg),
        `${planet} sublatitude`,
      ).toBeLessThan(1);

      let lonDiff = body.sublongitudeDeg - expected.sublongitudeDeg;
      if (lonDiff > 180) lonDiff -= 360;
      if (lonDiff < -180) lonDiff += 360;
      expect(Math.abs(lonDiff), `${planet} sublongitude`).toBeLessThan(1);

      const distanceAu = body.distanceM / AU_M;
      const relativeError = Math.abs(distanceAu - expected.distanceAu) / expected.distanceAu;
      expect(relativeError, `${planet} distance`).toBeLessThan(0.02);
    }
  });
});
