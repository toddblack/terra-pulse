import { describe, expect, it } from 'vitest';
import { parseAuroraGrid } from './aurora';
import { AURORA_GRID_HEIGHT, AURORA_GRID_WIDTH, auroraPeak } from '@terra-pulse/schema';

/**
 * A synthetic grid in the product's own layout: longitude 0..359, latitude
 * -90..90, one triple per cell.
 *
 * Deliberately **not** a live network call. The suite already carries two of
 * those against EMSC and they make `pnpm test` non-deterministic whenever the
 * service is slow. The adapter was verified once against the real product —
 * observed 2026-08-14, peak 36%, activity 58,898 north / 95,939 south / 646 in
 * the tropics — and that geometry is what these fixtures encode.
 */
function fixture(at: (longitude: number, latitude: number) => number) {
  const coordinates: [number, number, number][] = [];
  for (let longitude = 0; longitude < 360; longitude += 1) {
    for (let latitude = -90; latitude <= 90; latitude += 1) {
      coordinates.push([longitude, latitude, at(longitude, latitude)]);
    }
  }
  return {
    'Observation Time': '2026-08-14T06:41:00Z',
    'Forecast Time': '2026-08-14T07:56:00Z',
    coordinates,
  };
}

const FETCHED_AT = '2026-08-14T06:45:00Z';

describe('parseAuroraGrid', () => {
  it('keeps the timestamps and records when we fetched', () => {
    const grid = parseAuroraGrid(fixture(() => 0), FETCHED_AT);
    expect(grid.observedAtUtc).toBe('2026-08-14T06:41:00Z');
    expect(grid.forecastForUtc).toBe('2026-08-14T07:56:00Z');
    // Ours, not SWPC's — staleness must not depend on their clock being right.
    expect(grid.fetchedAtUtc).toBe(FETCHED_AT);
  });

  it('produces one byte per cell', () => {
    const grid = parseAuroraGrid(fixture(() => 7), FETCHED_AT);
    expect(grid.values).toHaveLength(AURORA_GRID_WIDTH * AURORA_GRID_HEIGHT);
    expect(grid.values.every((v) => v === 7)).toBe(true);
  });

  it('puts the north pole in the first row, not the last', () => {
    // Image order, not the product's south-first order. Getting this backwards
    // renders a perfectly plausible aurora over the wrong hemisphere.
    const grid = parseAuroraGrid(fixture((_lon, lat) => (lat === 90 ? 99 : 0)), FETCHED_AT);
    expect(grid.values[0]).toBe(99);
    expect(grid.values[grid.values.length - 1]).toBe(0);
  });

  it('re-bases longitude so column zero is the antimeridian', () => {
    // The product starts at the prime meridian; an equirectangular image starts
    // at -180. Skipping this puts the Pacific over Africa.
    const grid = parseAuroraGrid(fixture((lon) => (lon === 0 ? 88 : 0)), FETCHED_AT);
    const row = 0;
    expect(grid.values[row * AURORA_GRID_WIDTH + 180]).toBe(88);
    expect(grid.values[row * AURORA_GRID_WIDTH + 0]).toBe(0);
  });

  it('maps longitude 180 to the left edge', () => {
    const grid = parseAuroraGrid(fixture((lon) => (lon === 180 ? 55 : 0)), FETCHED_AT);
    expect(grid.values[0]).toBe(55);
  });

  it('reports the peak', () => {
    const grid = parseAuroraGrid(fixture((_lon, lat) => (lat === 65 ? 42 : 3)), FETCHED_AT);
    expect(auroraPeak(grid)).toBe(42);
  });

  it('rejects a grid of the wrong shape rather than rendering it skewed', () => {
    const short = { ...fixture(() => 0), coordinates: [[0, 0, 0]] as [number, number, number][] };
    expect(() => parseAuroraGrid(short, FETCHED_AT)).toThrow(/expected 65160 cells/);
  });

  it('rejects a response with no timestamps', () => {
    const undated = { ...fixture(() => 0), 'Observation Time': '' };
    expect(() => parseAuroraGrid(undated, FETCHED_AT)).toThrow(/timestamps/);
  });
});
