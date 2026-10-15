import type { EarthquakeEvent } from './earthquake';

/**
 * Where the ground was, day by day, at the GPS stations near one earthquake —
 * before it and after it.
 *
 * Opened from the inspector for a large quake, in a window of its own. The
 * positions are the Nevada Geodetic Laboratory's daily solutions: one position
 * per station per day, processed the same way for ~23,800 stations worldwide.
 * Fetched when the window opens and held in main's memory for a while; nothing
 * is stored on disk.
 *
 * **Explore, not a test.** The question behind it is "did the ground do
 * anything before big quakes?", and the window can only show what one station
 * did around one quake. Whether that happens more than chance would allow is a
 * question for a registered hypothesis in Analyze (non-negotiable #3), and the
 * window's guide says so.
 */

/**
 * The smallest quake the window is offered for.
 *
 * Below M6 the ground moves a few millimetres at most, even at the nearest
 * station, which is about what a station's own day-to-day scatter is. The
 * user's choice (2026-10-15), from three options.
 *
 * A display threshold, not an analysis parameter.
 */
export const GNSS_MIN_MAGNITUDE = 6;

/**
 * How far from an epicentre a station is looked for, km.
 *
 * **The lab's own rule, not ours.** It marks a possible earthquake step in a
 * station's record when the station is within 10^(0.5·M − 0.79) km of the
 * epicentre — 162 km at M6, 512 km at M7, 1,622 km at M8 — and the window uses
 * the same reach so the two cannot disagree about which stations a quake could
 * have moved. The lab notes it ignores depth and direction.
 */
export function gnssReachKm(magnitude: number): number {
  return 10 ** (0.5 * magnitude - 0.79);
}

/** How many stations one window shows. Three, the user's choice. */
export const GNSS_MAX_STATIONS = 3;

/** How long after the quake the graph runs, days. */
export const GNSS_AFTER_DAYS = 30;

/**
 * How far back before the quake the graph can look.
 *
 * A selector rather than one span because the thing being looked for has no
 * agreed length: the slow slip seen before Iquique 2014 ran for weeks to
 * months. The longest span is what main sends; the shorter ones are cut from it
 * in the renderer.
 */
export const GNSS_BEFORE_SPANS = [
  { id: '30d', days: 30, label: '30 d' },
  { id: '90d', days: 90, label: '90 d' },
  { id: '1y', days: 365, label: '1 y' },
] as const;

export type GnssSpanId = (typeof GNSS_BEFORE_SPANS)[number]['id'];

export const GNSS_DEFAULT_SPAN: GnssSpanId = '90d';

/** The longest span on offer — what main fetches. */
export const GNSS_MAX_BEFORE_DAYS = 365;

/**
 * One day's position, in metres, relative to an arbitrary fixed point.
 *
 * Only differences mean anything, which is all the graph draws.
 */
export interface GnssDailyPosition {
  /** Midnight UTC at the start of the day the solution covers. */
  dayMs: number;
  eastM: number;
  northM: number;
  upM: number;
}

/**
 * A station's steady motion, metres per year: mostly its tectonic plate
 * carrying it along.
 *
 * The lab's MIDAS estimate (Blewitt et al. 2016), fitted over the station's
 * whole record and robust to jumps — so it is not fitted to the window being
 * looked at, and cannot absorb something unusual inside it.
 */
export interface GnssVelocity {
  eastMPerYr: number;
  northMPerYr: number;
  upMPerYr: number;
}

/**
 * Something the lab knows could put a jump in a station's record.
 *
 * Equipment changes are why this exists: a new antenna moves the measured
 * position by millimetres to centimetres, and on a graph that looks exactly
 * like the ground moving.
 */
export interface GnssStep {
  dayMs: number;
  kind: 'equipment' | 'earthquake';
  /** For equipment, what changed (`Antenna_Type_Changed`); for a quake, its USGS id. */
  detail: string;
  magnitude: number | null;
  distanceKm: number | null;
}

export interface GnssStationSeries {
  /** The lab's four-character station id. */
  station: string;
  latitude: number;
  longitude: number;
  /** From the epicentre. */
  distanceKm: number;
  /** From the epicentre, degrees clockwise from north. */
  bearingDeg: number;
  /** Oldest first, from a year before the quake to 30 days after. */
  positions: GnssDailyPosition[];
  /** `null` when the lab has published no velocity for this station. */
  velocity: GnssVelocity | null;
  /**
   * The station's known steps inside the window.
   *
   * `null` when the station's page could not be read, which is different from
   * "none known" and is said differently.
   */
  steps: GnssStep[] | null;
  /** The original data's DOI, which the lab asks to be cited alongside it. */
  doi: string | null;
  /** The last day the station's record holds at all — the lab runs ~2 weeks behind. */
  lastDayMs: number;
}

/**
 * What asking for a quake's stations can come back with.
 *
 * `none` is a real answer and a common one: most large quakes are offshore,
 * and only about a third of M7+ since 2010 have a station within 100 km. It
 * carries the nearest station that *was* recording, if any, so the window can
 * say how far short it fell. A failed request throws instead.
 */
export type GnssResult =
  | { status: 'available'; reachKm: number; stations: GnssStationSeries[] }
  | { status: 'none'; reachKm: number; nearestKm: number | null };

/** What the renderer sends. Main validates every field before using it. */
export interface GnssRequest {
  eventId: string;
  latitude: number;
  longitude: number;
  magnitude: number;
  originUtc: string;
}

/**
 * Midnight UTC at the start of the day the quake happened.
 *
 * The lab's daily positions run midnight to midnight UTC, so the quake's own
 * day averages positions from before and after it and belongs to neither
 * side. One definition, because main decides which stations cover the quake
 * and the renderer draws the same split; if the two disagreed by a day, a
 * station's "before" would include the jump.
 */
export function gnssQuakeDayMs(originMs: number): number {
  return Math.floor(originMs / 86_400_000) * 86_400_000;
}

export function gnssEligible(event: Pick<EarthquakeEvent, 'magnitude'>): boolean {
  return event.magnitude >= GNSS_MIN_MAGNITUDE;
}
