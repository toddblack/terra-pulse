import * as Cesium from 'cesium';
import type { GlobeLayer } from '@terra-pulse/schema';

/**
 * GEBCO global bathymetry — the measured shape of the ocean floor.
 *
 * Where the GIBS relief basemap shades the seafloor into a satellite image,
 * this *is* the bathymetric grid: trenches, spreading ridges, seamount chains
 * and fracture zones all read directly. It's the basemap to use when the
 * question is about structure rather than surface.
 *
 * ## Free, and why no key is needed
 *
 * GEBCO's WMS is run by the British Oceanographic Data Centre and needs no
 * registration. Its capabilities document states no fees. The only stated
 * access constraint is a disclaimer that the imagery must not be used for
 * navigation or safety at sea — not a licensing restriction, and not something
 * this app does. Attribution is surfaced through Cesium's credit display.
 *
 * ## WMS rather than tiles
 *
 * GEBCO renders on request instead of serving a fixed tile pyramid, so unlike
 * the GIBS basemaps this stays sharp as you zoom in rather than stopping at
 * level 8. The cost is that requests are rendered, not served from a CDN, so
 * panning is slower.
 *
 * Cesium's WMS defaults (version 1.1.1, web-mercator tiling) were checked
 * against the live service before this was written: GEBCO advertises EPSG:3857
 * and answers 1.1.1 GetMap requests, so nothing needs overriding.
 *
 * `GEBCO_LATEST` (shaded relief) is used rather than `GEBCO_LATEST_2`
 * (colour-shaded for elevation) — the former carries more visible topographic
 * texture and less glare, which matters when earthquake marks have to sit on
 * top of it.
 */
const GEBCO_WMS_URL = 'https://wms.gebco.net/mapserv';

export function createSeafloorBasemap(): GlobeLayer {
  let viewer: Cesium.Viewer | null = null;
  let imageryLayer: Cesium.ImageryLayer | null = null;

  return {
    id: 'seafloor',
    label: 'Seafloor',
    category: 'basemap',
    exclusive: true,
    defaultVisible: false,
    mount(v) {
      viewer = v;
      const provider = new Cesium.WebMapServiceImageryProvider({
        url: GEBCO_WMS_URL,
        layers: 'GEBCO_LATEST',
        parameters: {
          format: 'image/png',
          transparent: false,
        },
        credit: new Cesium.Credit('GEBCO Compilation Group / BODC'),
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
