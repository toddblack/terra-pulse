import { describe, expect, it } from 'vitest';
import { layoutPhaseRose, phasePoint } from './phase-rose';

describe('phasePoint', () => {
  it('places 0 degrees at the top', () => {
    const p = phasePoint(0, 1);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(-1);
  });

  it('places 90 degrees on the right — increasing clockwise', () => {
    const p = phasePoint(90, 1);
    expect(p.x).toBeCloseTo(1);
    expect(p.y).toBeCloseTo(0);
  });

  it('places -90 degrees on the left', () => {
    const p = phasePoint(-90, 1);
    expect(p.x).toBeCloseTo(-1);
    expect(p.y).toBeCloseTo(0);
  });

  it('wraps +180 and -180 onto the same point at the bottom', () => {
    const positive = phasePoint(180, 1);
    const negative = phasePoint(-180, 1);
    expect(positive.x).toBeCloseTo(negative.x);
    expect(positive.y).toBeCloseTo(negative.y);
    expect(positive.y).toBeCloseTo(1);
  });

  it('scales by the given radius', () => {
    const point = phasePoint(90, 0.5);
    expect(point.x).toBeCloseTo(0.5);
    expect(point.y).toBeCloseTo(0);
  });
});

describe('layoutPhaseRose', () => {
  it('returns one wedge per bin, normalized to the tallest', () => {
    const wedges = layoutPhaseRose({ edges: [-180, -90, 0, 90, 180], counts: [5, 10, 5, 0] });
    expect(wedges).toHaveLength(4);
    // Every wedge's outline starts at the centre.
    for (const wedge of wedges) {
      expect(wedge.points[0]).toEqual({ x: 0, y: 0 });
    }
  });

  it("scales each wedge's arc points to that bin's own radius fraction", () => {
    const wedges = layoutPhaseRose({ edges: [-180, -90, 0], counts: [10, 5] });
    const tallest = wedges[0]?.points[1];
    const half = wedges[1]?.points[1];
    expect(tallest).toBeDefined();
    expect(half).toBeDefined();
    // Both start at angle -180 / -90 respectively at radius 1 and 0.5.
    expect(tallest?.x).toBeCloseTo(0);
    expect(tallest?.y).toBeCloseTo(1);
    expect(half?.x).toBeCloseTo(-0.5);
    expect(half?.y).toBeCloseTo(0);
  });

  it('collapses every wedge to the centre point when every bin is empty', () => {
    const wedges = layoutPhaseRose({ edges: [-180, -90, 0], counts: [0, 0] });
    for (const wedge of wedges) {
      for (const point of wedge.points) {
        expect(point.x).toBeCloseTo(0);
        expect(point.y).toBeCloseTo(0);
      }
    }
  });

  it('returns an empty array for no bins', () => {
    expect(layoutPhaseRose({ edges: [], counts: [] })).toEqual([]);
  });

  it("the wedge's arc starts and ends at its own bin edges", () => {
    const wedges = layoutPhaseRose({ edges: [0, 30], counts: [4] });
    const wedge = wedges[0];
    expect(wedge).toBeDefined();
    const arc = wedge?.points.slice(1) ?? [];
    expect(arc[0]?.x).toBeCloseTo(0);
    expect(arc[0]?.y).toBeCloseTo(-1);
    const last = arc[arc.length - 1];
    expect(last?.x).toBeCloseTo(Math.sin((30 * Math.PI) / 180));
    expect(last?.y).toBeCloseTo(-Math.cos((30 * Math.PI) / 180));
  });
});
