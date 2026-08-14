import * as Cesium from 'cesium';
import type { GlobeLayer } from '@terra-pulse/schema';

export function createOsmBasemap(): GlobeLayer {
  let viewer: Cesium.Viewer | null = null;
  let imageryLayer: Cesium.ImageryLayer | null = null;

  return {
    id: 'osm',
    label: 'Basic (OpenStreetMap)',
    category: 'basemap',
    exclusive: true,
    defaultVisible: true,
    mount(v) {
      viewer = v;
      const provider = new Cesium.OpenStreetMapImageryProvider({
        url: 'https://tile.openstreetmap.org/',
        // OSM's raster tile server 400s past zoom 19 — without this cap,
        // Cesium happily requests deeper tiles once you zoom in close, and
        // the resulting error responses (lacking CORS headers) get
        // misreported by the browser as CORS failures instead of 400s.
        maximumLevel: 19,
      });
      imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
      // Basemaps belong at the bottom of the imagery stack, always.
      //
      // `addImageryProvider` appends to the *top*, so without this a basemap
      // mounted after a raster overlay covers it. That is reachable: relief and
      // seafloor share a backdrop tone, so switching between them re-runs the
      // basemap effect while leaving the overlay effect alone — the overlay
      // would still be attached, still marked visible, and completely hidden.
      viewer.imageryLayers.lowerToBottom(imageryLayer);
    },
    unmount() {
      // If the viewer itself has already been destroyed, everything on it
      // (including this layer) is already gone — nothing left to do, and
      // touching a destroyed Viewer throws. Effect cleanup order between
      // this layer's owning effect and the viewer's owning effect isn't
      // something to rely on.
      if (viewer && !viewer.isDestroyed() && imageryLayer) {
        viewer.imageryLayers.remove(imageryLayer, true);
      }
      viewer = null;
      imageryLayer = null;
    },
    setTimeWindow() {
      // Basemaps are not time-driven.
    },
    setVisible(visible) {
      if (imageryLayer) imageryLayer.show = visible;
    },
  };
}
