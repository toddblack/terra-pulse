import { describe, expect, it, vi } from 'vitest';
import type * as Cesium from 'cesium';
import { createSeafloorBasemap } from './seafloor-basemap';

function createFakeViewer(): Cesium.Viewer {
  const fakeLayer = {} as Cesium.ImageryLayer;
  return {
    isDestroyed: vi.fn(() => false),
    imageryLayers: {
      addImageryProvider: vi.fn(() => fakeLayer),
      remove: vi.fn(() => true),
      lowerToBottom: vi.fn(),
    },
  } as unknown as Cesium.Viewer;
}

function mountAndGetProvider(): Cesium.WebMapServiceImageryProvider {
  const layer = createSeafloorBasemap();
  const viewer = createFakeViewer();
  layer.mount(viewer);
  return vi.mocked(viewer.imageryLayers.addImageryProvider).mock
    .calls[0]![0] as Cesium.WebMapServiceImageryProvider;
}

describe('seafloor basemap layer', () => {
  it('conforms to the GlobeLayer contract', () => {
    const layer = createSeafloorBasemap();
    expect(layer.id).toBe('seafloor');
    expect(layer.category).toBe('basemap');
    expect(layer.exclusive).toBe(true);
  });

  it('adds an imagery provider on mount and removes it on unmount', () => {
    const layer = createSeafloorBasemap();
    const viewer = createFakeViewer();

    layer.mount(viewer);
    expect(viewer.imageryLayers.addImageryProvider).toHaveBeenCalledOnce();

    layer.unmount();
    expect(viewer.imageryLayers.remove).toHaveBeenCalledOnce();
  });

  it('does not touch an already-destroyed viewer on unmount', () => {
    const layer = createSeafloorBasemap();
    const viewer = createFakeViewer();

    layer.mount(viewer);
    (viewer.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);

    expect(() => layer.unmount()).not.toThrow();
    expect(viewer.imageryLayers.remove).not.toHaveBeenCalled();
  });

  it('requests only the GEBCO host named in the CSP', () => {
    // This is the one basemap needing a CSP entry of its own. If the host
    // drifted, tiles would be blocked with no visible cause but a blank globe.
    expect(mountAndGetProvider().url).toBe('https://wms.gebco.net/mapserv');
  });

  it('requests the shaded-relief grid, not the colour-shaded one', () => {
    // GEBCO_LATEST_2 renders glossier and with less topographic texture, which
    // makes a worse backdrop for marks drawn on top.
    expect(mountAndGetProvider().layers).toBe('GEBCO_LATEST');
  });

  it('uses https, never plaintext', () => {
    expect(mountAndGetProvider().url.startsWith('https://')).toBe(true);
  });
});

it('keeps the basemap at the bottom of the imagery stack', () => {
  // `addImageryProvider` appends to the top, so a basemap mounted after a
  // raster overlay would cover it. Reachable in practice: relief and seafloor
  // share a backdrop tone, so switching between them remounts the basemap
  // without remounting the overlays.
  const layer = createSeafloorBasemap();
  const viewer = createFakeViewer();

  layer.mount(viewer);

  expect(viewer.imageryLayers.lowerToBottom).toHaveBeenCalledOnce();
});
