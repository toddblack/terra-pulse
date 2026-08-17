/**
 * Solar flares and CME arrivals — NASA's DONKI catalogue.
 *
 * The emission side of space weather. Everything else this app ingests is
 * measured at or near Earth; these are events *on the Sun*, plus a model's
 * estimate of when a coronal mass ejection reaches us.
 */

/**
 * Where **DONKI's** flare record becomes usable — not where the flare record
 * as a whole begins.
 *
 * DONKI returns flares from 2010, but its early coverage is badly incomplete.
 * Measured against NOAA's GOES XRS reports, the standard independent catalogue,
 * counting M and X class flares per year:
 *
 * | year | GOES | DONKI | DONKI captures |
 * |---|---|---|---|
 * | 2011 | 119 | 30 | **25%** |
 * | 2012 | 130 | 30 | **23%** |
 * | 2013 | 111 | 28 | **25%** |
 * | **2014** | 221 | 215 | **97%** |
 * | 2015 | 106 | 127 | 120% |
 * | 2016 | 16 | 16 | 100% |
 *
 * **The deeper record is GOES, not DONKI.** GOES XRS yearly reports run 1975 to
 * 2016 and then stop; DONKI is complete from 2014. They overlap for three years
 * at 97-100% agreement, so the two can be joined with the join *validated*
 * rather than assumed — giving fifty years rather than twelve.
 *
 * H1 registers GOES as its source, which turned out to be both correct and the
 * better choice. This constant governs only the DONKI half.
 *
 * **The 2015 disagreement is real and unexplained.** DONKI reports *more* M/X
 * flares than GOES that year, with no duplicates — 127 records, 127 unique ids,
 * 127 unique peak times, one catalogue. Most likely GOES's 2015 report is partial
 * across a satellite transition. Two good catalogues can differ by 20% at the
 * margin, and any flare count carries that uncertainty.
 */
export const FLARE_COMPLETE_SINCE_YEAR = 2014;

/** DONKI's earliest flare record, incomplete though it is. */
export const DONKI_START_YEAR = 2010;

/**
 * The first full year of the GOES XRS flare record.
 *
 * GOES-1 launched in October 1975, so 1975 itself is a partial year — its report
 * lists two M/X flares against 405 in 1980. The yearly reports end at **2016**,
 * after which DONKI takes over.
 *
 * Detection is **not uniform across this span**: GOES instruments changed
 * repeatedly and pre-1996 fluxes are known to need a scaling correction, so
 * whether "M1.0" means the same thing in 1980 and 2010 has not been verified
 * here. That is the same class of problem as M4.5 earthquake completeness and it
 * must be settled before any rate is computed over the full record.
 */
export const GOES_FLARE_FIRST_FULL_YEAR = 1976;
export const GOES_FLARE_LAST_YEAR = 2016;

/**
 * Flare classes, in order. Each letter is ten times the peak X-ray flux of the
 * one before, so the scale is logarithmic and the letters are not comparable as
 * categories — an X is a hundred times an M is not a figure of speech.
 */
export type FlareClass = 'A' | 'B' | 'C' | 'M' | 'X';

const CLASS_ORDER: readonly FlareClass[] = ['A', 'B', 'C', 'M', 'X'];

export interface SolarFlare {
  /** DONKI's own id, e.g. `2026-08-10T12:34:00-FLR-001`. */
  id: string;
  /** As published, e.g. `M2.4`. */
  classType: string;
  flareClass: FlareClass;
  /** The number after the letter: `M2.4` is 2.4. */
  magnitude: number;
  /** Peak time — the instant a flare is dated by. */
  peakTimeUtc: string;
  beginTimeUtc: string | null;
  endTimeUtc: string | null;
  /**
   * Heliographic position on the solar disc, e.g. `N14W102`.
   *
   * Kept as published rather than parsed into coordinates: nothing here draws
   * the Sun, and a position past the limb (W102 above) is a real value that a
   * naive parse would silently accept as a point on the visible disc.
   */
  sourceLocation: string | null;
  activeRegionNumber: number | null;
  link: string | null;
}

/**
 * Whether a flare is at least a given class and magnitude.
 *
 * Needed because the scale is two-part and lexical comparison fails on it:
 * `M9.9` is smaller than `X1.0`, and `M10` does not occur — it is `X1`.
 */
export function flareAtLeast(
  flare: SolarFlare,
  minimumClass: FlareClass,
  minimumMagnitude = 1,
): boolean {
  const a = CLASS_ORDER.indexOf(flare.flareClass);
  const b = CLASS_ORDER.indexOf(minimumClass);
  if (a !== b) return a > b;
  return flare.magnitude >= minimumMagnitude;
}

/**
 * A modelled CME arrival at Earth.
 *
 * From WSA-ENLIL runs rather than from the CME catalogue itself: **the CME
 * records carry no arrival estimate**, and H2 is registered on arrival rather
 * than emission because Earth rotates substantially during transit.
 *
 * Only a minority of runs reach Earth at all — measured over ten weeks, 79 of
 * 325 — because most modelled CMEs miss. The rest carry arrivals at other
 * spacecraft instead.
 */
export interface CmeArrival {
  simulationId: string;
  /** Modelled shock arrival at Earth. */
  arrivalTimeUtc: string;
  /**
   * The model's predicted Kp at 90 degrees, its headline geoeffectiveness
   * estimate. Null when the run did not produce one.
   */
  predictedKp: number | null;
  /**
   * A grazing encounter rather than a direct hit.
   *
   * **Load-bearing for any trigger set.** A glancing blow can carry a predicted
   * Kp of 2 — barely geoeffective — and pooling those with direct hits dilutes
   * the trigger set with events that were never going to do anything.
   */
  glancingBlow: boolean;
  minorImpact: boolean;
  link: string | null;
}

/** Is this a CME arrival worth treating as a real impact? */
export function isDirectImpact(arrival: CmeArrival): boolean {
  return !arrival.glancingBlow && !arrival.minorImpact;
}
