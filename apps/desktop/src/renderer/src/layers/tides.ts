/**
 * Lunisolar tidal potential — the solid-Earth tide, computed rather than fetched.
 *
 * The Moon and Sun pull harder on the near side of the Earth than on its centre,
 * and harder on the centre than on the far side. That *difference* is the tidal
 * force, and its potential is what this module evaluates. The familiar
 * consequence is two bulges — one under the body, one opposite it — which is why
 * there are two high tides a day rather than one.
 *
 * ## What is displayed, and why it is a height
 *
 * The natural output is a potential in m^2/s^2, which means nothing to anyone.
 * Divided by `g` it becomes the **equilibrium tide**: the height the ocean
 * surface would take if it could respond instantly and completely. That is a
 * real, interpretable number in centimetres, and it is the standard way this
 * field is drawn.
 *
 * It is emphatically **not a tide prediction.** Real ocean tides are this
 * forcing filtered through basin resonance, coastline shape and friction, which
 * is why the Bay of Fundy sees 16 m and the Mediterranean sees centimetres.
 * The equilibrium tide is the *driving* field, identical everywhere on the
 * planet in form and lagging nothing.
 *
 * ## Why this is not H6, and must not be mistaken for it
 *
 * H6 registers the tidal **stress tensor resolved onto fault geometry**. Stress
 * is a tensor; turning it into a number requires a plane to resolve onto, and
 * that needs a fault orientation this app does not yet store. The scalar here is
 * the *potential*, which is defined everywhere without reference to any fault
 * and makes no claim about failure. See the layer guide.
 *
 * ## Why the ephemeris is analytic
 *
 * Same reasoning as `subsolarPoint` in `magnetopause.ts`, which this module
 * deliberately mirrors: Cesium's ICRF transform needs asynchronously-loaded
 * Earth-orientation data and can be `undefined` on early frames, which is a lot
 * of failure surface for a quantity a low-precision series gets to within
 * arcminutes. A tidal bulge is thousands of kilometres across; an arcminute is
 * nothing.
 *
 * **Distance matters far more than direction here**, and that is the one place
 * precision was actually spent. The potential goes as 1/d^3, and the Moon's
 * distance varies 356,400-406,700 km over an anomalistic month — 5.5% in
 * distance is **17% in amplitude**. A circular-orbit Moon would be wrong by
 * that much twice a month, so the elliptical orbit and the two main distance
 * perturbations are carried rather than dropped.
 *
 * Series after Schlyter's reduction of the standard lunar theory.
 * Skyfield/DE440 is for the registered H6 analysis in the Python engine, where
 * precision is worth paying for; it is not needed to draw this.
 */

/** Mean Earth radius, m. */
const EARTH_RADIUS_M = 6_371_000;

/** Standard gravity, m/s^2 — turns a potential into a height. */
const STANDARD_GRAVITY = 9.806_65;

/** Gravitational parameters, m^3/s^2 (IAU 2015 / DE440 values). */
const GM_MOON = 4.902_800_66e12;
const GM_SUN = 1.327_124_400_18e20;

/** m */
const ASTRONOMICAL_UNIT = 1.495_978_707e11;

const DEG = Math.PI / 180;

/** Days from the 1999-12-31.0 epoch the lunar series is referenced to. */
function daysFromEpoch(at: Date): number {
  return at.getTime() / 86_400_000 - 10_956;
}

/** Days from J2000.0 — what the solar series and GMST use. */
function daysFromJ2000(at: Date): number {
  return at.getTime() / 86_400_000 - 10_957.5;
}

/** Greenwich mean sidereal time, degrees. */
function gmstDeg(at: Date): number {
  return (280.460_618_37 + 360.985_647_366_29 * daysFromJ2000(at)) % 360;
}

/** To (-180, 180]. */
export function normaliseLongitude(deg: number): number {
  let value = deg % 360;
  if (value > 180) value -= 360;
  if (value <= -180) value += 360;
  return value;
}

/**
 * One body's contribution to the tide.
 *
 * The direction is a unit vector in **Earth-fixed** coordinates — x through
 * (0N, 0E), z through the north pole — so a grid cell's contribution is a dot
 * product and nothing more. That is the whole reason this is precomputed per
 * frame rather than per cell: see `sampleTideGrid`.
 */
export interface TidalBody {
  x: number;
  y: number;
  z: number;
  /** Geocentric distance, m. */
  distanceM: number;
  /** Gravitational parameter, m^3/s^2. */
  gm: number;
  /** Sub-body point — where the body is directly overhead. */
  sublatitudeDeg: number;
  sublongitudeDeg: number;
}

function bodyFromEquatorial(
  rightAscensionDeg: number,
  declinationDeg: number,
  distanceM: number,
  gm: number,
  at: Date,
): TidalBody {
  const sublongitudeDeg = normaliseLongitude(rightAscensionDeg - gmstDeg(at));
  const latRad = declinationDeg * DEG;
  const lonRad = sublongitudeDeg * DEG;
  const cosLat = Math.cos(latRad);

  return {
    x: cosLat * Math.cos(lonRad),
    y: cosLat * Math.sin(lonRad),
    z: Math.sin(latRad),
    distanceM,
    gm,
    sublatitudeDeg: declinationDeg,
    sublongitudeDeg,
  };
}

/** Obliquity of the ecliptic, degrees. */
function obliquityDeg(d: number): number {
  return 23.4393 - 3.563e-7 * d;
}

/**
 * The Sun, geocentric.
 *
 * Direction agrees with `magnetopause.ts`'s `subsolarPoint` — the two are
 * pinned against each other by a test rather than sharing code, because this
 * one additionally needs the distance and the two were derived independently.
 */
export function solarBody(at: Date): TidalBody {
  const d = daysFromJ2000(at);

  const meanLongitude = 280.46 + 0.985_647_4 * d;
  const meanAnomalyDeg = 357.528 + 0.985_600_3 * d;
  const meanAnomaly = meanAnomalyDeg * DEG;

  const eclipticLongitudeDeg =
    meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly);
  const eclipticLongitude = eclipticLongitudeDeg * DEG;

  // Low-precision radius vector, AU. Good to about 1e-5 AU, which is four
  // orders below the eccentricity variation it exists to capture.
  const distanceAu =
    1.000_14 - 0.016_71 * Math.cos(meanAnomaly) - 0.000_14 * Math.cos(2 * meanAnomaly);

  const obliquity = obliquityDeg(d) * DEG;
  const declinationDeg =
    Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude)) / DEG;
  const rightAscensionDeg =
    Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude)) /
    DEG;

  return bodyFromEquatorial(
    rightAscensionDeg,
    declinationDeg,
    distanceAu * ASTRONOMICAL_UNIT,
    GM_SUN,
    at,
  );
}

/**
 * The Moon, geocentric.
 *
 * The elliptical orbit is solved properly and the dominant perturbations are
 * carried, because the tide goes as 1/d^3 and the Moon's distance is what moves
 * most. The longitude perturbations matter less for the tide than the distance
 * ones do, but they are cheap and they are what keeps the sublunar point
 * honest.
 */
export function lunarBody(at: Date): TidalBody {
  const d = daysFromEpoch(at);

  // Orbital elements.
  const nodeDeg = 125.1228 - 0.052_953_808_3 * d;
  const inclinationDeg = 5.1454;
  const perigeeDeg = 318.0634 + 0.164_357_322_3 * d;
  const semiMajorRe = 60.2666;
  const eccentricity = 0.054_9;
  const meanAnomalyDeg = 115.3654 + 13.064_992_950_9 * d;

  // Kepler, iterated. Two refinements are plenty at e = 0.055.
  const meanAnomaly = meanAnomalyDeg * DEG;
  let eccentricAnomaly =
    meanAnomaly + eccentricity * Math.sin(meanAnomaly) * (1 + eccentricity * Math.cos(meanAnomaly));
  for (let i = 0; i < 3; i++) {
    eccentricAnomaly -=
      (eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly) - meanAnomaly) /
      (1 - eccentricity * Math.cos(eccentricAnomaly));
  }

  const xOrbit = semiMajorRe * (Math.cos(eccentricAnomaly) - eccentricity);
  const yOrbit =
    semiMajorRe * Math.sqrt(1 - eccentricity * eccentricity) * Math.sin(eccentricAnomaly);
  let radiusRe = Math.hypot(xOrbit, yOrbit);
  const trueAnomaly = Math.atan2(yOrbit, xOrbit);

  // Orbital plane to ecliptic.
  const node = nodeDeg * DEG;
  const inclination = inclinationDeg * DEG;
  const argument = trueAnomaly + perigeeDeg * DEG;
  const xEcl =
    radiusRe * (Math.cos(node) * Math.cos(argument) - Math.sin(node) * Math.sin(argument) * Math.cos(inclination));
  const yEcl =
    radiusRe * (Math.sin(node) * Math.cos(argument) + Math.cos(node) * Math.sin(argument) * Math.cos(inclination));
  const zEcl = radiusRe * Math.sin(argument) * Math.sin(inclination);

  let eclipticLongitudeDeg = Math.atan2(yEcl, xEcl) / DEG;
  let eclipticLatitudeDeg = Math.atan2(zEcl, Math.hypot(xEcl, yEcl)) / DEG;

  // Perturbations. The named three dominate: evection (the Sun stretching the
  // orbit), variation, and the annual equation.
  const solarMeanAnomalyDeg = 356.047 + 0.985_600_258_5 * d;
  const solarPerigeeDeg = 282.9404 + 4.709_35e-5 * d;
  const solarMeanLongitudeDeg = solarMeanAnomalyDeg + solarPerigeeDeg;
  const lunarMeanLongitudeDeg = nodeDeg + perigeeDeg + meanAnomalyDeg;
  const elongationDeg = lunarMeanLongitudeDeg - solarMeanLongitudeDeg;
  const argumentOfLatitudeDeg = lunarMeanLongitudeDeg - nodeDeg;

  const Mm = meanAnomalyDeg * DEG;
  const Ms = solarMeanAnomalyDeg * DEG;
  const D = elongationDeg * DEG;
  const F = argumentOfLatitudeDeg * DEG;

  eclipticLongitudeDeg +=
    -1.274 * Math.sin(Mm - 2 * D) + // evection
    0.658 * Math.sin(2 * D) + // variation
    -0.186 * Math.sin(Ms) + // annual equation
    -0.059 * Math.sin(2 * Mm - 2 * D) +
    -0.057 * Math.sin(Mm - 2 * D + Ms) +
    0.053 * Math.sin(Mm + 2 * D) +
    0.046 * Math.sin(2 * D - Ms) +
    0.041 * Math.sin(Mm - Ms) +
    -0.035 * Math.sin(D) + // parallactic equation
    -0.031 * Math.sin(Mm + Ms) +
    -0.015 * Math.sin(2 * F - 2 * D) +
    0.011 * Math.sin(Mm - 4 * D);

  eclipticLatitudeDeg +=
    -0.173 * Math.sin(F - 2 * D) +
    -0.055 * Math.sin(Mm - F - 2 * D) +
    -0.046 * Math.sin(Mm + F - 2 * D) +
    0.033 * Math.sin(F + 2 * D) +
    0.017 * Math.sin(2 * Mm + F);

  // The two that matter, being the ones that move 1/d^3.
  radiusRe += -0.58 * Math.cos(Mm - 2 * D) - 0.46 * Math.cos(2 * D);

  // Ecliptic to equatorial.
  const obliquity = obliquityDeg(daysFromJ2000(at)) * DEG;
  const lonRad = eclipticLongitudeDeg * DEG;
  const latRad = eclipticLatitudeDeg * DEG;
  const cosLat = Math.cos(latRad);
  const xe = cosLat * Math.cos(lonRad);
  const ye = cosLat * Math.sin(lonRad);
  const ze = Math.sin(latRad);

  const yEq = ye * Math.cos(obliquity) - ze * Math.sin(obliquity);
  const zEq = ye * Math.sin(obliquity) + ze * Math.cos(obliquity);

  const rightAscensionDeg = Math.atan2(yEq, xe) / DEG;
  const declinationDeg = Math.atan2(zEq, Math.hypot(xe, yEq)) / DEG;

  return bodyFromEquatorial(
    rightAscensionDeg,
    declinationDeg,
    radiusRe * EARTH_RADIUS_M,
    GM_MOON,
    at,
  );
}

/** Both bodies at one instant. Computed once per frame, never per cell. */
export function tidalBodies(at: Date): { sun: TidalBody; moon: TidalBody } {
  return { sun: solarBody(at), moon: lunarBody(at) };
}

/**
 * The degree-2 tidal potential of one body, as an equilibrium height in metres.
 *
 * `(3cos^2(psi) - 1) / 2` is the Legendre polynomial that produces the two
 * bulges: maximum directly under the body (psi = 0) *and* directly opposite it
 * (psi = 180), minimum on the great circle 90 degrees away.
 */
function bodyHeightM(body: TidalBody, cosPsi: number): number {
  return (tidalAmplitudeM(body) * (3 * cosPsi * cosPsi - 1)) / 2;
}

/**
 * A body's tidal amplitude — the height directly beneath it, in metres.
 *
 * At mean distance this is 0.357 m for the Moon and 0.164 m for the Sun, a
 * ratio of 0.459. Both move with distance as 1/d^3, so the Moon's own
 * contribution swings 0.30-0.45 m between apogee and perigee.
 */
export function tidalAmplitudeM(body: TidalBody): number {
  return (
    (body.gm * EARTH_RADIUS_M * EARTH_RADIUS_M) /
    (body.distanceM * body.distanceM * body.distanceM) /
    STANDARD_GRAVITY
  );
}

/** Equilibrium tide height at one point, metres. Sun and Moon summed. */
export function equilibriumTideM(
  bodies: { sun: TidalBody; moon: TidalBody },
  latitudeDeg: number,
  longitudeDeg: number,
): number {
  const latRad = latitudeDeg * DEG;
  const lonRad = longitudeDeg * DEG;
  const cosLat = Math.cos(latRad);
  const x = cosLat * Math.cos(lonRad);
  const y = cosLat * Math.sin(lonRad);
  const z = Math.sin(latRad);

  return (
    bodyHeightM(bodies.sun, x * bodies.sun.x + y * bodies.sun.y + z * bodies.sun.z) +
    bodyHeightM(bodies.moon, x * bodies.moon.x + y * bodies.moon.y + z * bodies.moon.z)
  );
}

/**
 * The whole grid, row-major from the north edge — the shape the raster wants.
 *
 * **Per-row work is hoisted, the same lesson `sampleFieldGrid` records.** The
 * cell's unit vector splits into a latitude part and a longitude part; computed
 * per cell, a 360x181 grid would evaluate 65,160 sin/cos pairs of each. Hoisted,
 * it is one per row and one per column. The bodies themselves are evaluated
 * once for the whole grid rather than once per cell, which is the larger saving
 * — the lunar series is far more expensive than a dot product.
 */
export function sampleTideGrid(
  at: Date,
  stepDeg: number,
): { values: Float64Array; width: number; height: number; bodies: ReturnType<typeof tidalBodies> } {
  const bodies = tidalBodies(at);
  const width = Math.round(360 / stepDeg);
  const height = Math.round(180 / stepDeg) + 1;
  const values = new Float64Array(width * height);

  // Longitude-dependent parts, once per column.
  const cosLon = new Float64Array(width);
  const sinLon = new Float64Array(width);
  for (let i = 0; i < width; i++) {
    const lonRad = (-180 + i * stepDeg) * DEG;
    cosLon[i] = Math.cos(lonRad);
    sinLon[i] = Math.sin(lonRad);
  }

  const sunAmplitude =
    (bodies.sun.gm * EARTH_RADIUS_M * EARTH_RADIUS_M) /
    (bodies.sun.distanceM ** 3 * STANDARD_GRAVITY);
  const moonAmplitude =
    (bodies.moon.gm * EARTH_RADIUS_M * EARTH_RADIUS_M) /
    (bodies.moon.distanceM ** 3 * STANDARD_GRAVITY);

  for (let row = 0; row < height; row++) {
    const latRad = (90 - row * stepDeg) * DEG;
    const cosLat = Math.cos(latRad);
    const sinLat = Math.sin(latRad);
    const rowOffset = row * width;

    for (let i = 0; i < width; i++) {
      const x = cosLat * cosLon[i]!;
      const y = cosLat * sinLon[i]!;

      const cosSun = x * bodies.sun.x + y * bodies.sun.y + sinLat * bodies.sun.z;
      const cosMoon = x * bodies.moon.x + y * bodies.moon.y + sinLat * bodies.moon.z;

      values[rowOffset + i] =
        (sunAmplitude * (3 * cosSun * cosSun - 1)) / 2 +
        (moonAmplitude * (3 * cosMoon * cosMoon - 1)) / 2;
    }
  }

  return { values, width, height, bodies };
}
