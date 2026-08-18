import * as Cesium from 'cesium';
import { isDirectImpact, type CmeArrival, type GlobeLayer } from '@terra-pulse/schema';
import { subsolarPoint } from './magnetopause';
import { cmeMarkerColorHex, cmeMarkerPixelSize } from './solar-events-encoding';

/**
 * CME arrivals, marked at the subsolar point at their modelled arrival time —
 * PROJECT_PLAN §5.6's positioning rule, satisfied with a marker rather than
 * the fuller "dayside compression + auroral oval intensity" rendering that
 * section also describes. That fuller version overlaps what the magnetopause
 * and aurora layers already draw live, but has no time-indexed equivalent
 * yet — a marker is what makes arrivals visible on the timeline today; the
 * richer visualisation is a follow-up.
 *
 * Every run WSA-ENLIL models is a *simulation*, not an observation — unlike a
 * flare, which DONKI reports as having happened. `isDirectImpact` separates
 * genuine hits from grazes, which matters for the same reason it matters to
 * H2b's trigger set: a glancing blow can carry a predicted Kp of 2 and was
 * never going to do anything.
 *
 * **Built set stable, visibility live** — see the identical note on
 * `solar-flares-layer.ts`. `setArrivals` rebuilds; `setTimeWindow` only flips
 * a `show` flag against an index captured at build time.
 */
export const CME_ARRIVALS_LAYER_ID = 'cme-arrivals';

const CME_ID_PREFIX = 'cme-';

/** The reverse of `cme-${arrival.simulationId}` below — how the pick handler maps a click back to an arrival. */
export function cmeSimulationIdFromEntityId(entityId: string): string | null {
  return entityId.startsWith(CME_ID_PREFIX) ? entityId.slice(CME_ID_PREFIX.length) : null;
}

export interface CmeArrivalsLayer extends GlobeLayer {
  /** Pushes the CME arrivals in the currently loaded (whole-span) set. */
  setArrivals(arrivals: readonly CmeArrival[]): void;
}

export function isCmeArrivalsLayer(layer: GlobeLayer): layer is CmeArrivalsLayer {
  return layer.id === CME_ARRIVALS_LAYER_ID && 'setArrivals' in layer;
}

export function createCmeArrivalsLayer(): CmeArrivalsLayer {
  let viewer: Cesium.Viewer | null = null;
  let source: Cesium.CustomDataSource | null = null;
  let arrivals: readonly CmeArrival[] = [];
  let timeWindow: { startMs: number; endMs: number } | null = null;

  /** One entry per drawn arrival, captured at build time — see the module doc. */
  interface ArrivalEntity {
    timeMs: number;
    entity: Cesium.Entity;
  }
  let entityIndex: ArrivalEntity[] = [];

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

    for (const arrival of arrivals) {
      const { latitudeDeg, longitudeDeg } = subsolarPoint(new Date(arrival.arrivalTimeUtc));
      const colour = Cesium.Color.fromCssColorString(cmeMarkerColorHex(arrival));

      const entity = source.entities.add({
        id: `${CME_ID_PREFIX}${arrival.simulationId}`,
        position: Cesium.Cartesian3.fromDegrees(longitudeDeg, latitudeDeg),
        name: isDirectImpact(arrival) ? 'CME arrival (direct)' : 'CME arrival (glancing)',
        point: {
          pixelSize: cmeMarkerPixelSize(arrival.predictedKp),
          color: colour,
          outlineColor: Cesium.Color.WHITE.withAlpha(0.6),
          outlineWidth: 1,
        },
      });

      entityIndex.push({ timeMs: Date.parse(arrival.arrivalTimeUtc), entity });
    }

    applyVisibility();
  }

  return {
    id: CME_ARRIVALS_LAYER_ID,
    label: 'CME arrivals',
    category: 'events',
    defaultVisible: false,

    mount(nextViewer) {
      viewer = nextViewer;
      source = new Cesium.CustomDataSource(CME_ARRIVALS_LAYER_ID);
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

    setArrivals(next) {
      arrivals = next;
      rebuild();
    },
  };
}
