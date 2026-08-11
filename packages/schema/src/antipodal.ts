/**
 * What happened near an earthquake's antipode — PROJECT_PLAN §5.3, and the
 * observational half of hypothesis **H5**.
 *
 * ## What this is, and firmly is not
 *
 * H5 asks whether large earthquakes are followed by an excess of seismicity near
 * the point opposite them on the globe. That is a *statistical* question, it is
 * registered in `HYPOTHESES.md` with a KS test against a completeness-weighted
 * null, and it belongs in Analyze.
 *
 * This module answers the *descriptive* half only: for one event, what did the
 * catalogue actually record near its antipode, how far away, and how long after.
 * No p-value, no significance, no claim of triggering — which is what keeps it
 * inside Explore under non-negotiable #1.
 *
 * ## Why the background rate travels with the answer
 *
 * A list of "events near the antipode" on its own is dangerously suggestive. The
 * measured case that prompted this: a Colombia M7.4 followed 4.6 h later by a
 * Sumatra M5.1 just 197 km from its antipode — striking, until you notice that
 * this patch of Sumatra produces an M5+ **every 34 days anyway**, purely because
 * South America and Indonesia are both highly seismic *and* happen to be
 * antipodal to each other.
 *
 * So the background rate is not a footnote here, it is the antidote. It ships
 * alongside every result, because without it the panel is a coincidence
 * generator.
 */
import type { EarthquakeEvent } from './earthquake';
import { haversineKm } from './aftershocks';

/**
 * Smallest event offered an antipodal panel.
 *
 * §5.3's analysis threshold. Below M6 the focused energy at the antipode is
 * negligible and the candidate pool becomes noise — the *visualisation* has no
 * threshold, because drawing a coordinate makes no claim, but anything that
 * counts events does.
 */
export const ANTIPODAL_TRIGGER_MIN_MAGNITUDE = 6;

/** H5's target set: declustered M5.0+ global. */
export const ANTIPODAL_TARGET_MIN_MAGNITUDE = 5;

/**
 * H5's registered window, in hours.
 *
 * **Do not shorten this after seeing a suggestive case.** It was registered on
 * 2026-07-24 at 0–72 h. A 24 h window is defensible *a priori* — surface waves
 * reach the antipode in roughly 2–3 hours and dynamic triggering is usually
 * prompt — but choosing it *after* observing an event that fits inside 24 h is
 * the free-parameter-after-the-fact that non-negotiable #3 exists to prevent.
 * Register a second hypothesis instead, and pay for it in the FDR denominator.
 */
export const ANTIPODAL_WINDOW_HOURS = 72;

/**
 * Distance bands for reporting, km.
 *
 * §5.3: rings at 250/500/1000 km are **visualisation only and carry no
 * statistical meaning**. The registered test uses the full distance
 * distribution precisely so no radius has to be guessed; these exist to make a
 * list of distances readable by a human.
 */
export const ANTIPODAL_RINGS_KM: readonly number[] = [250, 500, 1000];

/** How far out the panel looks. The widest ring. */
export const ANTIPODAL_SEARCH_KM = 1000;

/**
 * Wraps a longitude into [-180, 180).
 *
 * Half-open at the top on purpose: 180 and -180 are the same meridian, so
 * allowing both would let the antipode of one place print two different ways
 * depending on which side of the date line it started.
 */
export function normalizeLongitude(longitude: number): number {
  if (!Number.isFinite(longitude)) return Number.NaN;
  // Already canonical: return it untouched. The modulo chain below is exact in
  // principle and lossy in floating point — it turned -76.24's antipode into
  // 103.75999999999999 — so the common case skips it entirely and `antipodeOf`
  // becomes its own exact inverse for any in-range input.
  if (longitude >= -180 && longitude < 180) return longitude;
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

/**
 * The point directly opposite on the globe.
 *
 * Latitude mirrors about the equator; longitude moves half a turn. Deliberately
 * ignores depth: a hypocentre 600 km down is still *below* a surface point, and
 * the antipode of that surface point is what "the other side of the world"
 * means. Treating depth as part of the geometry would put the far end inside the
 * mantle rather than on the surface.
 */
export function antipodeOf(point: { latitude: number; longitude: number }): {
  latitude: number;
  longitude: number;
} {
  return {
    latitude: -point.latitude,
    // A single half-turn shift rather than `+180` then wrap. Both are exact in
    // principle; measured, this one survives a round trip on more real inputs
    // (174.78 and -76.24 come back unchanged, where the modulo route drifts by
    // ~1e-14). `>= 0` rather than `> 0` so the antipode of 0° lands on the
    // canonical -180 rather than the excluded +180.
    longitude: point.longitude >= 0 ? point.longitude - 180 : point.longitude + 180,
  };
}

/** One event recorded near the antipode, with how far and how long after. */
export interface AntipodalEvent {
  event: EarthquakeEvent;
  distanceKm: number;
  delayHours: number;
}

export interface AntipodalWindow {
  antipode: { latitude: number; longitude: number };
  windowHours: number;
  searchKm: number;
  minMagnitude: number;
  /** Events inside the window, nearest to the antipode first. */
  events: AntipodalEvent[];
  /**
   * How often this area produces a qualifying event anyway, per year, measured
   * from the catalogue's own history within `searchKm`.
   *
   * **The single most important number here.** Without it a hit near the
   * antipode reads as remarkable regardless of whether the area produces one
   * every month.
   */
  backgroundPerYear: number;
  /** Years the background rate was measured over, so the reader can weigh it. */
  backgroundYears: number;
  /**
   * True when the catalogue has *never* recorded a qualifying event within
   * `searchKm`, across its whole span.
   *
   * Then an empty result says nothing at all: roughly a third of antipodes fall
   * in seismically dead ocean where sparse instrument coverage and genuine
   * quiescence are indistinguishable. The panel has to say so rather than
   * present "nothing happened" as a finding.
   */
  backgroundSilent: boolean;
  /** How much of the window has elapsed, 0–1. Below 1 the answer is partial. */
  elapsedFraction: number;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Summarises already-filtered events near an antipode.
 *
 * Pure, and separated from the query for the usual reason: the wording and the
 * ordering are what a reader actually sees, and they should be testable without
 * a database.
 *
 * `events` must already be restricted to the window and radius — this does not
 * re-filter, so the definition lives in one place.
 */
export function summariseAntipodal(
  trigger: Pick<EarthquakeEvent, 'latitude' | 'longitude' | 'timeUtc'>,
  events: readonly EarthquakeEvent[],
  options: {
    backgroundCount: number;
    backgroundYears: number;
    nowMs: number;
  },
): AntipodalWindow {
  const antipode = antipodeOf(trigger);
  const originMs = Date.parse(trigger.timeUtc);

  const measured: AntipodalEvent[] = events.map((event) => ({
    event,
    distanceKm: haversineKm(antipode, event),
    delayHours: (Date.parse(event.timeUtc) - originMs) / HOUR_MS,
  }));

  // Nearest first: proximity to the antipode is the thing being examined, and
  // a reader scanning the list wants the closest hit at the top.
  measured.sort((a, b) => a.distanceKm - b.distanceKm);

  const elapsedMs = options.nowMs - originMs;
  const windowMs = ANTIPODAL_WINDOW_HOURS * HOUR_MS;

  return {
    antipode,
    windowHours: ANTIPODAL_WINDOW_HOURS,
    searchKm: ANTIPODAL_SEARCH_KM,
    minMagnitude: ANTIPODAL_TARGET_MIN_MAGNITUDE,
    events: measured,
    backgroundPerYear:
      options.backgroundYears > 0 ? options.backgroundCount / options.backgroundYears : 0,
    backgroundYears: options.backgroundYears,
    backgroundSilent: options.backgroundCount === 0,
    elapsedFraction: Math.max(0, Math.min(1, elapsedMs / windowMs)),
  };
}

/**
 * Mean days between qualifying events in the background, or null when the area
 * has never produced one.
 *
 * Null rather than Infinity so the caller has to handle the silent case rather
 * than printing "one every ∞ days".
 */
export function backgroundIntervalDays(window: AntipodalWindow): number | null {
  if (window.backgroundPerYear <= 0) return null;
  return 365.25 / window.backgroundPerYear;
}
