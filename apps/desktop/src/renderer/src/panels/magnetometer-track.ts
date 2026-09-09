import type { MagnetometerSample } from '@terra-pulse/schema';

/**
 * Ground magnetometer disturbance over the visible window — §5.5's sixth and
 * last row.
 *
 * Pure, like the three track modules beside it.
 *
 * ## What it plots, and why it is the same quantity the globe already draws
 *
 * Each bucket's **peak-to-peak range of the horizontal component**, in nT —
 * exactly what `StationDisturbance.rangeNt` reports for the globe marker and
 * the hover tooltip. One definition of "disturbance" across the app: the row is
 * that number over time, and the marker is its most recent value.
 *
 * The alternative — plotting the field itself — would be unreadable. H sits at
 * tens of thousands of nT and varies by tens, so a raw trace is a flat line
 * whatever the storm. Any usable version has to remove the station's baseline,
 * and a per-bucket range removes it *by construction* rather than by choosing
 * one, which is why it beats subtracting a window median.
 *
 * ## Log-scaled, for the same reason the X-ray row is
 *
 * Measured over real windows: a quiet bucket at Boulder is p50 **3.7 nT** while
 * the 2003 Halloween storm at College, Alaska reaches **2,046 nT** — nearly
 * three decades. Linear, every quiet day would be an invisible line along the
 * axis and only storms would exist. `heightOf` already takes a `scaleMin` and
 * does this; nothing new was needed.
 */

/**
 * Bottom and top of the log scale, nT.
 *
 * **Measured, not assumed**, over 200-bucket layouts of real 48-hour windows:
 *
 * | window | p50 | p90 | max |
 * |---|---|---|---|
 * | quiet 2010, Boulder | 3.7 | 10.0 | 20.4 |
 * | 2024 Gannon, Boulder | 33.5 | 122.8 | 520.7 |
 * | 1989 Quebec, Boulder | 45.4 | 202.7 | 1,077.6 |
 * | 2003 Halloween, College AK | 250.5 | 869.6 | 2,045.8 |
 *
 * 1 nT is below anything a real bucket reports, so the floor never clips
 * upward into data; 2,000 nT sits just under the worst measured bucket, so a
 * genuinely record-breaking storm tops out rather than compressing every other
 * window to make room for it.
 */
export const MAGNETOMETER_RANGE_MIN_NT = 1;
export const MAGNETOMETER_RANGE_MAX_NT = 2000;

/**
 * Longest window this row will fetch, hours (30 days).
 *
 * **The limit is the source, not the drawing.** USGS serves only
 * `sampling_period=60` usefully — measured, `3600` returns an array of nulls
 * rather than hourly means — so a window cannot be thinned upstream and every
 * hour costs 60 samples. 30 days is 43,200 samples, measured at **1.9 s**;
 * a year would be 525,600 and is not something to put behind a scrub.
 *
 * It lines up with the longest live coverage tier, which is a happy accident
 * worth keeping: the row covers exactly the live views and goes quiet on the
 * archive spans. The **playhead may still sit anywhere** — a 48-hour window
 * scrubbed to March 1989 fetches March 1989, which is the whole point of the
 * product fallback.
 */
export const MAGNETOMETER_MAX_WINDOW_HOURS = 30 * 24;

export interface MagnetometerBar {
  /** Fraction of the track, 0-1 — the same coordinate space every row uses. */
  x: number;
  width: number;
  /** Peak-to-peak H range in this bucket, nT, or null if it held no samples. */
  rangeNt: number | null;
  samples: number;
  timeUtc: string;
  /** Reached `STATION_DISTURBED_NT`. Display emphasis only — see that constant. */
  disturbed: boolean;
}

/**
 * Bins samples into equal-time slices and takes each slice's peak-to-peak range.
 *
 * Bins are cut from `[startMs, endMs)` rather than by array index, for the
 * reason `earthquake-track.ts` gives: index slicing sizes bins by sample count,
 * and a magnetometer trace has real gaps — a station drops out for maintenance
 * constantly — so equal-index slices would not be equal-time and this row would
 * silently stop lining up with the four above it.
 *
 * A bucket with no samples gets `null`, **not zero**. Zero is a claim that the
 * field held perfectly steady; null is the truth, and the row draws it as an
 * absence the same way the solar-wind row draws its blackouts.
 */
export function layoutMagnetometerTrack(
  samples: readonly MagnetometerSample[],
  startMs: number,
  endMs: number,
  bucketCount: number,
  disturbedNt: number,
): MagnetometerBar[] {
  const span = endMs - startMs;
  if (span <= 0 || bucketCount <= 0) return [];

  const binMs = span / bucketCount;
  const low = new Array<number>(bucketCount).fill(Number.POSITIVE_INFINITY);
  const high = new Array<number>(bucketCount).fill(Number.NEGATIVE_INFINITY);
  const counts = new Array<number>(bucketCount).fill(0);

  for (const sample of samples) {
    if (sample.timeMs < startMs || sample.timeMs > endMs) continue;
    const index = Math.min(bucketCount - 1, Math.floor((sample.timeMs - startMs) / binMs));
    if (index < 0) continue;
    counts[index] = (counts[index] ?? 0) + 1;
    if (sample.hNt < (low[index] ?? Number.POSITIVE_INFINITY)) low[index] = sample.hNt;
    if (sample.hNt > (high[index] ?? Number.NEGATIVE_INFINITY)) high[index] = sample.hNt;
  }

  const width = 1 / bucketCount;
  const bars: MagnetometerBar[] = [];
  for (let i = 0; i < bucketCount; i += 1) {
    const count = counts[i] ?? 0;
    // A single sample has no range. Reporting 0 would be indistinguishable
    // from a perfectly steady bucket, which one reading cannot support — the
    // same rule `parseDisturbance` already applies to a whole window.
    const rangeNt = count >= 2 ? (high[i] ?? 0) - (low[i] ?? 0) : null;
    bars.push({
      x: i * width,
      width,
      rangeNt,
      samples: count,
      timeUtc: new Date(startMs + i * binMs).toISOString(),
      disturbed: rangeNt !== null && rangeNt >= disturbedNt,
    });
  }

  return bars;
}

/** The window's largest bucket range and how much of it was measured at all. */
export function peakMagnetometer(bars: readonly MagnetometerBar[]): {
  rangeNt: number | null;
  measuredFraction: number;
} {
  let rangeNt: number | null = null;
  let measured = 0;
  for (const bar of bars) {
    if (bar.rangeNt === null) continue;
    measured += 1;
    if (rangeNt === null || bar.rangeNt > rangeNt) rangeNt = bar.rangeNt;
  }
  return {
    rangeNt,
    // 1 for an empty layout, so a row with no buckets reads through its
    // "no data" caption rather than as "0% measured" — which would imply the
    // row had looked and found the station silent. Same rule as
    // `measuredFraction` in space-weather-track.ts.
    measuredFraction: bars.length === 0 ? 1 : measured / bars.length,
  };
}
