import * as Cesium from 'cesium';
import type { GlobeLayer } from '@terra-pulse/schema';

/**
 * Blue Marble with shaded relief *and* ocean bathymetry.
 *
 * This replaced the plain `BlueMarble_NextGeneration` satellite basemap, which
 * has been removed. Same imagery, but that one painted the ocean as a flat
 * surface — hiding the trenches and ridges where most of the seismicity this
 * app exists to show actually happens. Strictly less informative here, so
 * keeping both was only maintenance.
 *
 * Verified against GIBS' live WMTS capabilities
 * (gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml):
 * a static composite with no `<Dimension>`, so unlike most GIBS layers — which
 * are daily passes — it needs no {Time} segment or Clock.
 *
 * Level 8 (500 m) is the ceiling GIBS publishes, so this blurs when zoomed
 * right in. For close work on a trench, the GEBCO seafloor basemap renders on
 * demand and stays sharp.
 */
const GIBS_URL_TEMPLATE =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.jpeg';

export function createReliefBasemap(): GlobeLayer {
  let viewer: Cesium.Viewer | null = null;
  let imageryLayer: Cesium.ImageryLayer | null = null;

  return {
    id: 'relief',
    label: 'Relief',
    category: 'basemap',
    exclusive: true,
    defaultVisible: false,
    mount(v) {
      viewer = v;
      const provider = new Cesium.WebMapTileServiceImageryProvider({
        url: GIBS_URL_TEMPLATE,
        layer: 'BlueMarble_ShadedRelief_Bathymetry',
        style: 'default',
        tileMatrixSetID: 'GoogleMapsCompatible_Level8',
        format: 'image/jpeg',
        maximumLevel: 8,
        credit: new Cesium.Credit('NASA EOSDIS GIBS / Blue Marble shaded relief + bathymetry'),
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
      // See osm-basemap.ts: if the viewer's already destroyed, it already
      // took this layer down with it.
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
