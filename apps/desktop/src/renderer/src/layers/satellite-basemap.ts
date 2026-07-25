import * as Cesium from 'cesium';
import type { GlobeLayer } from '@terra-pulse/schema';

// Verified against GIBS' live WMTS capabilities document
// (gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml):
// BlueMarble_NextGeneration is a static, non-time-varying true-color
// composite — unlike most GIBS layers, which are daily satellite passes and
// would need a {Time} template segment plus a Clock.
const GIBS_URL_TEMPLATE =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.jpeg';

export function createSatelliteBasemap(): GlobeLayer {
  let viewer: Cesium.Viewer | null = null;
  let imageryLayer: Cesium.ImageryLayer | null = null;

  return {
    id: 'satellite',
    label: 'Satellite (NASA GIBS)',
    category: 'basemap',
    exclusive: true,
    defaultVisible: false,
    mount(v) {
      viewer = v;
      const provider = new Cesium.WebMapTileServiceImageryProvider({
        url: GIBS_URL_TEMPLATE,
        layer: 'BlueMarble_NextGeneration',
        style: 'default',
        tileMatrixSetID: 'GoogleMapsCompatible_Level8',
        format: 'image/jpeg',
        maximumLevel: 8,
        credit: new Cesium.Credit('NASA EOSDIS GIBS / Blue Marble (MODIS)'),
      });
      imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
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
