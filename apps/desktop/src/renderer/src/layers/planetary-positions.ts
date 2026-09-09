import { daysFromEpoch, daysFromJ2000, gmstDeg, lunarBody, normaliseLongitude, obliquityDeg, solarBody } from './tides';

/**
 * Sub-points for the Sun, Moon and the seven other planets — where each body
 * is directly overhead, right now or at the scrubber's position.
 *
 * ## This is decorative, not physics — see `PROJECT_PLAN.md` §5.7
 *
 * Nothing here feeds any computation in this app. H6's tidal stress and the
 * `tides.ts` equilibrium-tide layer use the Sun and Moon only, because
 * planetary tidal influence is negligible by a huge margin — Jupiter at
 * closest approach is roughly 1/10,000,000 of the Moon's. This module exists
 * because `PROJECT_PLAN.md` §5.7 asks for the planets to be shown anyway,
 * "because they are beautiful and wanted... labeled explicitly as
 * decorative, not causal." The layer guide carries that caveat to the
 * reader; this module just computes where the dots go.
 *
 * ## Why analytic, and why Schlyter again
 *
 * Same reasoning as `subsolarPoint` (`magnetopause.ts`) and the Sun/Moon
 * series below: Cesium's ICRF transform needs asynchronously-loaded
 * Earth-orientation data, and the DE440 kernel is an Analyze-only
 * prerequisite (H6's `resolvedPath()`) that the renderer never opens
 * directly (non-negotiable #6). A sub-point here is a decorative placement,
 * not an input to anything — a low-precision series good to a few
 * arcminutes is far more than enough for a dot on a 6,371 km globe.
 *
 * The seven planets' orbital elements are Paul Schlyter's published
 * low-precision formulae (stjarnhimlen.se/comp/ppcomp.html) — the same
 * reference family already cited below for the lunar theory, extended to
 * the rest of the solar system rather than a new source. `daysFromEpoch`
 * (imported from `tides.ts`) is his epoch exactly (1999-12-31.0, JD
 * 2451543.5) — the same one the lunar series already uses, confirming this
 * module and the Moon's are reading the same reference the same way.
 *
 * ## Sun and Moon are not recomputed
 *
 * `celestialBodies` calls `tides.ts`'s existing `solarBody`/`lunarBody` and
 * reads off their sub-points — the two hardest bodies (the Moon carries a
 * dozen perturbation terms) stay single-sourced rather than duplicated here.
 *
 * ## Accuracy, measured against Skyfield/DE440
 *
 * No perturbation corrections are carried for the outer planets — the
 * two-body ellipse alone, cross-checked against the DE440 kernel already on
 * this machine for H6 (`engine/`), agrees to well under a degree for every
 * planet at the sampled instants (see `planetary-positions.test.ts`), which
 * is nothing on a globe where the whole planet subtends under 90 degrees
 * from a normal viewing distance.
 */

const DEG = Math.PI / 180;
const ASTRONOMICAL_UNIT_M = 1.495_978_707e11;

export type PlanetId = 'mercury' | 'venus' | 'mars' | 'jupiter' | 'saturn' | 'uranus' | 'neptune';
export type CelestialBodyId = 'sun' | 'moon' | PlanetId;

export interface CelestialBody {
  sublatitudeDeg: number;
  sublongitudeDeg: number;
  /** Geocentric distance, m. */
  distanceM: number;
}

/** A quantity that varies linearly with days since Schlyter's epoch. */
type Rate = readonly [base: number, perDay: number];

function evaluate([base, perDay]: Rate, d: number): number {
  return base + perDay * d;
}

interface OrbitalElements {
  /** Longitude of ascending node, deg. */
  N: Rate;
  /** Inclination, deg. */
  i: Rate;
  /** Argument of perihelion, deg. */
  w: Rate;
  /** Semi-major axis, AU. */
  a: Rate;
  eccentricity: Rate;
  /** Mean anomaly, deg. */
  M: Rate;
}

/**
 * Schlyter's elements, epoch 2000.0. Earth's own (used to turn a planet's
 * heliocentric position into a geocentric one) is the "Sun as seen from
 * Earth" pair already used by `tides.ts`'s lunar perturbation series —
 * confirmed identical there (356.0470 / 282.9404), not re-derived here.
 */
const EARTH_ELEMENTS: OrbitalElements = {
  N: [0, 0],
  i: [0, 0],
  w: [282.9404, 4.709_35e-5],
  a: [1, 0],
  eccentricity: [0.016_709, -1.151e-9],
  M: [356.047, 0.985_600_258_5],
};

const PLANET_ELEMENTS: Record<PlanetId, OrbitalElements> = {
  mercury: {
    N: [48.3313, 3.245_87e-5],
    i: [7.0047, 5.0e-8],
    w: [29.1241, 1.014_44e-5],
    a: [0.387_098, 0],
    eccentricity: [0.205_635, 5.59e-10],
    M: [168.6562, 4.092_334_436_8],
  },
  venus: {
    N: [76.6799, 2.4659e-5],
    i: [3.3946, 2.75e-8],
    w: [54.891, 1.383_74e-5],
    a: [0.723_33, 0],
    eccentricity: [0.006_773, -1.302e-9],
    M: [48.0052, 1.602_130_224_4],
  },
  mars: {
    N: [49.5574, 2.110_81e-5],
    i: [1.8497, -1.78e-8],
    w: [286.5016, 2.929_61e-5],
    a: [1.523_688, 0],
    eccentricity: [0.093_405, 2.516e-9],
    M: [18.6021, 0.524_020_776_6],
  },
  jupiter: {
    N: [100.4542, 2.768_54e-5],
    i: [1.303, -1.557e-7],
    w: [273.8777, 1.645_05e-5],
    a: [5.202_56, 0],
    eccentricity: [0.048_498, 4.469e-9],
    M: [19.895, 0.083_085_300_1],
  },
  saturn: {
    N: [113.6634, 2.3898e-5],
    i: [2.4886, -1.081e-7],
    w: [339.3939, 2.976_61e-5],
    a: [9.554_75, 0],
    eccentricity: [0.055_546, -9.499e-9],
    M: [316.967, 0.033_444_228_2],
  },
  uranus: {
    N: [74.0005, 1.3978e-5],
    i: [0.7733, 1.9e-8],
    w: [96.6612, 3.0565e-5],
    a: [19.181_71, -1.55e-8],
    eccentricity: [0.047_318, 7.45e-9],
    M: [142.5905, 0.011_725_806],
  },
  neptune: {
    N: [131.7806, 3.0173e-5],
    i: [1.77, -2.55e-7],
    w: [272.8461, -6.027e-6],
    a: [30.058_26, 3.313e-8],
    eccentricity: [0.008_606, 2.15e-9],
    M: [260.2471, 0.005_995_147],
  },
};

/** Eccentric anomaly by Newton's method. Five iterations is well past
 * convergence even at Mercury's e = 0.2056 — cheap, and this runs once per
 * body per `setTimeWindow` call, not per frame. */
function solveKepler(meanAnomalyRad: number, eccentricity: number): number {
  let e = meanAnomalyRad + eccentricity * Math.sin(meanAnomalyRad);
  for (let i = 0; i < 5; i++) {
    e -= (e - eccentricity * Math.sin(e) - meanAnomalyRad) / (1 - eccentricity * Math.cos(e));
  }
  return e;
}

/** Heliocentric ecliptic position, AU, from a two-body ellipse. */
function heliocentricEcliptic(elements: OrbitalElements, d: number): { x: number; y: number; z: number } {
  const eccentricity = evaluate(elements.eccentricity, d);
  const meanAnomaly = evaluate(elements.M, d) * DEG;
  const eccentricAnomaly = solveKepler(meanAnomaly, eccentricity);

  const a = evaluate(elements.a, d);
  const xOrbit = a * (Math.cos(eccentricAnomaly) - eccentricity);
  const yOrbit = a * Math.sqrt(1 - eccentricity * eccentricity) * Math.sin(eccentricAnomaly);
  const r = Math.hypot(xOrbit, yOrbit);
  const trueAnomaly = Math.atan2(yOrbit, xOrbit);

  const node = evaluate(elements.N, d) * DEG;
  const inclination = evaluate(elements.i, d) * DEG;
  const argument = trueAnomaly + evaluate(elements.w, d) * DEG;

  return {
    x: r * (Math.cos(node) * Math.cos(argument) - Math.sin(node) * Math.sin(argument) * Math.cos(inclination)),
    y: r * (Math.sin(node) * Math.cos(argument) + Math.cos(node) * Math.sin(argument) * Math.cos(inclination)),
    z: r * Math.sin(argument) * Math.sin(inclination),
  };
}

/** One planet's sub-point and distance. */
function planetBody(planet: PlanetId, at: Date): CelestialBody {
  const d = daysFromEpoch(at);
  // `EARTH_ELEMENTS` is "the Sun as seen from Earth" (Schlyter's own framing,
  // and the same pair `lunarBody`'s perturbation series already uses) — the
  // ellipse the SUN traces around EARTH, not Earth's own heliocentric orbit.
  // It is therefore the *negative* of Earth's heliocentric position, and
  // adding it (not subtracting it) is what turns a planet's heliocentric
  // position into a geocentric one. Getting this backwards was the first
  // draft's bug: found by cross-checking against Skyfield/DE440 and seeing
  // every inner planet's distance come out near its *inferior*-conjunction
  // value when the date called for something near superior conjunction — a
  // ~180 degree phase error that barely showed on the outer planets, whose
  // own distance swamps Earth's 1 AU either way.
  const sunFromEarth = heliocentricEcliptic(EARTH_ELEMENTS, d);
  const body = heliocentricEcliptic(PLANET_ELEMENTS[planet], d);

  const xg = body.x + sunFromEarth.x;
  const yg = body.y + sunFromEarth.y;
  const zg = body.z + sunFromEarth.z;
  const distanceAu = Math.hypot(xg, yg, zg);

  // Ecliptic to equatorial, same rotation `lunarBody` applies.
  const obliquity = obliquityDeg(daysFromJ2000(at)) * DEG;
  const yEq = yg * Math.cos(obliquity) - zg * Math.sin(obliquity);
  const zEq = yg * Math.sin(obliquity) + zg * Math.cos(obliquity);

  const rightAscensionDeg = Math.atan2(yEq, xg) / DEG;
  const declinationDeg = Math.atan2(zEq, Math.hypot(xg, yEq)) / DEG;
  const sublongitudeDeg = normaliseLongitude(rightAscensionDeg - gmstDeg(at));

  return {
    sublatitudeDeg: declinationDeg,
    sublongitudeDeg,
    distanceM: distanceAu * ASTRONOMICAL_UNIT_M,
  };
}

/** "741 million km" / "384,400 km" — km below a million, million km above.
 * Shared by the layer's own tooltip description and by `hover-target.ts`'s
 * click/hover description, so the two cannot disagree on wording. */
export function formatCelestialDistance(distanceM: number): string {
  const km = distanceM / 1000;
  if (km >= 1_000_000) return `${(km / 1_000_000).toFixed(1)} million km`;
  return `${Math.round(km).toLocaleString()} km`;
}

/** All nine bodies at one instant. Computed once per `setTimeWindow` call,
 * never per frame — see `planetary-positions-layer.ts`. */
export function celestialBodies(at: Date): Record<CelestialBodyId, CelestialBody> {
  const sun = solarBody(at);
  const moon = lunarBody(at);

  return {
    sun: { sublatitudeDeg: sun.sublatitudeDeg, sublongitudeDeg: sun.sublongitudeDeg, distanceM: sun.distanceM },
    moon: { sublatitudeDeg: moon.sublatitudeDeg, sublongitudeDeg: moon.sublongitudeDeg, distanceM: moon.distanceM },
    mercury: planetBody('mercury', at),
    venus: planetBody('venus', at),
    mars: planetBody('mars', at),
    jupiter: planetBody('jupiter', at),
    saturn: planetBody('saturn', at),
    uranus: planetBody('uranus', at),
    neptune: planetBody('neptune', at),
  };
}
