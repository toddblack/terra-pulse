import * as Cesium from 'cesium';
import { POINT_COLOR, RETICLE_PX, reticleImage } from './location-highlight';

/**
 * Marks, on the globe, the stations the waveform panel is streaming — and the
 * spot they were picked around.
 *
 * Not a registry layer, deliberately, for the same reasons `location-highlight`
 * is not: it is not something a reader turns on, it exists only while the
 * waveform mode is mounted, and the layer panel it would be listed in is not
 * on screen in that mode.
 *
 * - **Stations are triangles**, the map symbol seismology uses for a
 *   seismometer, in the traces' own cyan — the colour is what ties a marker to
 *   its row. The dark casing is what keeps cyan legible over the light OSM
 *   basemap, the surface a pale mark most often disappears on (the Moon marker
 *   was measured at 1.3:1 there before it was fixed).
 * - **The picked spot reuses the location reticle** in its bare-point colour:
 *   it is exactly that kind of thing, a spot with no feature under it, and a
 *   selection should look like a selection.
 * - **Labels carry the station code**, so a row can be found on the globe and a
 *   marker in the panel without counting.
 */

export const WAVEFORM_STATION_COLOR = '#67e8f9';

/** Screen pixels; small enough that eight in one valley do not merge. */
const STATION_MARKER_PX = 16;

const ENTITY_PREFIX = 'waveform-station:';

export interface WaveformOverlayStation {
  network: string;
  station: string;
  latitude: number;
  longitude: number;
}

export interface WaveformOverlayPoint {
  latitude: number;
  longitude: number;
}

/** A filled, cased, upward triangle, drawn at 2× for high-DPI displays. */
function triangleImage(): HTMLCanvasElement {
  const scale = 2;
  const size = STATION_MARKER_PX * scale;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context === null) return canvas;

  const inset = 2.5 * scale;
  context.beginPath();
  context.moveTo(size / 2, inset);
  context.lineTo(size - inset, size - inset);
  context.lineTo(inset, size - inset);
  context.closePath();
  context.lineJoin = 'round';
  context.lineWidth = 3 * scale;
  context.strokeStyle = 'rgba(11, 11, 11, 0.85)';
  context.stroke();
  context.fillStyle = WAVEFORM_STATION_COLOR;
  context.fill();
  return canvas;
}

export function waveformStationEntityId(station: WaveformOverlayStation): string {
  return `${ENTITY_PREFIX}${station.network}_${station.station}`;
}

export interface WaveformStationsOverlay {
  update(stations: readonly WaveformOverlayStation[], point: WaveformOverlayPoint | null): void;
  destroy(): void;
}

export function createWaveformStationsOverlay(viewer: Cesium.Viewer): WaveformStationsOverlay {
  const source = new Cesium.CustomDataSource('waveform-stations');
  let attached = false;
  let destroyed = false;
  // Drawn once and shared by every marker; a canvas per station would be eight
  // identical textures.
  const triangle = triangleImage();

  // `add()` is async; destroyed before it resolves, the source would be
  // attached with nothing left to detach it. Same guard as location-highlight.
  void viewer.dataSources.add(source).then(
    () => {
      if (destroyed) {
        if (!viewer.isDestroyed()) viewer.dataSources.remove(source, true);
        return;
      }
      attached = true;
    },
    (error: unknown) => {
      console.error('Failed to add the waveform station markers', error);
    },
  );

  return {
    update(stations, point) {
      if (destroyed) return;
      source.entities.removeAll();

      if (point !== null) {
        source.entities.add({
          position: Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude),
          billboard: {
            image: reticleImage(POINT_COLOR),
            width: RETICLE_PX,
            height: RETICLE_PX,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }

      for (const station of stations) {
        source.entities.add({
          id: waveformStationEntityId(station),
          position: Cesium.Cartesian3.fromDegrees(station.longitude, station.latitude),
          billboard: {
            image: triangle,
            width: STATION_MARKER_PX,
            height: STATION_MARKER_PX,
            // Never buried by terrain or a fault line at grazing angles.
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: `${station.network} ${station.station}`,
            font: '600 11px system-ui, sans-serif',
            fillColor: Cesium.Color.fromCssColorString(WAVEFORM_STATION_COLOR),
            outlineColor: Cesium.Color.fromCssColorString('#0b0b0b'),
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -STATION_MARKER_PX / 2 - 2),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
    },

    destroy() {
      destroyed = true;
      // Non-negotiable #5, guarded because effect-cleanup order relative to
      // the viewer's own teardown is not something to rely on.
      if (!viewer.isDestroyed() && attached) {
        viewer.dataSources.remove(source, true);
      }
    },
  };
}
