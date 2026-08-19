/**
 * Pure geometry for the null-distribution chart — no DOM, no Cesium, unit
 * tested on its own (same split `space-weather-track.ts` already uses for
 * its bar layout).
 */

export interface HistogramInput {
  edges: readonly number[];
  counts: readonly number[];
}

export interface HistogramBar {
  /** Fraction of the chart's width, 0-1. */
  x: number;
  width: number;
  /** Fraction of the chart's height, 0-1 — the tallest bar is 1. */
  height: number;
}

/**
 * Bar geometry as fractions of the chart's own box, so the component just
 * multiplies by pixel dimensions. Degenerate input (no bins, or every bin
 * empty) returns bars of height 0 rather than dividing by zero.
 */
export function layoutNullHistogram(histogram: HistogramInput): HistogramBar[] {
  const { edges, counts } = histogram;
  if (counts.length === 0) return [];

  const min = edges[0];
  const max = edges[edges.length - 1];
  if (min === undefined || max === undefined) return [];
  const span = max - min;
  const maxCount = Math.max(...counts);

  return counts.map((count, i) => {
    const left = edges[i];
    const right = edges[i + 1];
    if (left === undefined || right === undefined) return { x: 0, width: 0, height: 0 };
    return {
      x: span > 0 ? (left - min) / span : 0,
      width: span > 0 ? (right - left) / span : 1,
      height: maxCount > 0 ? count / maxCount : 0,
    };
  });
}

/**
 * Where the observed statistic falls along the chart's x-axis, as a
 * fraction, for drawing a guide line — `null` when the histogram carries no
 * usable range. Clamped into range rather than omitted: an observed value
 * past every null draw is exactly the interesting case (a small p-value),
 * and it should still show as a line pinned to the edge, not disappear.
 */
export function observedFraction(histogram: HistogramInput, observed: number): number | null {
  const min = histogram.edges[0];
  const max = histogram.edges[histogram.edges.length - 1];
  if (min === undefined || max === undefined || max <= min || !Number.isFinite(observed)) {
    return null;
  }
  const clamped = Math.min(Math.max(observed, min), max);
  return (clamped - min) / (max - min);
}
