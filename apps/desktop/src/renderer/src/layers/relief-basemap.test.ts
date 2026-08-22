import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Cesium from 'cesium';
import { createReliefBasemap } from './relief-basemap';

/** See osm-basemap.test.ts — the polar caps paint to a canvas. */
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

function createFakeViewer(): Cesium.Viewer {
  return {
    isDestroyed: vi.fn(() => false),
    imageryLayers: {
      addImageryProvider: vi.fn(() => ({}) as Cesium.ImageryLayer),
      remove: vi.fn(() => true),
      lowerToBottom: vi.fn(),
    },
  } as unknown as Cesium.Viewer;
}

describe('relief basemap layer', () => {
  it('conforms to the GlobeLayer contract', () => {
    const layer = createReliefBasemap();
    expect(layer.id).toBe('relief');
    expect(layer.category).toBe('basemap');
    expect(layer.exclusive).toBe(true);
  });

  it('adds an imagery provider on mount and removes it on unmount', () => {
    const layer = createReliefBasemap();
    const viewer = createFakeViewer();

    layer.mount(viewer);
    expect(viewer.imageryLayers.addImageryProvider).toHaveBeenCalledTimes(IMAGERY_LAYERS);

    layer.unmount();
    expect(viewer.imageryLayers.remove).toHaveBeenCalledTimes(IMAGERY_LAYERS);
  });

  it('does not touch an already-destroyed viewer on unmount', () => {
    const layer = createReliefBasemap();
    const viewer = createFakeViewer();

    layer.mount(viewer);
    (viewer.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);

    expect(() => layer.unmount()).not.toThrow();
    expect(viewer.imageryLayers.remove).not.toHaveBeenCalled();
  });

  it('requests a host the CSP already allows', () => {
    // This layer's whole appeal is being a drop-in on the existing GIBS host.
    // If the URL ever moved, tiles would fail silently against the CSP.
    const layer = createReliefBasemap();
    const viewer = createFakeViewer();

    layer.mount(viewer);
    const provider = vi.mocked(viewer.imageryLayers.addImageryProvider).mock
      .calls[0]![0] as Cesium.WebMapTileServiceImageryProvider;
    expect(provider.url).toContain('https://gibs.earthdata.nasa.gov');
  });

  it('carries no time dimension, being a static composite', () => {
    // Most GIBS layers are daily passes needing a {Time} segment and a Clock.
    // This one is static; a {Time} placeholder would mean the wrong layer.
    const layer = createReliefBasemap();
    const viewer = createFakeViewer();

    layer.mount(viewer);
    const provider = vi.mocked(viewer.imageryLayers.addImageryProvider).mock
      .calls[0]![0] as Cesium.WebMapTileServiceImageryProvider;
    expect(provider.url).not.toContain('{Time}');
  });
});

it('keeps the basemap at the bottom of the imagery stack', () => {
  // `addImageryProvider` appends to the top, so a basemap mounted after a
  // raster overlay would cover it. Reachable in practice: relief and seafloor
  // share a backdrop tone, so switching between them remounts the basemap
  // without remounting the overlays.
  const layer = createReliefBasemap();
  const viewer = createFakeViewer();

  layer.mount(viewer);

  // Once for the basemap, then once per polar cap — see osm-basemap.test.ts.
  expect(viewer.imageryLayers.lowerToBottom).toHaveBeenCalledTimes(IMAGERY_LAYERS);
});

it('fills the poles its Mercator tile matrix cannot reach', () => {
  // GIBS serves this composite through GoogleMapsCompatible_Level8, so it stops
  // at ±85.05° exactly as OSM does. Its EPSG:4326 endpoint does cover the poles
  // but steps 2→3→5→10 tiles wide against Cesium's 2→4→8→16, so the pyramids
  // never line up — see polar-caps.ts.
  const layer = createReliefBasemap();
  const viewer = createFakeViewer();

  layer.mount(viewer);

  expect(viewer.imageryLayers.addImageryProvider).toHaveBeenCalledTimes(IMAGERY_LAYERS);
});
