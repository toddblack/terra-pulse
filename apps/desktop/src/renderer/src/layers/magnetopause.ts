/**
 * Where the solar wind stops — the magnetopause, after Shue et al. (1998).
 *
 * Shue, J.-H., et al. (1998), *Magnetopause location under extreme solar wind
 * conditions*, J. Geophys. Res., 103(A8), 17691-17700.
 * https://doi.org/10.1029/98JA01103
 *
 * ## This is a model, and the app has to say so
 *
 * Everything else drawn on this globe is a measurement or a mapped feature: an
 * epicentre, a fault trace, an observed Kp. This is neither. It is an empirical
 * fit to spacecraft crossings, evaluated on measured solar wind — so the inputs
 * are observations and the surface is output. The same rule that keeps
 * recurrence intervals from being divided out of slip rates applies: show it,
 * label it, and never let it read as something anyone saw.
 *
 * ## What it is physically
 *
 * The boundary where the solar wind's dynamic pressure balances the pressure of
 * Earth's magnetic field. It is not a shell at fixed radius: it is squashed on
 * the dayside and drawn into a long tail on the night side, and it moves in and
 * out continuously as the wind changes.
 *
 * Two inputs govern it, and both are needed:
 *
 * - **Dynamic pressure** compresses it. That is `density x speed^2` — neither
 *   number alone says how hard the wind is pushing, since a fast tenuous stream
 *   and a slow dense one can exert the same force.
 * - **Southward Bz** erodes it, by letting the wind's field reconnect with
 *   Earth's and strip flux from the dayside. This is why a storm can push the
 *   boundary much further in than pressure alone would.
 */

/** Earth's mean radius in km — the unit the model works in. */
export const EARTH_RADIUS_KM = 6371;

/**
 * Geosynchronous orbit, in Earth radii.
 *
 * Drawn alongside the boundary because it is what makes the number mean
 * something. "The magnetopause is at 6.3 Re" is abstract; "the magnetopause has
 * moved inside geosynchronous orbit, so those satellites are now outside the
 * magnetosphere and directly in the solar wind" is a documented and consequential
 * event, and it is exactly what severe storms do.
 */
export const GEOSYNCHRONOUS_RE = 6.6;

/**
 * The range Shue et al. fitted, in nPa and nT.
 *
 * Beyond it the formula is extrapolation, not fit — and the events most worth
 * looking at are the ones that leave the range. The Halloween 2003 storm reached
 * Bz -50 nT, nearly three times the fitted floor. `magnetopauseStandoff` reports
 * whether it is extrapolating rather than silently continuing, so the layer can
 * say so.
 */
export const SHUE_PRESSURE_RANGE_NPA = { min: 0.5, max: 8.5 } as const;
export const SHUE_BZ_RANGE_NT = { min: -18, max: 15 } as const;

/**
 * Solar wind dynamic pressure in nPa from density and speed.
 *
 * `P = rho v^2` with rho = n m_p. The constant folds the unit conversions:
 * cm^-3 to m^-3 (1e6), proton mass (1.6726e-27 kg), km/s to m/s squared (1e6),
 * and Pa to nPa (1e9).
 *
 * Protons only. OMNI publishes a flow-pressure column that includes an
 * alpha-particle correction and runs a few percent higher; this app stores
 * density rather than that column, because SWPC's live product publishes density
 * and no pressure, and one consistent approximation across the whole series is
 * worth more than a better one on half of it.
 */
export const PROTON_PRESSURE_CONSTANT = 1.6726e-6;

export function dynamicPressureNPa(densityCm3: number, speedKmS: number): number {
  return PROTON_PRESSURE_CONSTANT * densityCm3 * speedKmS * speedKmS;
}

export interface MagnetopauseShape {
  /** Subsolar standoff distance, in Earth radii. */
  standoffRe: number;
  /** Flaring parameter — how far the boundary opens out toward the tail. */
  flaring: number;
  /** The dynamic pressure used, in nPa. */
  pressureNPa: number;
  /** Either input fell outside the range Shue et al. fitted. */
  extrapolated: boolean;
  /** The boundary has been pushed inside geosynchronous orbit. */
  insideGeosynchronous: boolean;
}

/**
 * The Shue et al. (1998) subsolar standoff and flaring parameter.
 *
 * ```
 * r0 = (10.22 + 1.29 tanh[0.184 (Bz + 8.14)]) Dp^(-1/6.6)
 * a  = (0.58 - 0.007 Bz) (1 + 0.024 ln Dp)
 * ```
 *
 * The `tanh` is what makes this worth using over a pure pressure balance: it
 * saturates, so the boundary stops eroding once Bz is strongly southward rather
 * than collapsing without limit. The `-1/6.6` exponent is the pressure balance
 * itself — a dipole field falls as r^-3, its pressure as r^-6, and the extra
 * 0.6 accounts for the boundary current.
 */
export function magnetopauseStandoff(bzGsmNt: number, pressureNPa: number): MagnetopauseShape {
  // Guarded because `ln` and a negative power both diverge at zero, and a
  // pressure of zero is not physical — the wind never stops entirely.
  const pressure = Math.max(pressureNPa, 0.01);

  const standoffRe =
    (10.22 + 1.29 * Math.tanh(0.184 * (bzGsmNt + 8.14))) * Math.pow(pressure, -1 / 6.6);

  const flaring = (0.58 - 0.007 * bzGsmNt) * (1 + 0.024 * Math.log(pressure));

  return {
    standoffRe,
    flaring,
    pressureNPa: pressure,
    extrapolated:
      pressure < SHUE_PRESSURE_RANGE_NPA.min ||
      pressure > SHUE_PRESSURE_RANGE_NPA.max ||
      bzGsmNt < SHUE_BZ_RANGE_NT.min ||
      bzGsmNt > SHUE_BZ_RANGE_NT.max,
    insideGeosynchronous: standoffRe < GEOSYNCHRONOUS_RE,
  };
}

/**
 * Distance to the boundary at an angle from the Earth-Sun line, in Earth radii.
 *
 * ```
 * r = r0 (2 / (1 + cos θ))^a
 * ```
 *
 * θ = 0 is the subsolar point and θ = π is directly antisunward, where the
 * expression diverges — the real magnetotail extends for hundreds of Earth radii
 * and this fit does not close it. Callers should stop well short; see
 * `magnetopauseProfile`.
 */
export function magnetopauseRadiusRe(shape: MagnetopauseShape, thetaRad: number): number {
  const denominator = 1 + Math.cos(thetaRad);
  if (denominator <= 0) return Number.POSITIVE_INFINITY;
  return shape.standoffRe * Math.pow(2 / denominator, shape.flaring);
}

/**
 * The boundary sampled from the subsolar point around toward the tail.
 *
 * Returns `{ thetaRad, radiusRe }` pairs, which the layer turns into positions
 * once it knows where the Sun is.
 *
 * **Truncated at `maxThetaDeg`, and that is a statement about the model rather
 * than about the drawing.** The Shue fit describes the dayside boundary and the
 * near flanks; carried to θ = 180° it diverges to infinity, and the real
 * magnetotail runs out past 200 Earth radii — far beyond anything this view can
 * show and far beyond where the fit was constrained. Drawing a closed teardrop
 * would be inventing a tail the model does not provide.
 */
/**
 * The point on Earth with the Sun directly overhead, in degrees.
 *
 * The whole boundary is oriented on the Earth-Sun line, so this is what turns a
 * profile into positions. Computed analytically rather than through Cesium's
 * ephemeris: the ICRF-to-fixed transform needs Earth-orientation data that is
 * loaded asynchronously and can be `undefined` on the first frames, which is a
 * lot of failure surface for a quantity a low-precision formula gets to within
 * a fraction of a degree — and at 10 Earth radii, a fraction of a degree is
 * nothing.
 *
 * Low-precision solar position, after the Astronomical Almanac. Accurate to
 * about 0.01° in declination over 1950-2050, which is far past what this needs.
 */
export function subsolarPoint(at: Date): { latitudeDeg: number; longitudeDeg: number } {
  // Julian days from J2000.0.
  const n = at.getTime() / 86_400_000 - 10_957.5;

  const meanLongitude = 280.46 + 0.9856474 * n;
  const meanAnomaly = ((357.528 + 0.9856003 * n) * Math.PI) / 180;

  // Ecliptic longitude: the mean longitude plus the equation of centre.
  const eclipticLongitude =
    ((meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * Math.PI) /
    180;

  // Obliquity, drifting slowly.
  const obliquity = ((23.439 - 0.0000004 * n) * Math.PI) / 180;

  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));

  // Right ascension, then the hour angle against Greenwich mean sidereal time.
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  );
  const gmstDeg = (280.46061837 + 360.98564736629 * n) % 360;

  return {
    latitudeDeg: (declination * 180) / Math.PI,
    longitudeDeg: normaliseLongitude((rightAscension * 180) / Math.PI - gmstDeg),
  };
}

/** To (-180, 180]. */
function normaliseLongitude(deg: number): number {
  let value = deg % 360;
  if (value > 180) value -= 360;
  if (value <= -180) value += 360;
  return value;
}

export function magnetopauseProfile(
  shape: MagnetopauseShape,
  maxThetaDeg = 120,
  steps = 60,
): { thetaRad: number; radiusRe: number }[] {
  const maxTheta = (Math.min(maxThetaDeg, 179) * Math.PI) / 180;
  const points: { thetaRad: number; radiusRe: number }[] = [];

  for (let i = 0; i <= steps; i += 1) {
    const thetaRad = (maxTheta * i) / steps;
    points.push({ thetaRad, radiusRe: magnetopauseRadiusRe(shape, thetaRad) });
  }

  return points;
}
