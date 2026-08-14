/**
 * Geomagnetic activity indices — Kp and Dst.
 *
 * The half of space weather that *has* a history. The auroral oval is a nowcast
 * with no archive; these go back decades, so they follow the scrubber and can
 * be put on the same time axis as the earthquake catalogue. They are also the
 * data H4 is registered against (`HYPOTHESES.md`), so what is stored here has to
 * be good enough for a rate claim, not just for a picture.
 */

/**
 * Where each index starts. They are **not** the same year, and a single
 * constant covering "space weather" would have to be wrong about one of them.
 *
 * Same shape as the earthquake archive's `ARCHIVE_START_YEAR` /
 * `DEEP_ARCHIVE_START_YEAR` split, and for the same reason: two tiers of record
 * with genuinely different depths, and code that assumes the shallower one
 * would silently under-report the deeper.
 *
 * Kp reaches 1932 because it comes straight from GFZ Potsdam, which publishes
 * the index. Dst reaches 1963 because it comes from Kyoto WDC via NASA's OMNI2,
 * verified column-for-column against the March 1989 Quebec storm (Dst -589 nT
 * at 1989-03-14 01:00 UT, Kp 9 the evening before — both sources agree).
 *
 * The table stores the two independently, so a row may legitimately carry Kp
 * and no Dst for thirty-one years' worth of hours.
 */
export const KP_START_YEAR = 1932;
export const DST_START_YEAR = 1963;

/**
 * Kp runs 0 to 9 in thirds — 28 distinct values, verified against the full GFZ
 * record: 0, 0.333, 0.667, 1, 1.333 ... i.e. 0, 0+, 1-, 1, 1+.
 *
 * Stored as GFZ publishes it. An earlier version stored OMNI2's form, which
 * rounds each third to a tenth (`0.3` for "0+") and carried a comment claiming
 * that was the published convention. It isn't; OMNI truncates, and this app now
 * reads the publisher directly.
 *
 * The two forms differ by at most 0.033 and **agree exactly on the integers**,
 * which is where every threshold in this app sits — so rows left over from the
 * OMNI era are imprecise, never misclassified.
 */
export const KP_MAX = 9;

/**
 * Kp at or above which conditions count as a geomagnetic storm (NOAA G1).
 *
 * Used for emphasis on the track, not for any test — H4's registered trigger is
 * **Kp >= 6**, which is a different and deliberately higher bar. Keeping the
 * two apart matters: a display threshold that drifted into the analysis would
 * be exactly the free-parameter-after-the-fact non-negotiable #3 forbids.
 */
export const KP_STORM_THRESHOLD = 5;

/** Dst at or below which conditions count as an intense storm, in nT. */
export const DST_STORM_THRESHOLD = -100;

/**
 * One hour of geomagnetic activity.
 *
 * Both indices are nullable and independently so. OMNI carries gaps, Kp and Dst
 * come from different observatory networks with different reporting lags, and a
 * missing hour must stay missing — filling it with zero would read as "quiet",
 * which is a measurement nobody made.
 */
export interface SpaceWeatherSample {
  /** Hour start, ISO 8601 UTC. */
  timeUtc: string;
  /** Planetary K index, 0-9, or null when not reported. */
  kp: number | null;
  /** Disturbance storm time index in nT, negative during storms, or null. */
  dst: number | null;
}

/** Whether an hour qualifies as stormy by either index. */
export function isStormy(sample: SpaceWeatherSample): boolean {
  if (sample.kp !== null && sample.kp >= KP_STORM_THRESHOLD) return true;
  if (sample.dst !== null && sample.dst <= DST_STORM_THRESHOLD) return true;
  return false;
}

/**
 * Reduces a series to at most `buckets` points for drawing.
 *
 * A decade is ~87,600 hourly samples against a track a few hundred pixels wide,
 * so something has to give. This takes the **extreme** of each bucket rather
 * than the mean, because a storm is a spike a few hours long: averaging a
 * decade into 300 buckets would flatten every storm in the record into the
 * background and produce a chart whose whole subject is missing.
 *
 * "Extreme" means the largest Kp and the *most negative* Dst, since that is the
 * direction each index moves when disturbed.
 */
export function downsampleSpaceWeather(
  samples: readonly SpaceWeatherSample[],
  buckets: number,
): SpaceWeatherSample[] {
  if (buckets <= 0 || samples.length === 0) return [];
  if (samples.length <= buckets) return [...samples];

  const out: SpaceWeatherSample[] = [];
  const size = samples.length / buckets;

  for (let b = 0; b < buckets; b += 1) {
    const start = Math.floor(b * size);
    const end = Math.min(Math.floor((b + 1) * size), samples.length);
    if (end <= start) continue;

    let kp: number | null = null;
    let dst: number | null = null;

    for (let i = start; i < end; i += 1) {
      const sample = samples[i];
      if (!sample) continue;
      if (sample.kp !== null && (kp === null || sample.kp > kp)) kp = sample.kp;
      if (sample.dst !== null && (dst === null || sample.dst < dst)) dst = sample.dst;
    }

    // The bucket is labelled with its first hour, so a point's position on the
    // axis is a time that actually exists rather than an interpolated midpoint.
    out.push({ timeUtc: samples[start]?.timeUtc ?? '', kp, dst });
  }

  return out;
}

/**
 * What the Kp/Dst backfill is doing, as the renderer sees it.
 *
 * Shaped like `ArchiveProgress` on purpose — same lifecycle, same panel idiom,
 * and one less thing to learn.
 */
export interface SpaceWeatherProgress {
  state: 'idle' | 'running' | 'complete' | 'failed' | 'cancelled';
  /**
   * Which half is running.
   *
   * The two indices no longer cost anything like the same: Kp is a single ~5.5
   * MB request covering the whole record, Dst is one file per year from 1963.
   * A bar driven by years alone would sit at zero through the Kp phase and then
   * jump, so the phase is named rather than averaged away.
   */
  phase: 'kp' | 'dst' | null;
  /** Whether the deep Kp record is stored. One request, so it is all or nothing. */
  kpComplete: boolean;
  /** Dst years already stored, including from earlier runs. */
  completedYears: number;
  totalYears: number;
  storedSamples: number;
  currentYear: number | null;
  error: string | null;
}
