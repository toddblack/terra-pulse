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
 *
 * ## Built set stable, visibility live
 *
 * `setFlares` — driven by `useSolarEvents`, now scoped to the whole selected
 * span rather than the live playhead window — rebuilds. `setTimeWindow` does
 * not: it flips each entity's `show` flag against an index captured at build
 * time, the same split `earthquake-layer.ts`'s `applyVisibility` uses. An
 * earlier version had no such split — `setTimeWindow` was a no-op and the
 * *query* itself followed the live window, so every playback tick did a full
 * IPC round-trip and a full `removeAll` + re-add. That is the mistake this
 * split exists to avoid; see CLAUDE.md's "30-second rebuild" postmortem for
 * the earthquake-layer original of it.
 */
export const SOLAR_FLARES_LAYER_ID = 'solar-flares';

const FLARE_ID_PREFIX = 'flare-';

/** The reverse of `flare-${flare.id}` below — how the pick handler maps a click back to a flare. */
export function flareIdFromEntityId(entityId: string): string | null {
  return entityId.startsWith(FLARE_ID_PREFIX) ? entityId.slice(FLARE_ID_PREFIX.length) : null;
}

export interface SolarFlaresLayer extends GlobeLayer {
  /** Pushes the flares in the currently loaded (whole-span) set. */
  setFlares(flares: readonly SolarFlare[]): void;
}

export function isSolarFlaresLayer(layer: GlobeLayer): layer is SolarFlaresLayer {
  return layer.id === SOLAR_FLARES_LAYER_ID && 'setFlares' in layer;
}

export function createSolarFlaresLayer(): SolarFlaresLayer {
  let viewer: Cesium.Viewer | null = null;
  let source: Cesium.CustomDataSource | null = null;
  let flares: readonly SolarFlare[] = [];
  let timeWindow: { startMs: number; endMs: number } | null = null;

  /** One entry per drawn flare, captured at build time — see the module doc. */
  interface FlareEntity {
    timeMs: number;
    entity: Cesium.Entity;
  }
  let entityIndex: FlareEntity[] = [];

  function applyVisibility(): void {
    if (timeWindow === null) {
      for (const entry of entityIndex) entry.entity.show = true;
      return;
    }
    for (const entry of entityIndex) {
      entry.entity.show =
        Number.isFinite(entry.timeMs) &&
        entry.timeMs >= timeWindow.startMs &&
        entry.timeMs <= timeWindow.endMs;
    }
  }

  function rebuild(): void {
    if (!source) return;
    source.entities.removeAll();
    entityIndex = [];

    for (const flare of flares) {
      if (!flareAtLeast(flare, 'M')) continue;

      const { latitudeDeg, longitudeDeg } = subsolarPoint(new Date(flare.peakTimeUtc));
      const colour = Cesium.Color.fromCssColorString(flareMarkerColorHex(flare.flareClass));

      const entity = source.entities.add({
        id: `${FLARE_ID_PREFIX}${flare.id}`,
        position: Cesium.Cartesian3.fromDegrees(longitudeDeg, latitudeDeg),
        name: `${flare.classType} flare`,
        point: {
          pixelSize: flareMarkerPixelSize(flare.flareClass, flare.magnitude),
          color: colour,
          outlineColor: Cesium.Color.WHITE.withAlpha(0.6),
          outlineWidth: 1,
        },
      });

      entityIndex.push({ timeMs: Date.parse(flare.peakTimeUtc), entity });
    }

    applyVisibility();
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
      entityIndex = [];
    },

    setTimeWindow(start, end) {
      timeWindow = { startMs: start.getTime(), endMs: end.getTime() };
      applyVisibility();
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
