import { describe, expect, it } from 'vitest';
import { auroraColor, auroraLegendStops, paintAuroraRgba } from './aurora-encoding';
import {
  AURORA_GRID_HEIGHT,
  AURORA_GRID_WIDTH,
  AURORA_MAX_PROBABILITY,
  AURORA_VISIBLE_THRESHOLD,
  type AuroraGrid,
} from '@terra-pulse/schema';

function gridOf(fill: (index: number) => number): AuroraGrid {
  const values = new Uint8Array(AURORA_GRID_WIDTH * AURORA_GRID_HEIGHT);
  for (let i = 0; i < values.length; i += 1) values[i] = fill(i);
  return {
    observedAtUtc: '2026-08-14T06:41:00Z',
    forecastForUtc: '2026-08-14T07:56:00Z',
    fetchedAtUtc: '2026-08-14T06:45:00Z',
    width: AURORA_GRID_WIDTH,
    height: AURORA_GRID_HEIGHT,
    values,
  };
}

describe('auroraColor', () => {
  it('draws nothing at all below the visibility threshold', () => {
    // Zero is an absence, not a small value. Painting it with the bottom of the
    // ramp would wash the whole planet faintly green — roughly 70% of cells are
    // zero on a quiet grid.
    expect(auroraColor(0)[3]).toBe(0);
    expect(auroraColor(AURORA_VISIBLE_THRESHOLD - 0.5)[3]).toBe(0);
  });

  it('fades in rather than cutting a hard edge at the threshold', () => {
    // The oval has no edge in nature; a step from transparent to opaque would
    // draw a contour that belongs to the threshold, not the data.
    const faint = auroraColor(AURORA_VISIBLE_THRESHOLD)[3];
    const stronger = auroraColor(AURORA_VISIBLE_THRESHOLD + 3)[3];
    expect(faint).toBeLessThan(stronger);
  });

  it('reaches full opacity well below the top of the scale', () => {
    // Alpha carries "is there anything here", not magnitude — hue does that.
    // Opacity climbing across the whole range would encode it twice.
    expect(auroraColor(20)[3]).toBe(auroraColor(AURORA_MAX_PROBABILITY)[3]);
  });

  it('gets lighter as the probability rises', () => {
    const luminance = (p: number) => {
      const [r, g, b] = auroraColor(p);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    let previous = -Infinity;
    for (let p = 6; p <= AURORA_MAX_PROBABILITY; p += 6) {
      const current = luminance(p);
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
  });

  it('is green-dominant, because that is what the aurora emits', () => {
    // 557.7 nm atomic oxygen. Literal rather than decorative.
    const [r, g, b] = auroraColor(30);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  it('clamps above the top of the scale rather than wrapping', () => {
    expect(auroraColor(100)).toEqual(auroraColor(AURORA_MAX_PROBABILITY));
  });
});

describe('paintAuroraRgba', () => {
  it('produces four bytes per cell', () => {
    const rgba = paintAuroraRgba(gridOf(() => 0));
    expect(rgba).toHaveLength(AURORA_GRID_WIDTH * AURORA_GRID_HEIGHT * 4);
  });

  it('leaves an empty grid completely transparent', () => {
    const rgba = paintAuroraRgba(gridOf(() => 0));
    for (let i = 3; i < rgba.length; i += 4) expect(rgba[i]).toBe(0);
  });

  it('paints only the active cells', () => {
    // The localisation is the encoding: a quiet grid must not become a global
    // green wash.
    const rgba = paintAuroraRgba(gridOf((i) => (i < 100 ? 40 : 0)));
    let opaque = 0;
    for (let i = 3; i < rgba.length; i += 4) if ((rgba[i] ?? 0) > 0) opaque += 1;
    expect(opaque).toBe(100);
  });
});

describe('auroraLegendStops', () => {
  it('spans up to the top of the scale', () => {
    const stops = auroraLegendStops(5);
    expect(stops).toHaveLength(5);
    expect(stops[4]?.value).toBe(AURORA_MAX_PROBABILITY);
  });

  it('emits usable css colours', () => {
    for (const stop of auroraLegendStops()) {
      expect(stop.color).toMatch(/^rgb\(\d+ \d+ \d+\)$/);
    }
  });
});

describe('the equatorial seam', () => {
  it('suppresses NOAA grid artifacts near the equator', () => {
    // Measured on the live product: latitudes 0, -1 and -2 carry values of 1-4
    // across ~90% of longitudes while every row from +1 to +40 and -3 to -40 is
    // exactly zero. It drew as a faint green line right around the globe.
    const values = new Uint8Array(AURORA_GRID_WIDTH * AURORA_GRID_HEIGHT);
    const equatorRow = 90; // rows are north-first, so row 90 is latitude 0
    for (let col = 0; col < AURORA_GRID_WIDTH; col += 1) {
      values[equatorRow * AURORA_GRID_WIDTH + col] = 4;
    }

    const rgba = paintAuroraRgba({
      observedAtUtc: '2026-08-14T06:41:00Z',
      forecastForUtc: '2026-08-14T07:56:00Z',
      fetchedAtUtc: '2026-08-14T06:45:00Z',
      width: AURORA_GRID_WIDTH,
      height: AURORA_GRID_HEIGHT,
      values,
    });

    for (let col = 0; col < AURORA_GRID_WIDTH; col += 1) {
      expect(rgba[(equatorRow * AURORA_GRID_WIDTH + col) * 4 + 3]).toBe(0);
    }
  });

  it('leaves genuine polar aurora alone', () => {
    // The suppression must not eat the thing it is protecting.
    const values = new Uint8Array(AURORA_GRID_WIDTH * AURORA_GRID_HEIGHT);
    const polarRow = 25; // latitude +65
    values[polarRow * AURORA_GRID_WIDTH + 10] = 30;

    const rgba = paintAuroraRgba({
      observedAtUtc: '2026-08-14T06:41:00Z',
      forecastForUtc: '2026-08-14T07:56:00Z',
      fetchedAtUtc: '2026-08-14T06:45:00Z',
      width: AURORA_GRID_WIDTH,
      height: AURORA_GRID_HEIGHT,
      values,
    });

    expect(rgba[(polarRow * AURORA_GRID_WIDTH + 10) * 4 + 3]).toBeGreaterThan(0);
  });
});
