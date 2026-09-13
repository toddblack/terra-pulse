import { segmentEndMs, type WaveformSegment } from '@terra-pulse/schema';

/**
 * Lays a channel's segments out as a trace: pure, Cesium-free and DOM-free, so
 * the drawing is a string a test can read. That is the whole reason this is SVG
 * rather than canvas — at a 1 Hz redraw and ~600 points a trace, canvas buys
 * nothing, and a canvas component would be the first thing in this app whose
 * output could not be tested at all.
 *
 * The module returns *data* (`TraceColumn[]`); only `polylinePoints` knows about
 * SVG, so the rendering choice stays reversible at almost no cost.
 */

/** One screen column's worth of samples: its envelope, in raw counts. */
export interface TraceColumn {
  /** Column centre, 0-1 across the window. */
  x: number;
  min: number;
  max: number;
}

/** A run of columns with no gap in the data. One `<polyline>` each. */
export interface TraceSpan {
  columns: TraceColumn[];
}

export interface TraceLayout {
  spans: TraceSpan[];
  /** Mean of the in-window samples, subtracted before drawing. */
  meanCounts: number;
  /** Counts from the centre line to the top of the plot, on a 1-2-5 ladder. */
  scaleCounts: number;
  /** Share of the window with no data at all, 0-1. */
  gapFraction: number;
  /** Epoch ms just past the newest sample held, or null with no data. */
  newestSampleMs: number | null;
}

/**
 * A gap is anything longer than this many sample periods between one segment's
 * end and the next one's start. Consecutive records from a healthy station
 * abut to within a fraction of a sample, so 1.5 separates "adjacent" from
 * "missing" with room for timestamp rounding.
 */
export const GAP_TOLERANCE_SAMPLES = 1.5;

/**
 * The smallest 1-2-5 step at or above `peak`.
 *
 * **Snapping is what recovers most of the fixed-domain rule this module has to
 * break.** Everywhere else in this app a scale is fixed so colours and heights
 * mean the same thing across views. Here that is impossible — raw counts have
 * no fixed physical meaning, and an STS-2 and a short-period sensor differ by
 * ~50x, so a shared domain would draw most stations flat. A per-window scale is
 * the exception; snapping it means the trace *steps* visibly when the scale
 * changes rather than breathing with every arrival.
 */
export function niceScale(peak: number): number {
  if (!(peak > 0) || !Number.isFinite(peak)) return 1;
  const exponent = Math.floor(Math.log10(peak));
  const magnitude = 10 ** exponent;
  for (const step of [1, 2, 5, 10]) {
    // A hair of slack so floating-point noise at an exact step does not jump
    // to the next one.
    if (step * magnitude >= peak * (1 - 1e-12)) return step * magnitude;
  }
  return 10 * magnitude;
}

/**
 * Min/max decimation of every segment into `columns` equal slices of the
 * window.
 *
 * **Min/max, never stride sampling.** Keeping every Nth sample of a 100 Hz
 * trace aliases: a sharp arrival lasting two samples simply vanishes when
 * neither lands on the stride. The envelope of each column keeps it — the
 * trace can be drawn at 300 columns and still show every spike the instrument
 * recorded.
 *
 * **Gaps are never bridged.** A missing stretch ends the current span and the
 * next data starts a new one. Drawing a straight line across a 40-second outage
 * would read as 40 seconds of quiet ground.
 */
export function layoutWaveform(
  segments: readonly WaveformSegment[],
  windowStartMs: number,
  windowEndMs: number,
  columns: number,
): TraceLayout {
  const spanMs = windowEndMs - windowStartMs;
  const empty: TraceLayout = {
    spans: [],
    meanCounts: 0,
    scaleCounts: 1,
    gapFraction: 1,
    newestSampleMs: null,
  };
  if (!(spanMs > 0) || columns < 1) return empty;

  let newestSampleMs: number | null = null;
  for (const segment of segments) {
    newestSampleMs = Math.max(newestSampleMs ?? -Infinity, segmentEndMs(segment));
  }

  // Pass 1: the in-window mean, and coverage.
  let sum = 0;
  let count = 0;
  let coveredMs = 0;
  for (const segment of segments) {
    const period = 1000 / segment.sampleRateHz;
    const [first, last] = sampleRange(segment, windowStartMs, windowEndMs);
    for (let i = first; i <= last; i += 1) {
      sum += segment.samples[i] ?? 0;
      count += 1;
    }
    if (last >= first) coveredMs += (last - first + 1) * period;
  }
  if (count === 0) return { ...empty, newestSampleMs };
  const meanCounts = sum / count;

  // Pass 2: per-column envelopes, split into spans at gaps.
  const columnMs = spanMs / columns;
  const spans: TraceSpan[] = [];
  let current: TraceColumn[] | null = null;
  let previousEnd: number | null = null;
  let peak = 0;

  for (const segment of segments) {
    const [first, last] = sampleRange(segment, windowStartMs, windowEndMs);
    if (last < first) continue;

    const period = 1000 / segment.sampleRateHz;
    const segmentStart = segment.startTimeMs;
    if (
      current === null ||
      previousEnd === null ||
      segmentStart - previousEnd > GAP_TOLERANCE_SAMPLES * period
    ) {
      if (current !== null && current.length > 0) spans.push({ columns: current });
      current = [];
    }

    for (let i = first; i <= last; i += 1) {
      const value = segment.samples[i] ?? 0;
      const t = segmentStart + i * period;
      const column = Math.min(columns - 1, Math.floor((t - windowStartMs) / columnMs));
      const x = (column + 0.5) / columns;
      const tail = current[current.length - 1];
      if (tail !== undefined && tail.x === x) {
        if (value < tail.min) tail.min = value;
        if (value > tail.max) tail.max = value;
      } else {
        current.push({ x, min: value, max: value });
      }
      peak = Math.max(peak, Math.abs(value - meanCounts));
    }
    previousEnd = segmentEndMs(segment);
  }
  if (current !== null && current.length > 0) spans.push({ columns: current });

  return {
    spans,
    meanCounts,
    scaleCounts: niceScale(peak),
    gapFraction: Math.max(0, Math.min(1, 1 - coveredMs / spanMs)),
    newestSampleMs,
  };
}

/** Inclusive sample indices of `segment` falling inside [start, end). */
function sampleRange(segment: WaveformSegment, startMs: number, endMs: number): [number, number] {
  const period = 1000 / segment.sampleRateHz;
  const first = Math.max(0, Math.ceil((startMs - segment.startTimeMs) / period));
  const last = Math.min(
    segment.samples.length - 1,
    Math.ceil((endMs - segment.startTimeMs) / period) - 1,
  );
  return [first, last];
}

/**
 * A span as an SVG polyline `points` attribute, in a 0-100 × 0-100 viewBox
 * with the mean on the centre line — the convention `tidal-stress-track.ts`
 * uses. Each column contributes its top and bottom, so the envelope is drawn
 * as a zig-zag that fills in wherever the signal is dense.
 *
 * Clamped rather than allowed to overflow: the scale always covers the peak,
 * but a line escaping its row would cross the station above it.
 */
export function polylinePoints(span: TraceSpan, layout: TraceLayout): string {
  const y = (value: number) => {
    const offset = (value - layout.meanCounts) / layout.scaleCounts;
    return Math.max(0, Math.min(100, 50 - offset * 50)).toFixed(3);
  };
  return span.columns
    .map((column) => {
      const x = (column.x * 100).toFixed(3);
      return column.min === column.max
        ? `${x},${y(column.max)}`
        : `${x},${y(column.max)} ${x},${y(column.min)}`;
    })
    .join(' ');
}
