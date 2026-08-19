import { describe, expect, it } from 'vitest';
import { layoutNullHistogram, observedFraction } from './null-histogram';

describe('layoutNullHistogram', () => {
  it('lays out bars spanning the full width and normalized to the tallest bar', () => {
    const bars = layoutNullHistogram({ edges: [0, 1, 2, 3], counts: [5, 10, 5] });

    expect(bars).toHaveLength(3);
    expect(bars[0]).toMatchObject({ x: 0, width: 1 / 3, height: 0.5 });
    expect(bars[1]).toMatchObject({ x: 1 / 3, width: 1 / 3, height: 1 });
    expect(bars[2]).toMatchObject({ x: 2 / 3, width: 1 / 3, height: 0.5 });
  });

  it('returns an empty array for no bins', () => {
    expect(layoutNullHistogram({ edges: [], counts: [] })).toEqual([]);
  });

  it('handles every bin being empty without dividing by zero', () => {
    const bars = layoutNullHistogram({ edges: [0, 1, 2], counts: [0, 0] });
    expect(bars.every((bar) => bar.height === 0)).toBe(true);
    expect(bars.every((bar) => Number.isFinite(bar.height))).toBe(true);
  });

  it('handles a single bin spanning zero width without dividing by zero', () => {
    const bars = layoutNullHistogram({ edges: [5, 5], counts: [3] });
    expect(bars).toHaveLength(1);
    expect(Number.isFinite(bars[0]?.x)).toBe(true);
  });
});

describe('observedFraction', () => {
  it('places the observed value proportionally within the range', () => {
    expect(observedFraction({ edges: [0, 10], counts: [1] }, 2.5)).toBeCloseTo(0.25);
  });

  it('clamps a value below the range to 0, not null', () => {
    expect(observedFraction({ edges: [0, 10], counts: [1] }, -5)).toBe(0);
  });

  it('clamps a value above the range to 1 — the small-p-value case must still draw', () => {
    expect(observedFraction({ edges: [0, 10], counts: [1] }, 500)).toBe(1);
  });

  it('returns null for a degenerate (zero-width) range', () => {
    expect(observedFraction({ edges: [5, 5], counts: [1] }, 5)).toBeNull();
  });

  it('returns null when there are no edges at all', () => {
    expect(observedFraction({ edges: [], counts: [] }, 5)).toBeNull();
  });

  it('returns null for a non-finite observed value', () => {
    expect(observedFraction({ edges: [0, 10], counts: [1] }, NaN)).toBeNull();
  });
});
