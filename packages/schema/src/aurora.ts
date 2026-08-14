/**
 * The auroral oval — NOAA SWPC's OVATION Prime forecast.
 *
 * This is the *external* field's visible signature, and the counterpart to the
 * IGRF layer rather than a variation on it. IGRF models the main field from the
 * geodynamo, which drifts over decades and has no term for the Sun at all. This
 * shows what solar wind and magnetospheric currents are doing to the upper
 * atmosphere **right now**, which is the part that responds to a storm within
 * hours.
 *
 * Worth keeping the magnitudes in mind: a severe storm perturbs the main field
 * by a few hundred nT against ~50,000 nT — under 1%, invisible on that layer.
 * The same storm moves the auroral oval from the polar cap down over populated
 * latitudes, which is enormous. Same event, and only one of the two layers can
 * show it.
 */

/**
 * OVATION's grid, as published: one degree of longitude by one of latitude,
 * 0..359 by -90..90.
 *
 * Pinned here rather than inferred, so a change in the product's shape fails
 * loudly in the adapter instead of silently rendering a skewed image.
 */
export const AURORA_GRID_WIDTH = 360;
export const AURORA_GRID_HEIGHT = 181;

/**
 * The upper end of the colour ramp, as a probability percentage.
 *
 * **Not 100, and not the observed maximum either.** The product's values are the
 * probability of visible aurora at a point, which even during a strong storm
 * rarely passes ~90 near the oval's peak and sat at 36 on a quiet day when this
 * was written. Scaling to 100 would leave ordinary nights compressed into the
 * bottom third of the ramp; scaling to the observed maximum would renormalise
 * every poll and make "brighter than last time" unreadable — the same mistake
 * the field layer's fixed domain avoids.
 *
 * 60 keeps quiet nights legible and lets a real storm saturate, which is the
 * right way round: saturation should mean "exceptional", not "Tuesday".
 */
export const AURORA_MAX_PROBABILITY = 60;

/**
 * Below this the cell is drawn as nothing at all, not as the ramp's low end.
 *
 * Aurora is *localised* — on a quiet grid roughly 70% of cells are zero. Those
 * are absences, not small values, and painting them with the bottom of a ramp
 * would put a faint wash over the entire planet and imply a global phenomenon.
 * This is the one place this project's rasters use transparency to carry
 * meaning; the IGRF layer deliberately does the opposite, because a magnetic
 * field has no "absent".
 */
export const AURORA_VISIBLE_THRESHOLD = 1;

/**
 * Latitudes closer to the equator than this are not drawn.
 *
 * **OVATION emits a seam at the equator.** Measured on the live product:
 * latitudes 0, -1 and -2 carry values of 1-4 across ~90% of longitudes, while
 * every row from +1 to +40 and from -3 to -40 is exactly zero. It renders as a
 * faint green line right around the globe, which is what it looked like.
 *
 * There is no aurora at the equator; it is an artifact of their grid. Suppressed
 * by latitude rather than by raising the visibility threshold, because real
 * aurora at the oval's edge has genuinely low values too and raising the floor
 * would clip the thing itself.
 *
 * 20 degrees is deliberately generous — far below any plausible oval, far above
 * the seam. Aurora reaching 20 degrees geographic would be a Carrington-class
 * event, and OVATION is not the product anyone would be reading for it.
 */
export const AURORA_MIN_LATITUDE = 20;

/**
 * How old an observation may be before the panel calls it stale.
 *
 * SWPC republishes roughly every five minutes. Twenty minutes is four missed
 * cycles — long enough not to cry wolf over one hiccup, short enough that a
 * genuinely dead feed is not passed off as current. A storm can develop inside
 * that window, so the reading is labelled with its own timestamp regardless.
 */
export const AURORA_STALE_AFTER_MS = 20 * 60 * 1000;

/** How often main asks SWPC for a new grid. */
export const AURORA_POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * One OVATION grid, normalised.
 *
 * `values` is row-major from the **north** edge down and from -180 east, which
 * is image order rather than the product's own order — the adapter transposes
 * once so that every consumer doesn't have to. A `Uint8Array` because the values
 * are integer percentages: 65,160 bytes rather than the 520 KB a float array
 * would cost to carry over IPC every five minutes.
 */
export interface AuroraGrid {
  /** When the underlying observation was taken. */
  observedAtUtc: string;
  /** The instant the forecast describes — typically ~1 h after the observation. */
  forecastForUtc: string;
  /** When this app fetched it, for staleness independent of SWPC's clock. */
  fetchedAtUtc: string;
  width: number;
  height: number;
  /** Probability of visible aurora, 0-100, row-major from the north edge. */
  values: Uint8Array;
}

/** Whether a grid is too old to present as current. */
export function auroraIsStale(grid: AuroraGrid, nowMs: number): boolean {
  const observed = Date.parse(grid.observedAtUtc);
  if (!Number.isFinite(observed)) return true;
  return nowMs - observed > AURORA_STALE_AFTER_MS;
}

/**
 * The strongest probability anywhere on the grid.
 *
 * Reported alongside the map because a reader looking at the whole planet
 * cannot tell 20% from 60% by colour alone at a glance, and "how active is it
 * right now" is the first question the layer invites.
 */
export function auroraPeak(grid: AuroraGrid): number {
  let peak = 0;
  for (const value of grid.values) if (value > peak) peak = value;
  return peak;
}
