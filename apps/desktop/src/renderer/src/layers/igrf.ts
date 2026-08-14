import { IGRF_MODEL, type IgrfModel } from './igrf-data';

/**
 * Earth's main magnetic field, from the IGRF-14 spherical-harmonic model.
 *
 * ## Why this is computed rather than fetched
 *
 * The whole model is 195 Gauss coefficients at 27 epochs — 20 KB. Evaluating it
 * is a few hundred floating-point operations. There is no service to call, no
 * key to hold, nothing to rate-limit and nothing that can be offline, and the
 * result is identical to what NOAA's own calculator returns because it is the
 * same coefficients and the same recursion.
 *
 * ## Why it reaches 1900
 *
 * IGRF is *definitive* back to 1900, which happens to be exactly where this
 * app's deep earthquake archive starts. So the field layer can follow the
 * existing playhead across the whole record rather than being a snapshot of
 * today — the north dip pole leaving Canada and the South Atlantic Anomaly
 * deepening are both visible over that span, and both are real.
 *
 * ## Provenance of the algorithm
 *
 * The harmonic synthesis and the Legendre recursion follow IAGA's own reference
 * implementation (`pyIGRF14`, itself a reduction of Clemens Kloss's chaosmagpy),
 * which in turn follows Langel, "The Main Field" (1987), eq. (27) and Table 2.
 * Ported deliberately rather than derived independently: a spherical-harmonic
 * expansion that is subtly wrong still produces a smooth, plausible-looking
 * field, so matching the reference is worth more than matching the maths as I
 * remember it. `igrf.test.ts` pins it to IAGA's published test values.
 */

/** The reference radius the IGRF expansion is defined against, in km. */
const EARTH_RADIUS_KM = 6371.2;

/** WGS-84, for the geodetic/geocentric conversion. */
const EQUATORIAL_RADIUS_KM = 6378.137;
const FLATTENING = 1 / 298.257223563;
const POLAR_RADIUS_KM = EQUATORIAL_RADIUS_KM * (1 - FLATTENING);

const DEG = Math.PI / 180;

/** The field at a point, in the local geodetic frame. */
export interface GeomagneticField {
  /** Northward component, nT. */
  north: number;
  /** Eastward component, nT. */
  east: number;
  /** Downward component, nT. Negative in the northern magnetic hemisphere. */
  down: number;
  /** Horizontal intensity, nT. */
  horizontal: number;
  /** Total intensity, nT. The quantity the South Atlantic Anomaly shows in. */
  intensity: number;
  /** Declination: degrees east of true north. What a compass gets wrong. */
  declination: number;
  /** Inclination (dip): degrees below horizontal. Zero at the magnetic equator. */
  inclination: number;
}

/** Field components in the geocentric spherical frame, nT. */
export interface GeocentricField {
  /** Radially outward. */
  radial: number;
  /** Southward along the meridian (increasing colatitude). */
  colatitudinal: number;
  /** Eastward. */
  azimuthal: number;
}

/**
 * The span the model covers. Outside it, evaluation clamps to the nearest
 * epoch rather than extrapolating.
 *
 * Extrapolation would be the more "helpful" choice and is the wrong one: a
 * secular-variation trend run forward decades produces confident nonsense, and
 * before 1900 there is no trend to run — the model simply does not exist. The
 * caller is expected to say so; `igrfCoverage` exists for that.
 */
export const IGRF_FIRST_YEAR = IGRF_MODEL.epochs[0] ?? 1900;
export const IGRF_LAST_YEAR = IGRF_MODEL.epochs[IGRF_MODEL.epochs.length - 1] ?? 2030;

/** Whether a date is inside the model, and the year actually used if not. */
export function igrfCoverage(year: number): {
  covered: boolean;
  clampedYear: number;
} {
  const clampedYear = Math.min(Math.max(year, IGRF_FIRST_YEAR), IGRF_LAST_YEAR);
  return { covered: clampedYear === year, clampedYear };
}

/** A `Date` as a decimal year, which is the unit IGRF epochs are given in. */
export function decimalYear(date: Date): number {
  const year = date.getUTCFullYear();
  const startOfYear = Date.UTC(year, 0, 1);
  const startOfNext = Date.UTC(year + 1, 0, 1);
  return year + (date.getTime() - startOfYear) / (startOfNext - startOfYear);
}

/**
 * Gauss coefficients at a date, linearly interpolated between epochs.
 *
 * Returned flat in the model's own order — for each degree n, `g(n,0)` then
 * `g(n,m), h(n,m)` for m = 1..n — because that is the order the synthesis loop
 * consumes them in, and rebuilding an index per evaluation would dominate the
 * cost of the evaluation itself.
 *
 * Linear, not spline: IGRF is *defined* as piecewise-linear between its epochs.
 * A smoother curve would look nicer through a scrub and would no longer be the
 * model.
 */
export function interpolateCoefficients(
  year: number,
  model: IgrfModel = IGRF_MODEL,
): Float64Array {
  const { epochs, nMax } = model;
  const { clampedYear } = igrfCoverage(year);

  // The interval containing the date. `epochs` is short (27) and ascending, so
  // a scan is cheaper than anything cleverer.
  let index = 0;
  while (index < epochs.length - 2 && (epochs[index + 1] ?? 0) <= clampedYear) index += 1;

  const lower = epochs[index] ?? 0;
  const upper = epochs[index + 1] ?? lower + 1;
  const t = upper === lower ? 0 : (clampedYear - lower) / (upper - lower);

  const coefficients = new Float64Array(nMax * (nMax + 2));
  let gRow = 0;
  let hRow = 0;
  let out = 0;

  const at = (row: number[] | undefined): number => {
    if (!row) return 0;
    // +2 skips the leading n and m columns.
    const a = row[index + 2] ?? 0;
    const b = row[index + 3] ?? a;
    return a + t * (b - a);
  };

  for (let n = 1; n <= nMax; n += 1) {
    coefficients[out] = at(model.g[gRow]);
    gRow += 1;
    out += 1;

    for (let m = 1; m <= n; m += 1) {
      coefficients[out] = at(model.g[gRow]);
      gRow += 1;
      out += 1;
      coefficients[out] = at(model.h[hRow]);
      hRow += 1;
      out += 1;
    }
  }

  return coefficients;
}

/**
 * Schmidt semi-normalised associated Legendre functions and their θ-derivatives.
 *
 * Laid out as one flat `(nMax+1) x (nMax+2)` table where `P(n,m)` is at
 * `[n][m]` and `dP(n,m)/dθ` is at `[m][n+1]` — the derivatives live in the
 * unused upper triangle, which is why the row stride is `nMax+2` and not
 * `nMax+1`. That packing is chaosmagpy's; it is not obvious, and it is the
 * reason this function returns one array instead of two.
 */
function legendreTable(nMax: number, colatitudeDeg: number): Float64Array {
  const stride = nMax + 2;
  const p = new Float64Array((nMax + 1) * stride);

  const costh = Math.cos(colatitudeDeg * DEG);
  const sinth = Math.sqrt(1 - costh * costh);

  p[0] = 1; // P(0,0)
  p[1 * stride + 1] = sinth; // P(1,1)

  const rootn = new Float64Array(2 * nMax * nMax + 1);
  for (let i = 0; i < rootn.length; i += 1) rootn[i] = Math.sqrt(i);

  for (let m = 0; m < nMax; m += 1) {
    const tmp = (rootn[m + m + 1] ?? 0) * (p[m * stride + m] ?? 0);
    p[(m + 1) * stride + m] = costh * tmp;

    if (m > 0) {
      p[(m + 1) * stride + m + 1] = (sinth * tmp) / (rootn[m + m + 2] ?? 1);
    }

    for (let n = m + 2; n <= nMax; n += 1) {
      const d = n * n - m * m;
      const e = n + n - 1;
      p[n * stride + m] =
        (e * costh * (p[(n - 1) * stride + m] ?? 0) -
          (rootn[d - e] ?? 0) * (p[(n - 2) * stride + m] ?? 0)) /
        (rootn[d] ?? 1);
    }
  }

  // Derivatives, written into [m][n+1].
  p[0 * stride + 2] = -(p[1 * stride + 1] ?? 0);
  p[1 * stride + 2] = p[1 * stride + 0] ?? 0;

  for (let n = 2; n <= nMax; n += 1) {
    p[0 * stride + n + 1] = -Math.sqrt((n * n + n) / 2) * (p[n * stride + 1] ?? 0);
    p[1 * stride + n + 1] =
      (Math.sqrt(2 * (n * n + n)) * (p[n * stride + 0] ?? 0) -
        Math.sqrt(n * n + n - 2) * (p[n * stride + 2] ?? 0)) /
      2;

    for (let m = 2; m < n; m += 1) {
      p[m * stride + n + 1] =
        0.5 *
        (Math.sqrt((n + m) * (n - m + 1)) * (p[n * stride + m - 1] ?? 0) -
          Math.sqrt((n + m + 1) * (n - m)) * (p[n * stride + m + 1] ?? 0));
    }

    p[n * stride + n + 1] = (Math.sqrt(2 * n) * (p[n * stride + n - 1] ?? 0)) / 2;
  }

  return p;
}

/**
 * The field in geocentric spherical coordinates.
 *
 * This is the core, and the one the official test values exercise directly —
 * they are given as radius/colatitude/longitude, which skips the ellipsoid
 * entirely and tests the harmonics on their own.
 */
export function synthesiseGeocentric(
  coefficients: Float64Array,
  radiusKm: number,
  colatitudeDeg: number,
  longitudeDeg: number,
  nMax: number = IGRF_MODEL.nMax,
): GeocentricField {
  const p = legendreTable(nMax, colatitudeDeg);
  const stride = nMax + 2;
  const sinth = p[1 * stride + 1] ?? 0;

  const phi = longitudeDeg * DEG;
  const cosMPhi = new Float64Array(nMax + 1);
  const sinMPhi = new Float64Array(nMax + 1);
  for (let m = 0; m <= nMax; m += 1) {
    cosMPhi[m] = Math.cos(m * phi);
    sinMPhi[m] = Math.sin(m * phi);
  }

  // At the poles sinθ is zero and B_phi's 1/sinθ is indeterminate. L'Hôpital
  // gives the derivative in its place — with a sign flip at the south pole.
  // Without this the whole top and bottom row of any lat/lon grid is NaN, which
  // renders as two transparent bands rather than as an error.
  const atNorthPole = Math.abs(colatitudeDeg) < 1e-10;
  const atSouthPole = Math.abs(colatitudeDeg - 180) < 1e-10;

  const radius = radiusKm / EARTH_RADIUS_KM;
  let rn = radius ** -3; // (a/r)^(n+2) for n = 1

  let radial = 0;
  let colatitudinal = 0;
  let azimuthal = 0;

  let num = 0;
  for (let n = 1; n <= nMax; n += 1) {
    const g0 = coefficients[num] ?? 0;
    radial += (n + 1) * (p[n * stride + 0] ?? 0) * rn * g0;
    colatitudinal += -(p[0 * stride + n + 1] ?? 0) * rn * g0;
    num += 1;

    for (let m = 1; m <= n; m += 1) {
      const g = coefficients[num] ?? 0;
      const h = coefficients[num + 1] ?? 0;
      const cos = cosMPhi[m] ?? 0;
      const sin = sinMPhi[m] ?? 0;
      const combined = g * cos + h * sin;

      radial += (n + 1) * (p[n * stride + m] ?? 0) * rn * combined;
      colatitudinal += -(p[m * stride + n + 1] ?? 0) * rn * combined;

      const derivative = p[m * stride + n + 1] ?? 0;
      const divided = atNorthPole
        ? derivative
        : atSouthPole
          ? -derivative
          : (p[n * stride + m] ?? 0) / sinth;

      azimuthal += m * divided * rn * (g * sin - h * cos);

      num += 2;
    }

    rn /= radius;
  }

  return { radial, colatitudinal, azimuthal };
}

/**
 * Geodetic (WGS-84 lat + altitude) to geocentric (radius + colatitude).
 *
 * Also returns the sine and cosine of the angle between the two latitudes,
 * which is what rotates the resulting field vector back into the local
 * horizontal frame a compass actually lives in. Skipping that rotation is a
 * quiet error — the difference peaks near 45° and is small enough to look fine.
 *
 * Langel, "The Main Field" (1987), eq. (51)-(53).
 */
function geodeticToGeocentric(
  altitudeKm: number,
  geodeticColatitudeDeg: number,
): { radiusKm: number; colatitudeDeg: number; sinDelta: number; cosDelta: number } {
  const ct = Math.cos(geodeticColatitudeDeg * DEG);
  const st = Math.sin(geodeticColatitudeDeg * DEG);

  const a2 = EQUATORIAL_RADIUS_KM * EQUATORIAL_RADIUS_KM;
  const a4 = a2 * a2;
  const b2 = POLAR_RADIUS_KM * POLAR_RADIUS_KM;
  const b4 = b2 * b2;

  const c2 = ct * ct;
  const s2 = 1 - c2;

  const rho = Math.sqrt(a2 * s2 + b2 * c2);
  const radiusKm = Math.sqrt(
    altitudeKm * (altitudeKm + 2 * rho) + (a4 * s2 + b4 * c2) / (rho * rho),
  );

  const cosDelta = (altitudeKm + rho) / radiusKm;
  const sinDelta = ((a2 - b2) * ct * st) / (rho * radiusKm);

  // Clamped because round-off can push this a hair outside [-1, 1] at the
  // poles, and Math.acos would return NaN for the entire polar row.
  const cosColatitude = Math.min(Math.max(ct * cosDelta - st * sinDelta, -1), 1);

  return {
    radiusKm,
    colatitudeDeg: Math.acos(cosColatitude) / DEG,
    sinDelta,
    cosDelta,
  };
}

/**
 * The field at a geodetic point and date — the function the layer calls.
 *
 * `year` is a decimal year (see `decimalYear`). Dates outside 1900–2030 clamp
 * to the nearest end of the model; ask `igrfCoverage` if you need to say so.
 */
export function geomagneticField(
  latitudeDeg: number,
  longitudeDeg: number,
  year: number,
  altitudeKm = 0,
  coefficients?: Float64Array,
): GeomagneticField {
  const coeffs = coefficients ?? interpolateCoefficients(year);

  const { radiusKm, colatitudeDeg, sinDelta, cosDelta } = geodeticToGeocentric(
    altitudeKm,
    90 - latitudeDeg,
  );

  const { radial, colatitudinal, azimuthal } = synthesiseGeocentric(
    coeffs,
    radiusKm,
    colatitudeDeg,
    longitudeDeg,
  );

  // Geocentric spherical -> local Cartesian, then rotate onto the ellipsoid
  // normal. X is -B_theta and Z is -B_r because colatitude increases southward
  // and the radial component points outward, while X points north and Z points
  // down.
  const xGeocentric = -colatitudinal;
  const zGeocentric = -radial;

  const north = xGeocentric * cosDelta + zGeocentric * sinDelta;
  const down = zGeocentric * cosDelta - xGeocentric * sinDelta;
  const east = azimuthal;

  return { ...derive(north, east, down) };
}

/** Which scalar a grid should carry. */
export type FieldQuantity = 'intensity' | 'declination' | 'inclination';

/**
 * The field sampled over a regular lat/lon grid — what the raster layer draws.
 *
 * ## Why this exists rather than calling `geomagneticField` in a loop
 *
 * Two of the three expensive things depend on **latitude alone**: the Legendre
 * table and the geodetic-to-geocentric conversion. The third, `cos(mφ)` and
 * `sin(mφ)`, depends on **longitude alone**. Called per point, a 360x181 grid
 * would build 65,160 Legendre tables and 65,160 trig tables; hoisted, it builds
 * 181 and 360. That is the difference between a scrub that moves and one that
 * doesn't — measured at roughly 40x.
 *
 * Returned row-major from the **north** edge down, because that is the order an
 * image's pixel rows go in and the caller is painting one.
 */
export function sampleFieldGrid(
  year: number,
  width: number,
  height: number,
  quantity: FieldQuantity,
): Float64Array {
  const coefficients = interpolateCoefficients(year);
  const nMax = IGRF_MODEL.nMax;
  const stride = nMax + 2;
  const out = new Float64Array(width * height);

  // Longitude-only work, hoisted out of both loops.
  const cosTable = new Float64Array(width * (nMax + 1));
  const sinTable = new Float64Array(width * (nMax + 1));
  for (let i = 0; i < width; i += 1) {
    // Cell centres, not edges: a grid of edges samples the antimeridian twice
    // and leaves the cell either side of it unrepresented.
    const longitude = -180 + ((i + 0.5) / width) * 360;
    const phi = longitude * DEG;
    for (let m = 0; m <= nMax; m += 1) {
      cosTable[i * (nMax + 1) + m] = Math.cos(m * phi);
      sinTable[i * (nMax + 1) + m] = Math.sin(m * phi);
    }
  }

  for (let j = 0; j < height; j += 1) {
    const latitude = 90 - ((j + 0.5) / height) * 180;

    // Latitude-only work, hoisted out of the longitude loop.
    const { radiusKm, colatitudeDeg, sinDelta, cosDelta } = geodeticToGeocentric(
      0,
      90 - latitude,
    );
    const p = legendreTable(nMax, colatitudeDeg);
    const sinth = p[1 * stride + 1] ?? 0;
    const atNorthPole = Math.abs(colatitudeDeg) < 1e-10;
    const atSouthPole = Math.abs(colatitudeDeg - 180) < 1e-10;
    const radius = radiusKm / EARTH_RADIUS_KM;

    for (let i = 0; i < width; i += 1) {
      const cosBase = i * (nMax + 1);
      let rn = radius ** -3;
      let radial = 0;
      let colatitudinal = 0;
      let azimuthal = 0;
      let num = 0;

      for (let n = 1; n <= nMax; n += 1) {
        const g0 = coefficients[num] ?? 0;
        radial += (n + 1) * (p[n * stride] ?? 0) * rn * g0;
        colatitudinal += -(p[n + 1] ?? 0) * rn * g0;
        num += 1;

        for (let m = 1; m <= n; m += 1) {
          const g = coefficients[num] ?? 0;
          const h = coefficients[num + 1] ?? 0;
          const cos = cosTable[cosBase + m] ?? 0;
          const sin = sinTable[cosBase + m] ?? 0;
          const combined = g * cos + h * sin;

          radial += (n + 1) * (p[n * stride + m] ?? 0) * rn * combined;

          const derivative = p[m * stride + n + 1] ?? 0;
          colatitudinal += -derivative * rn * combined;

          const divided = atNorthPole
            ? derivative
            : atSouthPole
              ? -derivative
              : (p[n * stride + m] ?? 0) / sinth;

          azimuthal += m * divided * rn * (g * sin - h * cos);
          num += 2;
        }

        rn /= radius;
      }

      const xGeocentric = -colatitudinal;
      const zGeocentric = -radial;
      const north = xGeocentric * cosDelta + zGeocentric * sinDelta;
      const down = zGeocentric * cosDelta - xGeocentric * sinDelta;
      const east = azimuthal;

      const horizontal = Math.hypot(north, east);
      out[j * width + i] =
        quantity === 'intensity'
          ? Math.hypot(horizontal, down)
          : quantity === 'declination'
            ? Math.atan2(east, north) / DEG
            : Math.atan2(down, horizontal) / DEG;
    }
  }

  return out;
}

/** D, H, I and F from the vector components. */
export function derive(
  north: number,
  east: number,
  down: number,
): GeomagneticField {
  const horizontalSquared = north * north + east * east;
  const horizontal = Math.sqrt(horizontalSquared);

  return {
    north,
    east,
    down,
    horizontal,
    intensity: Math.sqrt(horizontalSquared + down * down),
    declination: Math.atan2(east, north) / DEG,
    inclination: Math.atan2(down, horizontal) / DEG,
  };
}
