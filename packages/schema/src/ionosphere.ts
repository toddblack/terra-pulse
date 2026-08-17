/**
 * Total electron content — NOAA SWPC's GloTEC product.
 *
 * The *charged atmosphere*: how many electrons sit in a column through the
 * ionosphere above each point, in TECU (10^16 electrons per square metre).
 *
 * ## What it is and is not
 *
 * This is the third space-weather raster and it answers a different question
 * from the other two. The IGRF layer is the main field from the geodynamo,
 * which the Sun does not move. The auroral oval is where particles *precipitate*
 * — confined to the magnetic poles. TEC is the state of the ionised upper
 * atmosphere **everywhere**, including the equatorial latitudes where the oval
 * never reaches and where most large earthquakes are.
 *
 * ## The equatorial anomaly, and why it is a trap for correlation
 *
 * TEC's dominant feature is the **equatorial ionization anomaly** — two bands of
 * high electron content either side of the *magnetic* equator, driven by the
 * fountain effect. Measured against this app's own catalogue, 68% of M7+
 * earthquakes sit within 30 degrees of magnetic latitude, so those bands overlap
 * most of global seismicity.
 *
 * **That overlap is spurious by construction.** Both are equatorial for
 * unrelated reasons — one because of the magnetic field's geometry, the other
 * because that is where the plates are. It is the same trap as the antipodal
 * South America/Indonesia pairing: two things that co-occur because of a shared
 * cause neither has anything to do with. Anything drawn from "quakes fall where
 * TEC is high" has to answer that first.
 */

/**
 * GloTEC's grid, as published: 5 degrees of longitude by 2.5 of latitude.
 *
 * Pinned rather than inferred, so a change in the product's shape fails loudly
 * in the adapter instead of quietly rendering a skewed image — the same reason
 * the aurora grid's dimensions are pinned.
 */
export const TEC_GRID_WIDTH = 72;
export const TEC_GRID_HEIGHT = 72;

/**
 * Top of the TEC ramp, in TECU.
 *
 * **60, not the product's declared 300.** GloTEC's own metadata gives `tec` a
 * range of 0-300, and using it would be the exact mistake the geomagnetic
 * declination layer already made once: a domain taken from the *definition*
 * rather than the *distribution*, which put 77% of the surface within 7% of
 * centre and made the layer look broken.
 *
 * Measured over five maps spanning a month, 25,920 cells: p1 2.1, p50 12.9,
 * p95 41.9, p99 53.1, max 60.5. A ceiling of 60 puts the median at a fifth of
 * the ramp and p95 at 70%, which uses the scale for the conditions that
 * actually occur.
 *
 * It **clamps** rather than rescaling, and severe storms do exceed it — the
 * legend says so with a `≥`. Rescaling per map would renormalise the colours
 * every ten minutes and make "higher than last time" unreadable, which is the
 * same reason the field layer's domain is fixed.
 */
export const TEC_MAX_TECU = 60;

/**
 * The anomaly ramp's half-range, in TECU.
 *
 * The `anomaly` field is TEC **relative to its quiet-time expectation**, so
 * unlike TEC itself it has a meaningful zero and runs both ways — it is a
 * diverging quantity and gets a diverging ramp with a neutral midpoint, exactly
 * as declination and inclination do.
 *
 * Measured on the same sample: p1 -6.1, p50 0.23, p95 6.0, p99 10.0, observed
 * range -11.6 to +18.8. +/-10 covers p1 to p99 and clamps the rest.
 *
 * **This is the quantity worth looking at for "is the atmosphere unusually
 * charged here".** Raw TEC is dominated by local time and season — the daylit
 * hemisphere is always high, which mostly draws the terminator. The anomaly
 * removes that and leaves what is actually unusual.
 */
export const TEC_ANOMALY_RANGE_TECU = 10;

/** Which quantity the layer paints. */
export type TecQuantity = 'tec' | 'anomaly';

/**
 * One GloTEC map.
 *
 * Values are row-major, `height` rows of `width`, and **null where the product
 * gave no value** — kept nullable rather than zero-filled because zero TECU is
 * a physical claim (no ionosphere) that nobody is making.
 */
export interface TecGrid {
  /** Row-major, `TEC_GRID_HEIGHT` rows of `TEC_GRID_WIDTH`, in TECU. */
  tec: (number | null)[];
  /** Same shape: TEC minus its quiet-time expectation. */
  anomaly: (number | null)[];
  /**
   * The product's per-cell quality flag, passed through **uninterpreted**.
   *
   * GloTEC publishes values 0-5 and the payload's metadata does not say what
   * they mean. Measured on one map: 72% are 0 and 14% are 5, and they do *not*
   * cluster the way model-fill would — flag 5 is 17-25% through the mid
   * latitudes and **0%** poleward of 75 degrees. Until someone reads the product
   * documentation this is carried and not acted on, because guessing that a flag
   * means "modelled" and masking on it would be inventing a distinction.
   */
  qualityFlag: (number | null)[];
  /** When the map is for. */
  observedAtUtc: string;
}

/** How often GloTEC publishes. */
export const TEC_CADENCE_MS = 10 * 60_000;

/**
 * Beyond this a map is old enough to say so.
 *
 * The product runs about half an hour behind real time in normal operation, so
 * the bar is well above that — this marks a feed that has stopped, not one
 * that is merely doing its usual lag.
 */
export const TEC_STALE_AFTER_MS = 90 * 60_000;

export function tecIsStale(grid: TecGrid, nowMs: number): boolean {
  return nowMs - Date.parse(grid.observedAtUtc) > TEC_STALE_AFTER_MS;
}

/** The highest TEC on a grid, for the legend. Null if nothing was measured. */
export function tecPeak(grid: TecGrid): number | null {
  let peak: number | null = null;
  for (const value of grid.tec) {
    if (value !== null && (peak === null || value > peak)) peak = value;
  }
  return peak;
}
