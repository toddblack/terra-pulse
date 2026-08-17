import { describe, expect, it } from 'vitest';
import { TEC_GRID_HEIGHT, TEC_GRID_WIDTH } from '@terra-pulse/schema';
import { parseTecGrid } from './swpc-tec';

/** One cell, in the product's real shape. */
function cell(longitude: number, latitude: number, tec: number, anomaly = 0, flag = 0) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [longitude, latitude] },
    properties: { tec, anomaly, hmF2: 336, NmF2: 2.03e11, quality_flag: flag },
  };
}

const collection = (features: unknown[], timeTag = '2026-08-16T04:15:00Z') => ({
  type: 'FeatureCollection',
  time_tag: timeTag,
  features,
});

describe('parseTecGrid', () => {
  it('places a cell from its own coordinates, not its position in the list', () => {
    // The product happens to emit features in a consistent order and nothing
    // documents that. A raster built by consuming them in sequence would render
    // a plausible but scrambled image the first time that changed.
    const grid = parseTecGrid(
      collection([cell(-177.5, 88.75, 42), cell(-177.5, -88.75, 7)]),
    );

    // Row 0 is northernmost, column 0 is longitude -180 — what an image wants,
    // while the product runs south-first.
    expect(grid.tec[0]).toBe(42);
    expect(grid.tec[(TEC_GRID_HEIGHT - 1) * TEC_GRID_WIDTH]).toBe(7);
  });

  it('is unaffected by reordering the features', () => {
    const forwards = parseTecGrid(collection([cell(-177.5, 88.75, 42), cell(2.5, 1.25, 19)]));
    const backwards = parseTecGrid(collection([cell(2.5, 1.25, 19), cell(-177.5, 88.75, 42)]));
    expect(backwards.tec).toEqual(forwards.tec);
  });

  it('leaves an unsupplied cell null rather than zero', () => {
    // Zero TECU is a physical claim — no ionosphere above that point — and
    // nobody is making it. A missing cell has to stay missing.
    const grid = parseTecGrid(collection([cell(-177.5, 88.75, 42)]));
    expect(grid.tec[0]).toBe(42);
    expect(grid.tec[1]).toBeNull();
    expect(grid.tec.filter((v) => v !== null)).toHaveLength(1);
  });

  it('allocates the full pinned grid whatever arrives', () => {
    const grid = parseTecGrid(collection([cell(0, 0, 10)]));
    expect(grid.tec).toHaveLength(TEC_GRID_WIDTH * TEC_GRID_HEIGHT);
    expect(grid.anomaly).toHaveLength(TEC_GRID_WIDTH * TEC_GRID_HEIGHT);
    expect(grid.qualityFlag).toHaveLength(TEC_GRID_WIDTH * TEC_GRID_HEIGHT);
  });

  it('keeps tec, anomaly and the quality flag on the same cell', () => {
    const grid = parseTecGrid(collection([cell(-177.5, 88.75, 42, -3.5, 5)]));
    expect(grid.tec[0]).toBe(42);
    expect(grid.anomaly[0]).toBe(-3.5);
    expect(grid.qualityFlag[0]).toBe(5);
  });

  it('keeps a negative anomaly, which is half its range', () => {
    // The anomaly diverges around zero — depleted is as real as enhanced, and
    // clamping it at zero would erase half the signal.
    const grid = parseTecGrid(collection([cell(0, 0, 10, -8.2)]));
    const index = grid.anomaly.findIndex((v) => v !== null);
    expect(grid.anomaly[index]).toBe(-8.2);
  });

  it('drops a cell outside the grid rather than wrapping it', () => {
    // A wrapped cell would land on a real position and be indistinguishable
    // from a measurement.
    const grid = parseTecGrid(collection([cell(400, 0, 99), cell(0, 200, 99)]));
    expect(grid.tec.every((v) => v === null)).toBe(true);
  });

  it('ignores a feature with no usable geometry', () => {
    const grid = parseTecGrid(
      collection([
        { type: 'Feature', geometry: null, properties: { tec: 5 } },
        cell(-177.5, 88.75, 42),
      ]),
    );
    expect(grid.tec.filter((v) => v !== null)).toEqual([42]);
  });

  it('carries the map time, and falls back rather than throwing', () => {
    expect(parseTecGrid(collection([cell(0, 0, 1)])).observedAtUtc).toBe(
      '2026-08-16T04:15:00Z',
    );
    const noTag = parseTecGrid({ type: 'FeatureCollection', features: [cell(0, 0, 1)] });
    expect(Number.isFinite(Date.parse(noTag.observedAtUtc))).toBe(true);
  });

  it('rejects a payload that is not a feature collection', () => {
    expect(() => parseTecGrid(null)).toThrow();
    expect(() => parseTecGrid({})).toThrow(/features/i);
  });
});
