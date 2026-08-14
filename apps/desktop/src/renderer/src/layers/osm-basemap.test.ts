import { describe, expect, it, vi } from 'vitest';
import type * as Cesium from 'cesium';
import { createOsmBasemap } from './osm-basemap';

function createFakeViewer(options?: { destroyed?: boolean }): Cesium.Viewer {
  const fakeLayer = {} as Cesium.ImageryLayer;
  return {
    isDestroyed: vi.fn(() => options?.destroyed ?? false),
    imageryLayers: {
      addImageryProvider: vi.fn(() => fakeLayer),
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
    expect(viewer.imageryLayers.addImageryProvider).toHaveBeenCalledOnce();

    layer.unmount();
    expect(viewer.imageryLayers.remove).toHaveBeenCalledOnce();
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

  expect(viewer.imageryLayers.lowerToBottom).toHaveBeenCalledOnce();
});
