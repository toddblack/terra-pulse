import type { TidalBody } from './tides';

/**
 * Tidal shear stress resolved onto a fault plane.
 *
 * A direct port of H6's physics
 * (`engine/terra_pulse_engine/pipeline/tides.py`), reused here for a
 * different purpose: not a registered hypothesis test, but a per-click
 * readout in the fault inspector answering "how hard is the tide currently
 * pulling on this one mapped fault's plane?" H6 itself resolves stress onto
 * Global CMT earthquake focal mechanisms, never onto GEM's mapped fault
 * traces — this module is what makes the GEM-trace version possible, now
 * that dip and rake are vendored (see `vendor-gem-faults.mjs`).
 *
 * ## The chain, exactly mirroring the Python reference
 *
 * 1. **Tidal tensor.** For a body of mass parameter GM at Earth-fixed
 *    direction n̂ and distance d: `T = (GM/d³)(3 n̂n̂ᵀ − I)`. Sun and Moon add
 *    linearly. `direction`/`distanceM` come straight from `tides.ts`'s
 *    `TidalBody` — already Earth-fixed, already exactly what this needs, so
 *    nothing here recomputes an ephemeris.
 * 2. **Into the local frame.** `T′ = R T Rᵀ`, R's rows the site's east/
 *    north/up unit vectors.
 * 3. **Strain, via Love numbers h2/l2**, including the surface-curvature
 *    correction (the `−T′₃₃` terms) that a flat Cartesian second derivative
 *    would silently drop.
 * 4. **Plane stress** at a free surface (σ_UU = σ_EU = σ_NU = 0).
 * 5. **Resolve** `τ = ûᵀ σ n̂`, with n̂/û the fault normal and slip direction
 *    from strike/dip/rake (Aki & Richards convention, matching Global CMT
 *    and GEM's own dip/rake measurement).
 *
 * Same constants as the Python module — Love numbers (IERS 2010 nominal),
 * mean Earth radius/gravity, and a Poisson-solid crust (λ=μ=3.0e10 Pa) — so a
 * result here means the same thing a Python-computed one does.
 *
 * ## Magnitude only, and why
 *
 * `resolvedShearPa` returns `τ`, signed, matching the Python reference
 * exactly. The **caller** (`NearestFault.tsx`) takes its absolute value
 * before display. That split exists because the *sign* depends on strike
 * being read in the Aki & Richards sense (dip 90° clockwise of strike) —
 * and `faultStrikeDeg` (`fault-association.ts`) derives strike from a mapped
 * trace's arbitrary digitisation order, with no way to know if that matches
 * the convention GEM's own dip/rake were measured against. The magnitude is
 * orientation-ambiguity-free; the sign, from this pipeline, might not be.
 * Not ported: the Python module's `shear_coefficients` optimisation, which
 * collapses the whole chain into one matrix product to amortise millions of
 * Monte Carlo instants. This runs once per click — there is nothing to
 * amortise, and the step-by-step form is the more readable one to verify
 * against the reference.
 *
 * ## What this is not
 *
 * No ocean tide loading, and free-surface stress applied regardless of the
 * fault's actual depth — the same two simplifications `tides.py`'s own
 * docstring flags for H6, which apply here unchanged.
 */

const EARTH_RADIUS_M = 6.371e6;
const SURFACE_GRAVITY = 9.806_65;
const LOVE_H2 = 0.6078;
const LOVE_L2 = 0.0847;
const LAME_LAMBDA = 3.0e10;
const SHEAR_MODULUS = 3.0e10;

const DEG = Math.PI / 180;

type Vec3 = readonly [number, number, number];
type Mat3 = readonly [Vec3, Vec3, Vec3];

function transpose(m: Mat3): Mat3 {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

function matMul(a: Mat3, b: Mat3): Mat3 {
  const row = (i: 0 | 1 | 2): Vec3 => [
    a[i][0] * b[0][0] + a[i][1] * b[1][0] + a[i][2] * b[2][0],
    a[i][0] * b[0][1] + a[i][1] * b[1][1] + a[i][2] * b[2][1],
    a[i][0] * b[0][2] + a[i][1] * b[1][2] + a[i][2] * b[2][2],
  ];
  return [row(0), row(1), row(2)];
}

function addMat3(a: Mat3, b: Mat3): Mat3 {
  return [
    [a[0][0] + b[0][0], a[0][1] + b[0][1], a[0][2] + b[0][2]],
    [a[1][0] + b[1][0], a[1][1] + b[1][1], a[1][2] + b[1][2]],
    [a[2][0] + b[2][0], a[2][1] + b[2][1], a[2][2] + b[2][2]],
  ];
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function matVec(m: Mat3, v: Vec3): Vec3 {
  return [dot3(m[0], v), dot3(m[1], v), dot3(m[2], v)];
}

/** λ′ = 2λμ/(λ+2μ), the effective λ when σ_UU is held at zero. */
function planeStressLambdaPrime(): number {
  return (2 * LAME_LAMBDA * SHEAR_MODULUS) / (LAME_LAMBDA + 2 * SHEAR_MODULUS);
}

/** ECEF → local (east, north, up), as a 3x3 whose rows are those axes —
 * `enu_rotation`. */
export function enuRotationMatrix(latitudeDeg: number, longitudeDeg: number): Mat3 {
  const lat = latitudeDeg * DEG;
  const lon = longitudeDeg * DEG;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  return [
    [-sinLon, cosLon, 0],
    [-sinLat * cosLon, -sinLat * sinLon, cosLat],
    [cosLat * cosLon, cosLat * sinLon, sinLat],
  ];
}

/** Fault normal and slip direction, in ENU — `fault_vectors`. Aki & Richards
 * convention (defined in north/east/down; converted to ENU here so there is
 * one place to get that conversion wrong). */
export function faultVectors(
  strikeDeg: number,
  dipDeg: number,
  rakeDeg: number,
): { normal: Vec3; slip: Vec3 } {
  const strike = strikeDeg * DEG;
  const dip = dipDeg * DEG;
  const rake = rakeDeg * DEG;

  const sinS = Math.sin(strike);
  const cosS = Math.cos(strike);
  const sinD = Math.sin(dip);
  const cosD = Math.cos(dip);
  const sinR = Math.sin(rake);
  const cosR = Math.cos(rake);

  const normalNed: Vec3 = [-sinD * sinS, sinD * cosS, -cosD];
  const slipNed: Vec3 = [
    cosR * cosS + cosD * sinR * sinS,
    cosR * sinS - cosD * sinR * cosS,
    -sinR * sinD,
  ];

  const toEnu = (v: Vec3): Vec3 => [v[1], v[0], -v[2]];
  return { normal: toEnu(normalNed), slip: toEnu(slipNed) };
}

/** T = (GM/d³)(3n̂n̂ᵀ − I) — `tidal_tensor`. `direction` must be unit length,
 * Earth-fixed (exactly what `TidalBody.{x,y,z}` already is). */
export function tidalTensor(direction: Vec3, distanceM: number, gm: number): Mat3 {
  const factor = gm / distanceM ** 3;
  const [nx, ny, nz] = direction;
  return [
    [factor * (3 * nx * nx - 1), factor * 3 * nx * ny, factor * 3 * nx * nz],
    [factor * 3 * ny * nx, factor * (3 * ny * ny - 1), factor * 3 * ny * nz],
    [factor * 3 * nz * nx, factor * 3 * nz * ny, factor * (3 * nz * nz - 1)],
  ];
}

/** The tidal stress tensor in local ENU, from an ECEF tidal tensor —
 * `local_stress_tensor`. Includes the surface-curvature correction (the
 * `−t33` terms below) that a flat Cartesian second derivative would drop. */
export function localStressTensor(tensorEcef: Mat3, latitudeDeg: number, longitudeDeg: number): Mat3 {
  const rotation = enuRotationMatrix(latitudeDeg, longitudeDeg);
  const local = matMul(matMul(rotation, tensorEcef), transpose(rotation));

  const t11 = local[0][0];
  const t22 = local[1][1];
  const t33 = local[2][2];
  const t12 = local[0][1];

  const scale = EARTH_RADIUS_M / SURFACE_GRAVITY;
  const strainEE = scale * (LOVE_L2 * (t11 - t33) + 0.5 * LOVE_H2 * t33);
  const strainNN = scale * (LOVE_L2 * (t22 - t33) + 0.5 * LOVE_H2 * t33);
  const strainEN = scale * LOVE_L2 * t12;

  const dilatation = strainEE + strainNN;
  const lambdaPrime = planeStressLambdaPrime();

  const sigmaEE = 2 * SHEAR_MODULUS * strainEE + lambdaPrime * dilatation;
  const sigmaNN = 2 * SHEAR_MODULUS * strainNN + lambdaPrime * dilatation;
  const sigmaEN = 2 * SHEAR_MODULUS * strainEN;

  // sigma_UU, sigma_EU, sigma_NU stay zero — the free-surface condition.
  return [
    [sigmaEE, sigmaEN, 0],
    [sigmaEN, sigmaNN, 0],
    [0, 0, 0],
  ];
}

/**
 * Shear stress in the fault's own slip direction, Pa — signed, positive
 * encourages slip, exactly matching `resolved_shear`. Sun and Moon tensors
 * are summed before rotating to the local frame, since the whole chain from
 * tensor to resolved shear is linear.
 *
 * The caller takes `Math.abs()` before display — see the module doc comment
 * for why the sign from this pipeline isn't trustworthy when `strikeDeg`
 * came from a mapped trace rather than a measured convention.
 */
export function resolvedShearPa(
  bodies: { sun: TidalBody; moon: TidalBody },
  latitudeDeg: number,
  longitudeDeg: number,
  strikeDeg: number,
  dipDeg: number,
  rakeDeg: number,
): number {
  const sunDirection: Vec3 = [bodies.sun.x, bodies.sun.y, bodies.sun.z];
  const moonDirection: Vec3 = [bodies.moon.x, bodies.moon.y, bodies.moon.z];

  const tensor = addMat3(
    tidalTensor(sunDirection, bodies.sun.distanceM, bodies.sun.gm),
    tidalTensor(moonDirection, bodies.moon.distanceM, bodies.moon.gm),
  );
  const stress = localStressTensor(tensor, latitudeDeg, longitudeDeg);
  const { normal, slip } = faultVectors(strikeDeg, dipDeg, rakeDeg);

  return dot3(slip, matVec(stress, normal));
}
