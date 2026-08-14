import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Cesium from 'cesium';
import {
  GEOMAGNETIC_FIELD_LAYER_ID,
  createGeomagneticFieldLayer,
  frameYears,
  isGeomagneticFieldLayer,
  nearestFrameYear,
} from './geomagnetic-field';
import { IGRF_FIRST_YEAR, IGRF_LAST_YEAR } from './igrf';
import type { FieldQuantity } from './igrf';
import type { GeomagneticFieldLayer } from './geomagnetic-field';
import type { GlobeLayer } from '@terra-pulse/schema';

/**
 * These run in the node environment, which has no canvas and no image pipeline.
 * The layer needs `createElement('canvas')` to yield something with a 2d context
 * and `toDataURL`; it already guards on a null context, which is what makes a
 * stub safe.
 */
beforeAll(() => {
  const context = {
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: vi.fn(),
  };
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => context,
      toDataURL: () => 'data:image/png;base64,stub',
    }),
  });
});

beforeEach(() => {
  vi.spyOn(Cesium.SingleTileImageryProvider, 'fromUrl').mockResolvedValue(
    {} as unknown as Cesium.SingleTileImageryProvider,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface FakeLayer {
  show: boolean;
  alpha: number;
}

function createFakeViewer(): {
  viewer: Cesium.Viewer;
  added: FakeLayer[];
  removed: FakeLayer[];
} {
  const added: FakeLayer[] = [];
  const removed: FakeLayer[] = [];

  const viewer = {
    isDestroyed: vi.fn(() => false),
    imageryLayers: {
      addImageryProvider: vi.fn(() => {
        const layer: FakeLayer = { show: false, alpha: 1 };
        added.push(layer);
        return layer;
      }),
      remove: vi.fn((layer: FakeLayer) => {
        removed.push(layer);
        return true;
      }),
    },
  } as unknown as Cesium.Viewer;

  return { viewer, added, removed };
}

/**
 * A coarse grid and a wide frame step, so the suite doesn't pay 66 x 38 ms of
 * spherical-harmonic sampling per warm-up. The production values are asserted
 * separately against `frameYears()`.
 */
const TEST_SIZING = { gridWidth: 24, gridHeight: 13, frameStepYears: 20 } as const;

const makeLayer = (quantity: FieldQuantity = 'intensity') =>
  createGeomagneticFieldLayer('dark', quantity, TEST_SIZING);

/** Runs microtasks until the frame set stops growing. */
async function drain(layer?: GeomagneticFieldLayer): Promise<void> {
  let previous = -1;
  for (let round = 0; round < 400; round += 1) {
    await Promise.resolve();
    if (!layer) continue;
    const { ready, total } = layer.frameProgress();
    if (ready === total) return;
    if (round % 8 === 0) {
      if (ready === previous) return;
      previous = ready;
    }
  }
}

/** Just enough microtasks for the first frame or two. */
async function drainSome(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

describe('frame grid', () => {
  it('spans the model end to end', () => {
    const years = frameYears();
    expect(years[0]).toBe(IGRF_FIRST_YEAR);
    expect(years[years.length - 1]).toBeLessThanOrEqual(IGRF_LAST_YEAR);
    expect(years.length).toBeGreaterThan(50);
  });

  it('is evenly spaced', () => {
    const years = frameYears();
    const steps = new Set(years.slice(1).map((y, i) => y - (years[i] ?? 0)));
    expect(steps.size).toBe(1);
  });

  it('snaps a date to its nearest frame', () => {
    expect(nearestFrameYear(1900)).toBe(1900);
    expect(nearestFrameYear(1900.9)).toBe(1900);
    expect(nearestFrameYear(1901.5)).toBe(1902);
  });

  it('clamps outside the model rather than inventing frames', () => {
    expect(nearestFrameYear(1500)).toBe(IGRF_FIRST_YEAR);
    expect(nearestFrameYear(2500)).toBeLessThanOrEqual(IGRF_LAST_YEAR);
  });
});

describe('geomagnetic field layer', () => {
  it('conforms to the GlobeLayer contract', () => {
    const layer = makeLayer();
    expect(layer.id).toBe(GEOMAGNETIC_FIELD_LAYER_ID);
    expect(layer.category).toBe('overlay');
    expect(layer.defaultVisible).toBe(false);
  });

  it('shows something as soon as the first frame is ready', async () => {
    // `useGlobeLayers` toggles overlays by mounting and unmounting and never
    // calls `setVisible`, so mounted has to mean visible.
    const layer = makeLayer();
    const { viewer, added } = createFakeViewer();

    layer.mount(viewer);
    await drainSome();

    expect(added.length).toBeGreaterThan(0);
    expect(added.some((l) => l.alpha > 0)).toBe(true);
  });

  it('builds the frame under the playhead first', async () => {
    // So the layer appears immediately rather than after sixty-odd frames — and
    // for the *right* year: `mountOverlays` sets the window immediately after
    // mounting, so the build has to wait for that before choosing.
    const layer = makeLayer();
    const { viewer, added } = createFakeViewer();

    layer.mount(viewer);
    layer.setTimeWindow(new Date('1902-01-01T00:00:00Z'), new Date('1902-01-01T00:00:00Z'));
    await drainSome();

    // The first frame built is the one under the playhead, and it is the one
    // on screen — the rest fill in around it.
    expect(added.length).toBeGreaterThan(0);
    expect(added[0]?.alpha).toBeGreaterThan(0);
    expect(added.filter((l) => l.alpha > 0)).toHaveLength(1);
  });

  it('eventually builds every frame', async () => {
    const layer = makeLayer();
    const { viewer } = createFakeViewer();

    layer.mount(viewer);
    await drain(layer);

    const { ready, total } = layer.frameProgress();
    expect(ready).toBe(total);
  });

  it('draws the selected frame below full opacity so the basemap survives', async () => {
    const layer = makeLayer();
    const { viewer, added } = createFakeViewer();
    layer.mount(viewer);
    await drainSome();
    const shown = added.find((l) => l.alpha > 0);
    expect(shown?.alpha).toBeLessThan(1);
  });

  it('never toggles `show` on a frame, because hiding destroys its texture', async () => {
    // `_onLayerShownOrHidden` routes a hide to `_onLayerRemoved`, so Cesium
    // tears down the tile imagery and rebuilds it on the way back — which is
    // what made playback flicker at an even rate. Selection moves alpha only.
    const layer = makeLayer();
    const { viewer, added } = createFakeViewer();
    layer.mount(viewer);
    await drain(layer);

    for (let year = 1900; year <= 2020; year += 5) {
      layer.setTimeWindow(new Date(Date.UTC(year, 0, 1)), new Date(Date.UTC(year, 0, 1)));
    }

    expect(added.every((l) => l.show)).toBe(true);
  });

  it('removes every frame on unmount', async () => {
    const layer = makeLayer();
    const { viewer, added, removed } = createFakeViewer();

    layer.mount(viewer);
    await drain(layer);
    const built = added.length;
    layer.unmount();

    expect(removed).toHaveLength(built);
    expect(layer.frameProgress().ready).toBe(0);
  });

  it('stops building once unmounted', async () => {
    // Otherwise the build keeps rendering frames and attaching them to a viewer
    // nobody is tracking any more.
    const layer = makeLayer();
    const { viewer } = createFakeViewer();

    layer.mount(viewer);
    await drainSome();
    layer.unmount();
    await drain(layer);

    expect(layer.frameProgress().ready).toBe(0);
  });

  it('does not touch an already-destroyed viewer on unmount', async () => {
    const layer = makeLayer();
    const { viewer, removed } = createFakeViewer();
    layer.mount(viewer);
    await drainSome();
    (viewer.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);

    expect(() => {
      layer.unmount();
    }).not.toThrow();
    expect(removed).toHaveLength(0);
  });

  it('does nothing on unmount if never mounted', () => {
    const layer = makeLayer();
    expect(() => {
      layer.unmount();
    }).not.toThrow();
  });

  it('is narrowed by isGeomagneticFieldLayer, and other layers are not', () => {
    const layer = makeLayer();
    expect(isGeomagneticFieldLayer(layer)).toBe(true);
    expect(isGeomagneticFieldLayer({ id: 'active-faults' } as unknown as GlobeLayer)).toBe(false);
  });
});

describe('geomagnetic field layer — playback', () => {
  /**
   * What all of this is for, in the user's words: "it's stuck on an initial
   * state and at the end of the animation it pops to the current/live state".
   *
   * The previous design rebuilt the raster on every tick, which meant an async
   * PNG decode on the frame path. Under playback the decode was starved and
   * every frame was discarded. Moving the playhead must now touch nothing but
   * boolean flags.
   */
  it('changes frame without building anything', async () => {
    const layer = makeLayer();
    const { viewer, added, removed } = createFakeViewer();
    layer.mount(viewer);
    await drain(layer);

    const builtBefore = added.length;
    const removedBefore = removed.length;

    // A full playthrough of the widest span, at the real 50 ms tick rate.
    for (let year = IGRF_FIRST_YEAR; year <= IGRF_LAST_YEAR; year += 0.5) {
      layer.setTimeWindow(
        new Date(Date.UTC(Math.floor(year), 0, 1)),
        new Date(Date.UTC(Math.floor(year), 0, 1)),
      );
    }

    // Nothing was created and nothing was destroyed — the entire animation is
    // visibility flags over an already-built set.
    expect(added).toHaveLength(builtBefore);
    expect(removed).toHaveLength(removedBefore);
  });

  it('shows exactly one frame at a time', async () => {
    const layer = makeLayer();
    const { viewer, added } = createFakeViewer();
    layer.mount(viewer);
    await drain(layer);

    for (const year of [1900, 1950, 2000, 2026]) {
      layer.setTimeWindow(new Date(Date.UTC(year, 0, 1)), new Date(Date.UTC(year, 0, 1)));
      expect(added.filter((l) => l.alpha > 0)).toHaveLength(1);
    }
  });

  it('advances through distinct frames as the playhead moves', async () => {
    // The actual complaint was that it never moved. Distinct layer objects have
    // to take the visible slot as the years pass.
    const layer = makeLayer();
    const { viewer, added } = createFakeViewer();
    layer.mount(viewer);
    await drain(layer);

    const seen = new Set<FakeLayer>();
    for (let year = 1900; year <= 2020; year += 5) {
      layer.setTimeWindow(new Date(Date.UTC(year, 0, 1)), new Date(Date.UTC(year, 0, 1)));
      const shown = added.find((l) => l.alpha > 0);
      if (shown) seen.add(shown);
    }

    // One distinct frame per step across the span — six at the test step, and
    // the real layer has 66. The point is that it is many, not one.
    expect(seen.size).toBeGreaterThan(5);
  });

  it('keeps a frame up while the next one is still unbuilt', async () => {
    // A partly-warm layer must degrade to a coarser animation, never to a blank
    // globe — which is what the old design did.
    const layer = makeLayer();
    const { viewer, added } = createFakeViewer();
    layer.mount(viewer);
    await drainSome();

    expect(added.some((l) => l.alpha > 0)).toBe(true);
    layer.setTimeWindow(new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'));
    expect(added.some((l) => l.alpha > 0)).toBe(true);
  });

  it('hides and restores the shown frame with setVisible', async () => {
    const layer = makeLayer();
    const { viewer, added } = createFakeViewer();
    layer.mount(viewer);
    await drain(layer);

    layer.setVisible(false);
    expect(added.filter((l) => l.alpha > 0)).toHaveLength(0);

    layer.setVisible(true);
    expect(added.filter((l) => l.alpha > 0)).toHaveLength(1);
    // Still mounted, still resident — only alpha moved.
    expect(added.every((l) => l.show)).toBe(true);
  });
});

describe('geomagnetic field layer — quantity', () => {
  it('discards every frame and rebuilds on a quantity change', async () => {
    // Each frame is a picture of the old quantity, so none of them survive.
    const layer = makeLayer('intensity');
    const { viewer, added, removed } = createFakeViewer();
    layer.mount(viewer);
    await drain(layer);
    const first = added.length;

    layer.setQuantity('declination');
    expect(removed).toHaveLength(first);
    expect(layer.frameProgress().ready).toBe(0);

    await drain(layer);
    expect(layer.frameProgress().ready).toBe(layer.frameProgress().total);
    expect(added.length).toBeGreaterThan(first);
  });

  it('ignores a no-op quantity change', async () => {
    const layer = makeLayer('intensity');
    const { viewer, removed } = createFakeViewer();
    layer.mount(viewer);
    await drain(layer);

    layer.setQuantity('intensity');

    expect(removed).toHaveLength(0);
    expect(layer.getQuantity()).toBe('intensity');
  });

  it('does not let a build in flight outlive the quantity it was for', async () => {
    // Frames decoding when the quantity changes describe the wrong scalar; the
    // generation counter is what stops them being attached.
    const layer = makeLayer('intensity');
    const { viewer } = createFakeViewer();
    layer.mount(viewer);
    await drainSome();

    layer.setQuantity('inclination');
    await drain(layer);

    expect(layer.frameProgress().ready).toBe(layer.frameProgress().total);
    expect(layer.getQuantity()).toBe('inclination');
  });
});
