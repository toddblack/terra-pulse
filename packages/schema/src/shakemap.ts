import type { EarthquakeEvent } from './earthquake';

/**
 * Shaking intensity around one earthquake, as USGS ShakeMap contours.
 *
 * Drawn on the globe for a selected quake when the reader asks for it. These
 * are the lines of equal shaking — isoseismals — on the Modified Mercalli
 * scale (MMI), which describes what the shaking did at a place rather than how
 * much energy the earthquake released.
 *
 * **They are USGS's estimate, not a survey.** A ShakeMap is interpolated from
 * whatever was available: seismometer readings, "Did You Feel It?" reports, and
 * a ground-motion model filling the gaps between them. For an old or remote
 * earthquake it can be the model nearly alone. The app says so wherever the
 * lines are explained; see `shakemap-guide.ts`.
 */

/**
 * The smallest quake the lines are offered for.
 *
 * Set by what USGS publishes, measured against its own count endpoint
 * (2026-10-13), events carrying a ShakeMap:
 *
 *     M5.5+   since 2013     6,281 of 6,337   99%
 *     M5.5+   1970-2012      7,569 of 20,503  37%
 *     M5-5.5  2024-2026        699 of 3,989   18%
 *     M4.5-5  2024-2026        322 of 15,804   2%
 *
 * Below M5.5 the answer is nearly always "there is none", and a button that
 * comes up empty four times in five teaches people to stop pressing it. M5.5
 * is also the floor of the globe's emphasis ring, so "a big one" means the
 * same quakes in both places.
 *
 * A display threshold, not an analysis parameter.
 */
export const SHAKEMAP_MIN_MAGNITUDE = 5.5;

/** One intensity level and every line drawn at it. */
export interface IntensityContour {
  /** Modified Mercalli intensity, in the half steps USGS contours at: 4, 4.5, 5 … */
  mmi: number;
  /**
   * The level's lines, each a run of `[longitude, latitude]` pairs.
   *
   * Usually several: one level is often a main loop plus islands where soft
   * ground shook harder than its surroundings.
   */
  lines: [number, number][][];
}

export interface ShakeMapContours {
  /** The id the lines were asked for. USGS may file the map under another. */
  eventId: string;
  /** The strongest intensity anywhere on the map, or `null` if not stated. */
  maxMmi: number | null;
  /**
   * Who made this map: a network code (`us`, `ci`) or `atlas` for the
   * ShakeMap Atlas, USGS's uniform reprocessing of past earthquakes.
   */
  source: string;
  /** The map's revision. Recent quakes are revised many times in their first days. */
  version: string | null;
  /** When USGS computed this revision. */
  processedAtUtc: string | null;
  /** Every level in the product, weakest first. */
  contours: IntensityContour[];
}

/**
 * What asking for a quake's lines can come back with.
 *
 * `none` is a real answer and the common one for older quakes — USGS made no
 * map — which is why it is not an error. A failed request throws instead.
 */
export type ShakeMapResult =
  | { status: 'available'; map: ShakeMapContours }
  | { status: 'none' };

/**
 * Whether the lines are offered for a quake.
 *
 * USGS-sourced only: the lookup is by USGS event id, and an event that came in
 * through EMSC carries EMSC's id, which USGS cannot resolve.
 */
export function shakeMapEligible(event: Pick<EarthquakeEvent, 'magnitude' | 'source'>): boolean {
  return event.source === 'usgs' && event.magnitude >= SHAKEMAP_MIN_MAGNITUDE;
}
