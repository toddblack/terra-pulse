import * as Cesium from 'cesium';
import { flareAtLeast, type GlobeLayer, type SolarFlare } from '@terra-pulse/schema';
import { subsolarPoint } from './magnetopause';
import { flareMarkerColorHex, flareMarkerPixelSize } from './solar-events-encoding';

/**
 * Solar flares, marked at the subsolar point at their peak time — PROJECT_PLAN
 * §5.6: "Emission: subsolar point at flare time. A single marker is
 * appropriate."
 *
 * ## Why M-class and above only
 *
 * A/B/C flares occur multiple times a day and are not geoeffective — drawing
 * them would blow the mark-budget discipline every other layer here follows
 * for no readable gain. `flareAtLeast` is the same helper H1b's trigger set
 * uses, so the layer draws exactly what the registered hypothesis counts.
 *
 * ## Why a point, not a ring
 *
 * Unlike a magnetometer disturbance, a flare has no spatial extent worth
 * drawing — it is dated and located on the Sun, not on Earth. The subsolar
 * point is a proxy for "where the Sun is overhead", not a measurement of
 * anything at that spot.
 */
export const SOLAR_FLARES_LAYER_ID = 'solar-flares';

export interface SolarFlaresLayer extends GlobeLayer {
  /** Pushes the flares in the current display window. */
  setFlares(flares: readonly SolarFlare[]): void;
}

export function isSolarFlaresLayer(layer: GlobeLayer): layer is SolarFlaresLayer {
  return layer.id === SOLAR_FLARES_LAYER_ID && 'setFlares' in layer;
}

export function createSolarFlaresLayer(): SolarFlaresLayer {
  let viewer: Cesium.Viewer | null = null;
  let source: Cesium.CustomDataSource | null = null;
  let flares: readonly SolarFlare[] = [];

  function rebuild(): void {
    if (!source) return;
    source.entities.removeAll();

    for (const flare of flares) {
      if (!flareAtLeast(flare, 'M')) continue;

      const { latitudeDeg, longitudeDeg } = subsolarPoint(new Date(flare.peakTimeUtc));
      const colour = Cesium.Color.fromCssColorString(flareMarkerColorHex(flare.flareClass));

      source.entities.add({
        id: `flare-${flare.id}`,
        position: Cesium.Cartesian3.fromDegrees(longitudeDeg, latitudeDeg),
        name: `${flare.classType} flare`,
        point: {
          pixelSize: flareMarkerPixelSize(flare.flareClass, flare.magnitude),
          color: colour,
          outlineColor: Cesium.Color.WHITE.withAlpha(0.6),
          outlineWidth: 1,
        },
      });
    }
  }

  return {
    id: SOLAR_FLARES_LAYER_ID,
    label: 'Solar flares (M+)',
    category: 'events',
    defaultVisible: false,

    mount(nextViewer) {
      viewer = nextViewer;
      source = new Cesium.CustomDataSource(SOLAR_FLARES_LAYER_ID);
      void viewer.dataSources.add(source);
      rebuild();
    },

    unmount() {
      if (viewer && !viewer.isDestroyed() && source) viewer.dataSources.remove(source, true);
      source = null;
      viewer = null;
    },

    setTimeWindow() {
      // A deliberate no-op. Flares arrive already scoped to the display window
      // via `setFlares` — the renderer re-queries main on every window change
      // (see `useSolarEvents`) rather than holding the whole catalogue and
      // filtering client-side, so there is nothing left for this to trim.
    },

    setVisible(next) {
      if (source) source.show = next;
    },

    setFlares(next) {
      flares = next;
      rebuild();
    },
  };
}
