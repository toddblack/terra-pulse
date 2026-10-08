import * as Cesium from 'cesium';
import type { WatchPin } from '@terra-pulse/schema';

/**
 * The live watch's pin on the globe. Drawn whenever there is one — whatever
 * the dock shows and whatever is selected — because the pin is the watch: the
 * user's design has no watch without a visible pin and no pin that is not
 * watching.
 *
 * Not a registry layer, for `waveform-stations-overlay`'s reasons: it is not
 * toggled from the layer panel; it exists exactly while the pin does.
 *
 * Emerald, a hue nothing else on the globe uses for a mark: cyan is the
 * streamed stations, amber the replay and GEM faults, violet the plate
 * boundaries, red the antipode and the replay's S wave. A dark casing keeps it
 * readable on the light OSM basemap, the same treatment as the station marks.
 */

const PIN_COLOR = '#34d399';
const CASING = '#0b0b0b';

export interface WatchPinOverlay {
  destroy(): void;
}

export function createWatchPinOverlay(viewer: Cesium.Viewer, pin: WatchPin): WatchPinOverlay {
  const source = new Cesium.CustomDataSource('watch-pin');
  let attached = false;
  let destroyed = false;
  const position = Cesium.Cartesian3.fromDegrees(pin.longitude, pin.latitude);
  const color = Cesium.Color.fromCssColorString(PIN_COLOR);
  const casing = Cesium.Color.fromCssColorString(CASING);

  // A ring around a dot: reads as "a place being watched" rather than as one
  // more data mark, of which the globe already has thousands.
  source.entities.add({
    position,
    point: {
      pixelSize: 18,
      color: Cesium.Color.TRANSPARENT,
      outlineColor: color,
      outlineWidth: 2.5,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
  source.entities.add({
    position,
    point: {
      pixelSize: 7,
      color,
      outlineColor: casing,
      outlineWidth: 1.5,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: 'Watch',
      font: '600 11px system-ui, sans-serif',
      fillColor: color,
      outlineColor: casing,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -12),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });

  // `add()` is async; destroyed before it resolves, the source would be
  // attached with nothing left to detach it. Same guard as the other overlays.
  void viewer.dataSources.add(source).then(
    () => {
      if (destroyed) {
        if (!viewer.isDestroyed()) viewer.dataSources.remove(source, true);
        return;
      }
      attached = true;
    },
    (error: unknown) => {
      console.error('Failed to add the watch pin', error);
    },
  );

  return {
    destroy() {
      destroyed = true;
      // Non-negotiable #5.
      if (!viewer.isDestroyed() && attached) viewer.dataSources.remove(source, true);
    },
  };
}
