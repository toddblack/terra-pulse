import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Cesium from 'cesium';
import {
  attachPolarCaps,
  capRectangles,
  MERCATOR_LIMIT_RADIANS,
  POLAR_CAP_COLORS,
} from './polar-caps';
import { BASEMAP_REGISTRATIONS } from './registry';

/** Colours the layer painted, in the order it painted them. */
const painted: string[] = [];

/**
 * Node environment, no canvas — the same stub the field and aurora layer tests
 * use. Recording `fillStyle` is what lets the colour assertions below see
 * through the data URL.
 */
beforeAll(() => {
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        set fillStyle(value: string) {
          painted.push(value);
        },
        fillRect: vi.fn(),
      }),
      toDataURL: () => 'data:image/png;base64,stub',
    }),
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

interface FakeLayer {
  show: boolean;
}

function createFakeViewer(): {
  viewer: Cesium.Viewer;
  added: FakeLayer[];
  removed: FakeLayer[];
  lowered: FakeLayer[];
} {
  const added: FakeLayer[] = [];
  const removed: FakeLayer[] = [];
  const lowered: FakeLayer[] = [];

  const viewer = {
    isDestroyed: vi.fn(() => false),
    imageryLayers: {
      addImageryProvider: vi.fn(() => {
        const layer: FakeLayer = { show: true };
        added.push(layer);
        return layer;
      }),
      remove: vi.fn((layer: FakeLayer) => {
        removed.push(layer);
        return true;
      }),
      lowerToBottom: vi.fn((layer: FakeLayer) => {
        lowered.push(layer);
      }),
    },
  } as unknown as Cesium.Viewer;

  return { viewer, added, removed, lowered };
}

describe('polar cap geometry', () => {
  it('starts where Web Mercator actually stops', () => {
    // Not asserting 85.0511 for its own sake — asserting that the constant the
    // fill is built from is the same one Cesium tiles the basemap with. If
    // these ever disagree the caps draw a ring around each pole.
    expect(MERCATOR_LIMIT_RADIANS).toBe(new Cesium.WebMercatorTilingScheme().rectangle.north);
    expect(Cesium.Math.toDegrees(MERCATOR_LIMIT_RADIANS)).toBeCloseTo(85.0511, 4);
  });

  it('reaches both poles and covers all longitudes', () => {
    const { north, south } = capRectangles();
    expect(north.north).toBeCloseTo(Cesium.Math.PI_OVER_TWO, 12);
    expect(south.south).toBeCloseTo(-Cesium.Math.PI_OVER_TWO, 12);
    for (const rectangle of [north, south]) {
      expect(rectangle.west).toBeCloseTo(-Math.PI, 12);
      expect(rectangle.east).toBeCloseTo(Math.PI, 12);
    }
  });

  it('overlaps the basemap rather than meeting it exactly', () => {
    // The two edges are computed from one constant, so in principle they meet.
    // A half-pixel disagreement after tile bounds and texture coordinates draws
    // as a hairline ring, and the caps sit *below* the basemap, so overlapping
    // is free while leaving a gap is not.
    const { north, south } = capRectangles();
    expect(north.south).toBeLessThan(MERCATOR_LIMIT_RADIANS);
    expect(south.north).toBeGreaterThan(-MERCATOR_LIMIT_RADIANS);

    // Small enough that it hides under the basemap rather than eating map.
    const overlapDegrees = Cesium.Math.toDegrees(MERCATOR_LIMIT_RADIANS - north.south);
    expect(overlapDegrees).toBeGreaterThan(0);
    expect(overlapDegrees).toBeLessThan(0.25);
  });

  it('is symmetric about the equator', () => {
    const { north, south } = capRectangles();
    expect(north.south).toBeCloseTo(-south.north, 12);
  });
});

describe('polar cap colours', () => {
  it('covers exactly the Mercator basemaps', () => {
    // `seafloor` is served over WMS, which Cesium tiles geographically, so it
    // already reaches ±90°. A fill there would paint over real imagery — see
    // the note at the top of seafloor-basemap.ts.
    expect(Object.keys(POLAR_CAP_COLORS).sort()).toEqual(['osm', 'relief']);
  });

  it('names only basemaps that exist', () => {
    const ids = BASEMAP_REGISTRATIONS.map((entry) => entry.id as string);
    for (const id of Object.keys(POLAR_CAP_COLORS)) {
      expect(ids).toContain(id);
    }
  });

  it('gives each pole its own colour', () => {
    // The whole reason this is two imagery layers instead of one `baseColor`:
    // relief's Arctic is near-black ocean and its Antarctic is white ice, so no
    // single value can be right at both ends.
    for (const colors of Object.values(POLAR_CAP_COLORS)) {
      expect(colors.north).not.toBe(colors.south);
    }
  });
});

describe('attachPolarCaps', () => {
  it('adds one layer per pole, in the basemap’s colours', () => {
    const { viewer, added } = createFakeViewer();
    painted.length = 0;

    attachPolarCaps(viewer, POLAR_CAP_COLORS.relief);

    expect(added).toHaveLength(2);
    expect(painted).toEqual([POLAR_CAP_COLORS.relief.north, POLAR_CAP_COLORS.relief.south]);
  });

  it('lowers every cap beneath what is already there', () => {
    // Load-bearing: the caps overlap the basemap's last row on purpose, and
    // that is only harmless while the basemap draws on top of them.
    const { viewer, added, lowered } = createFakeViewer();

    attachPolarCaps(viewer, POLAR_CAP_COLORS.osm);

    expect(lowered).toEqual(added);
  });

  it('follows the basemap’s visibility', () => {
    const { viewer, added } = createFakeViewer();

    const caps = attachPolarCaps(viewer, POLAR_CAP_COLORS.osm);
    caps.setVisible(false);
    expect(added.every((layer) => layer.show === false)).toBe(true);

    caps.setVisible(true);
    expect(added.every((layer) => layer.show === true)).toBe(true);
  });

  it('removes both caps on detach', () => {
    const { viewer, added, removed } = createFakeViewer();

    const caps = attachPolarCaps(viewer, POLAR_CAP_COLORS.osm);
    caps.detach();

    expect(removed).toEqual(added);
  });

  it('does not touch an already-destroyed viewer', () => {
    const { viewer, removed } = createFakeViewer();

    const caps = attachPolarCaps(viewer, POLAR_CAP_COLORS.osm);
    (viewer.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);

    expect(() => caps.detach()).not.toThrow();
    expect(removed).toHaveLength(0);
  });
});
