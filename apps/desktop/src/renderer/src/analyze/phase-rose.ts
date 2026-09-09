import type { HistogramInput } from './null-histogram';

/**
 * Pure geometry for the phase-rose chart — no DOM, unit tested on its own,
 * same split as `null-histogram.ts`. Phase wraps at ±180°, which a linear
 * bar chart cannot show (−180° and +180° are the same point but sit at
 * opposite ends of the axis); this exists specifically so that wraparound
 * is visible rather than implied.
 */

export interface RosePoint {
  x: number;
  y: number;
}

/**
 * A point at the given phase angle and radius, both as fractions of the
 * chart's own box (radius 1 is the outer edge). 0° is at the top (12
 * o'clock), increasing clockwise — an arbitrary but fixed convention, used
 * identically for wedge outlines, the preferred-phase needle, and the axis
 * labels, so nothing on the chart can disagree about which way the circle
 * turns.
 */
export function phasePoint(angleDeg: number, radius: number): RosePoint {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: Math.sin(rad) * radius, y: -Math.cos(rad) * radius };
}

export interface RoseWedge {
  /**
   * The wedge outline, including the centre point, as fractions of the
   * chart's radius — ready to join into an SVG `<polygon>`.
   */
  points: readonly RosePoint[];
}

/**
 * One wedge per bin, its outer edge sampled every 5° rather than drawn with
 * an SVG arc command. With equal start/end radii two different circles
 * satisfy an arc's flags, and picking the wrong flag combination draws the
 * *other* one with no error — a sampled polygon has no such ambiguity and is
 * visually identical to a true arc at this span (30° bins, so at most 6
 * segments).
 */
export function layoutPhaseRose(histogram: HistogramInput): RoseWedge[] {
  const { edges, counts } = histogram;
  if (counts.length === 0) return [];

  const maxCount = Math.max(...counts);

  return counts.map((count, i) => {
    const start = edges[i];
    const end = edges[i + 1];
    if (start === undefined || end === undefined) return { points: [] };

    const radius = maxCount > 0 ? count / maxCount : 0;
    const span = end - start;
    const steps = Math.max(1, Math.round(Math.abs(span) / 5));
    const arc = Array.from({ length: steps + 1 }, (_, s) => phasePoint(start + (span * s) / steps, radius));

    return { points: [{ x: 0, y: 0 }, ...arc] };
  });
}
