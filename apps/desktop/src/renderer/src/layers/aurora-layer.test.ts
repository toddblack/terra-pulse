import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Cesium from 'cesium';
import { AURORA_LAYER_ID, createAuroraLayer, isAuroraLayer } from './aurora-layer';
import { AURORA_GRID_HEIGHT, AURORA_GRID_WIDTH, type AuroraGrid } from '@terra-pulse/schema';
import type { GlobeLayer } from '@terra-pulse/schema';

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

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const GRID: AuroraGrid = {
  observedAtUtc: '2026-08-14T06:41:00Z',
  forecastForUtc: '2026-08-14T07:56:00Z',
  fetchedAtUtc: '2026-08-14T06:45:00Z',
  width: AURORA_GRID_WIDTH,
  height: AURORA_GRID_HEIGHT,
  values: new Uint8Array(AURORA_GRID_WIDTH * AURORA_GRID_HEIGHT).fill(20),
};

interface FakeLayer {
  show: boolean;
}

function createFakeViewer() {
  const added: FakeLayer[] = [];
  const removed: FakeLayer[] = [];
  const viewer = {
    isDestroyed: vi.fn(() => false),
    imageryLayers: {
      addImageryProvider: vi.fn(() => {
        const layer: FakeLayer = { show: false };
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

describe('aurora layer', () => {
  it('conforms to the GlobeLayer contract', () => {
    const layer = createAuroraLayer();
    expect(layer.id).toBe(AURORA_LAYER_ID);
    expect(layer.category).toBe('overlay');
    expect(layer.defaultVisible).toBe(false);
    expect(isAuroraLayer(layer)).toBe(true);
    expect(isAuroraLayer({ id: 'earthquakes' } as unknown as GlobeLayer)).toBe(false);
  });

  it('draws nothing before the first grid arrives', async () => {
    // Offline or pre-poll. Better an empty globe than an oval with no timestamp.
    const layer = createAuroraLayer();
    const { viewer, added } = createFakeViewer();
    layer.mount(viewer);
    await settle();
    expect(added).toHaveLength(0);
  });

  it('draws and shows a grid once it arrives', async () => {
    const layer = createAuroraLayer();
    const { viewer, added } = createFakeViewer();
    layer.mount(viewer);
    layer.setGrid(GRID);
    await settle();

    expect(added).toHaveLength(1);
    expect(added[0]?.show).toBe(true);
  });

  it('keeps the old raster up until the replacement has decoded', async () => {
    // Same rule the field layer had to learn: removing at request time leaves a
    // gap, which here would be a visible blink every five minutes.
    const layer = createAuroraLayer();
    const { viewer, added, removed } = createFakeViewer();
    layer.mount(viewer);
    layer.setGrid(GRID);
    await settle();

    const pending: ((p: Cesium.SingleTileImageryProvider) => void)[] = [];
    vi.spyOn(Cesium.SingleTileImageryProvider, 'fromUrl').mockImplementation(
      () =>
        new Promise<Cesium.SingleTileImageryProvider>((resolve) => {
          pending.push(resolve);
        }),
    );

    layer.setGrid({ ...GRID, observedAtUtc: '2026-08-14T06:46:00Z' });
    await settle();
    expect(removed).toHaveLength(0);

    pending[0]?.({} as unknown as Cesium.SingleTileImageryProvider);
    await settle();
    expect(added).toHaveLength(2);
    expect(removed).toHaveLength(1);
  });

  it('clears the oval when the grid goes away', async () => {
    const layer = createAuroraLayer();
    const { viewer, removed } = createFakeViewer();
    layer.mount(viewer);
    layer.setGrid(GRID);
    await settle();

    layer.setGrid(null);
    expect(removed).toHaveLength(1);
  });

  it('ignores the time window, because there is no archive of past grids', async () => {
    // Scrubbing to 1975 cannot show the aurora of 1975; the legend says so.
    const layer = createAuroraLayer();
    const { viewer, added } = createFakeViewer();
    layer.mount(viewer);
    layer.setGrid(GRID);
    await settle();
    const before = added.length;

    layer.setTimeWindow(new Date('1975-01-01T00:00:00Z'), new Date('1975-01-01T00:00:00Z'));

    expect(added).toHaveLength(before);
  });

  it('removes its imagery on unmount', async () => {
    const layer = createAuroraLayer();
    const { viewer, removed } = createFakeViewer();
    layer.mount(viewer);
    layer.setGrid(GRID);
    await settle();
    layer.unmount();
    expect(removed).toHaveLength(1);
  });

  it('does not attach a raster that decodes after unmount', async () => {
    const layer = createAuroraLayer();
    const { viewer, added } = createFakeViewer();
    layer.mount(viewer);
    layer.setGrid(GRID);
    layer.unmount();
    await settle();
    expect(added).toHaveLength(0);
  });

  it('does not touch an already-destroyed viewer on unmount', async () => {
    const layer = createAuroraLayer();
    const { viewer, removed } = createFakeViewer();
    layer.mount(viewer);
    layer.setGrid(GRID);
    await settle();
    (viewer.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);
    expect(() => {
      layer.unmount();
    }).not.toThrow();
    expect(removed).toHaveLength(0);
  });
});
