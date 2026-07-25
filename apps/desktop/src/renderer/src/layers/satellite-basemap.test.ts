import { describe, expect, it, vi } from 'vitest';
import type * as Cesium from 'cesium';
import { createSatelliteBasemap } from './satellite-basemap';

function createFakeViewer(): Cesium.Viewer {
  const fakeLayer = {} as Cesium.ImageryLayer;
  return {
    isDestroyed: vi.fn(() => false),
    imageryLayers: {
      addImageryProvider: vi.fn(() => fakeLayer),
      remove: vi.fn(() => true),
    },
  } as unknown as Cesium.Viewer;
}

describe('satellite basemap layer', () => {
  it('conforms to the GlobeLayer contract', () => {
    const layer = createSatelliteBasemap();
    expect(layer.id).toBe('satellite');
    expect(layer.category).toBe('basemap');
    expect(layer.exclusive).toBe(true);
  });

  it('adds an imagery provider on mount and removes it on unmount', () => {
    const layer = createSatelliteBasemap();
    const viewer = createFakeViewer();

    layer.mount(viewer);
    expect(viewer.imageryLayers.addImageryProvider).toHaveBeenCalledOnce();

    layer.unmount();
    expect(viewer.imageryLayers.remove).toHaveBeenCalledOnce();
  });

  it('does not touch an already-destroyed viewer on unmount', () => {
    const layer = createSatelliteBasemap();
    const viewer = createFakeViewer();

    layer.mount(viewer);
    (viewer.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);

    expect(() => layer.unmount()).not.toThrow();
    expect(viewer.imageryLayers.remove).not.toHaveBeenCalled();
  });
});
