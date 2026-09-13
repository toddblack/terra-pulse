import { describe, expect, it } from 'vitest';
import type { WaveformSegment } from '@terra-pulse/schema';
import { layoutWaveform, niceScale, polylinePoints } from './waveform-trace';

const RATE = 100;
const BASE = Date.UTC(2026, 8, 10, 6, 0, 0);
const WINDOW_MS = 120_000;
const START = BASE;
const END = BASE + WINDOW_MS;

function segment(atSeconds: number, samples: number[] | Int32Array): WaveformSegment {
  return {
    channelId: 'CI_ADO__HHZ',
    startTimeMs: BASE + atSeconds * 1000,
    sampleRateHz: RATE,
    samples: samples instanceof Int32Array ? samples : Int32Array.from(samples),
  };
}

/** A flat run of `seconds` seconds at `value`, starting at `atSeconds`. */
function flat(atSeconds: number, seconds: number, value = 0): WaveformSegment {
  return segment(atSeconds, new Int32Array(seconds * RATE).fill(value));
}

describe('niceScale', () => {
  it('snaps up to the 1-2-5 ladder so the scale steps rather than breathes', () => {
    expect(niceScale(1)).toBe(1);
    expect(niceScale(1.1)).toBe(2);
    expect(niceScale(2)).toBe(2);
    expect(niceScale(2.1)).toBe(5);
    expect(niceScale(600)).toBe(1000);
    expect(niceScale(12_345)).toBe(20_000);
  });

  it('never returns zero, so nothing divides by it', () => {
    expect(niceScale(0)).toBe(1);
    expect(niceScale(-5)).toBe(1);
    expect(niceScale(Number.NaN)).toBe(1);
  });
});

describe('layoutWaveform', () => {
  it('reports an empty window as entirely gap', () => {
    const layout = layoutWaveform([], START, END, 300);
    expect(layout).toMatchObject({ spans: [], gapFraction: 1, newestSampleMs: null });
  });

  it('keeps a one-sample spike that stride sampling would lose', () => {
    // 60 s of silence with a single spike two samples wide, and 300 columns
    // over 120 s — 40 samples per column.
    const samples = new Int32Array(60 * RATE);
    // Deliberately off the stride: 3,001 is not a multiple of 40. A spike that
    // happens to land on it would survive stride sampling and prove nothing.
    samples[3_001] = 5_000;
    samples[3_002] = -5_000;
    const layout = layoutWaveform([segment(0, samples)], START, END, 300);

    const peak = Math.max(...layout.spans.flatMap((span) => span.columns.map((c) => c.max)));
    const trough = Math.min(...layout.spans.flatMap((span) => span.columns.map((c) => c.min)));
    expect(peak).toBe(5_000);
    expect(trough).toBe(-5_000);

    // The companion half of the claim: taking every 40th sample misses both.
    const strided: number[] = [];
    for (let i = 0; i < samples.length; i += 40) strided.push(samples[i] ?? 0);
    expect(Math.max(...strided)).toBe(0);
    expect(Math.min(...strided)).toBe(0);
  });

  it('splits a span at a gap and never bridges it', () => {
    // One second at 0, then nothing until 10 s.
    const layout = layoutWaveform([flat(0, 1, 10), flat(10, 1, 20)], START, END, 300);
    expect(layout.spans).toHaveLength(2);
  });

  it('keeps abutting segments in one span', () => {
    const layout = layoutWaveform([flat(0, 1, 10), flat(1, 1, 20)], START, END, 300);
    expect(layout.spans).toHaveLength(1);
  });

  it('measures the share of the window with no data', () => {
    const layout = layoutWaveform([flat(0, 30)], START, END, 300);
    expect(layout.gapFraction).toBeCloseTo(0.75, 2);
  });

  it('removes the mean, since a broadband channel sits on an arbitrary offset', () => {
    const layout = layoutWaveform([flat(0, 10, 48_000)], START, END, 300);
    expect(layout.meanCounts).toBeCloseTo(48_000, 6);
    // Drawn on the centre line despite an offset of tens of thousands of counts.
    const points = polylinePoints(layout.spans[0] ?? { columns: [] }, layout);
    expect(points.split(' ').every((point) => point.endsWith(',50.000'))).toBe(true);
  });

  it('scales to the peak deviation, snapped', () => {
    const samples = new Int32Array(RATE).fill(100);
    samples[10] = 700; // 600 above the mean-ish level
    const layout = layoutWaveform([segment(0, samples)], START, END, 300);
    expect(layout.scaleCounts).toBe(1_000);
  });

  it('ignores samples outside the window', () => {
    const before = segment(-30, new Int32Array(10 * RATE).fill(7));
    const layout = layoutWaveform([before, flat(0, 1, 0)], START, END, 300);
    expect(layout.meanCounts).toBe(0);
  });

  it('reports the newest sample instant, which is where the blank right edge starts', () => {
    const layout = layoutWaveform([flat(0, 1), flat(5, 2)], START, END, 300);
    expect(layout.newestSampleMs).toBe(BASE + 7_000);
  });
});

describe('polylinePoints', () => {
  it('emits each column top then bottom, clamped into the viewBox', () => {
    const layout = layoutWaveform([segment(0, [-10_000, 10_000])], START, END, 300);
    const span = layout.spans[0];
    if (span === undefined) throw new Error('expected a span');
    const points = polylinePoints(span, layout).split(' ');
    expect(points).toHaveLength(2);
    for (const point of points) {
      const y = Number(point.split(',')[1]);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(100);
    }
  });

  it('emits one point for a column with no range', () => {
    const layout = layoutWaveform([flat(0, 1, 5)], START, END, 300);
    const span = layout.spans[0];
    if (span === undefined) throw new Error('expected a span');
    expect(polylinePoints(span, layout).split(' ')).toHaveLength(span.columns.length);
  });
});
