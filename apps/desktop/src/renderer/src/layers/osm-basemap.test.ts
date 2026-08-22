import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Cesium from 'cesium';
import { createOsmBasemap } from './osm-basemap';

/**
 * The layer now also attaches two polar caps, which paint a solid fill to a
 * canvas. Node environment has none — same stub the raster layer tests use.
 */
beforeAll(() => {
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ fillStyle: '', fillRect: vi.fn() }),
      toDataURL: () => 'data:image/png;base64,stub',
    }),
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

/** The basemap itself, plus one imagery layer per polar cap. */
const IMAGERY_LAYERS = 3;

function createFakeViewer(options?: { destroyed?: boolean }): Cesium.Viewer {
  return {
    isDestroyed: vi.fn(() => options?.destroyed ?? false),
    imageryLayers: {
      addImageryProvider: vi.fn(() => ({}) as Cesium.ImageryLayer),
      remove: vi.fn(() => true),
      lowerToBottom: vi.fn(),
    },
  } as unknown as Cesium.Viewer;
}

describe('osm basemap layer', () => {
  it('conforms to the GlobeLayer contract', () => {
    const layer = createOsmBasemap();
    expect(layer.id).toBe('osm');
    expect(layer.category).toBe('basemap');
    expect(layer.exclusive).toBe(true);
  });

  it('adds an imagery provider on mount and removes it on unmount', () => {
    const layer = createOsmBasemap();
    const viewer = createFakeViewer();

    layer.mount(viewer);
    expect(viewer.imageryLayers.addImageryProvider).toHaveBeenCalledTimes(IMAGERY_LAYERS);

    layer.unmount();
    expect(viewer.imageryLayers.remove).toHaveBeenCalledTimes(IMAGERY_LAYERS);
  });

  it('does nothing on unmount if never mounted', () => {
    const layer = createOsmBasemap();
    expect(() => layer.unmount()).not.toThrow();
  });

  it('does not touch an already-destroyed viewer on unmount', () => {
    const layer = createOsmBasemap();
    const viewer = createFakeViewer();

    layer.mount(viewer);
    (viewer.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);

    expect(() => layer.unmount()).not.toThrow();
    expect(viewer.imageryLayers.remove).not.toHaveBeenCalled();
  });
});

it('keeps the basemap at the bottom of the imagery stack', () => {
  // `addImageryProvider` appends to the top, so a basemap mounted after a
  // raster overlay would cover it. Reachable in practice: relief and seafloor
  // share a backdrop tone, so switching between them remounts the basemap
  // without remounting the overlays.
  const layer = createOsmBasemap();
  const viewer = createFakeViewer();

  layer.mount(viewer);

  // Once for the basemap, then once per polar cap — the caps are lowered after
  // it so they end up underneath, which is what makes their deliberate overlap
  // with the basemap's last tile row invisible.
  expect(viewer.imageryLayers.lowerToBottom).toHaveBeenCalledTimes(IMAGERY_LAYERS);
});

it('fills the poles OSM cannot tile', () => {
  // OSM's pyramid stops at ±85.05°, and what showed through was the globe's
  // bare base colour: a saturated navy disc at each pole. See polar-caps.ts.
  const layer = createOsmBasemap();
  const viewer = createFakeViewer();

  layer.mount(viewer);

  expect(viewer.imageryLayers.addImageryProvider).toHaveBeenCalledTimes(IMAGERY_LAYERS);
});
