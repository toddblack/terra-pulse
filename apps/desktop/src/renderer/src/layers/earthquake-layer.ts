import * as Cesium from 'cesium';
import type { BackdropTone, EarthquakeEvent, GlobeLayer } from '@terra-pulse/schema';
import {
  depthColorHex,
  emphasisRingColorHex,
  emphasisRingPixelSize,
  haloColorHex,
  isEmphasized,
  magnitudePixelSize,
} from './earthquake-encoding';

// A large event is drawn as two entities: the dot, plus a concentric ring.
// The ring needs its own entity id (ids are unique), so it takes a suffix and
// clicks on it resolve back to the event via `eventIdFromEntityId`.
const RING_ID_SUFFIX = '::ring';

export function ringEntityId(eventId: string): string {
  return `${eventId}${RING_ID_SUFFIX}`;
}

/** Maps either a dot or a ring entity id back to its event id. */
export function eventIdFromEntityId(entityId: string): string {
  return entityId.endsWith(RING_ID_SUFFIX)
    ? entityId.slice(0, -RING_ID_SUFFIX.length)
    : entityId;
}

export function createEarthquakeLayer(
  events: readonly EarthquakeEvent[],
  tone: BackdropTone,
): GlobeLayer {
  let viewer: Cesium.Viewer | null = null;
  let dataSource: Cesium.CustomDataSource | null = null;
  let mounted = false;
  let visible = true;
  let timeWindow: { startMs: number; endMs: number } | null = null;

  function buildEntities(target: Cesium.CustomDataSource): void {
    const halo = Cesium.Color.fromCssColorString(haloColorHex(tone));
    const ringColor = Cesium.Color.fromCssColorString(emphasisRingColorHex(tone));

    for (const event of events) {
      // Ring first, so the dot draws over it rather than under.
      if (isEmphasized(event.magnitude)) {
        target.entities.add({
          id: ringEntityId(event.id),
          position: Cesium.Cartesian3.fromDegrees(event.longitude, event.latitude),
          point: {
            pixelSize: emphasisRingPixelSize(event.magnitude),
            // Transparent fill leaves a clear gap between dot and ring, so
            // this reads as a ring rather than a bigger dot.
            color: Cesium.Color.TRANSPARENT,
            outlineColor: ringColor,
            outlineWidth: 2,
          },
        });
      }

      target.entities.add({
        // The USGS id doubles as the Cesium entity id, so click-picking maps
        // straight back to the event without a side lookup table.
        id: event.id,
        // Height 0 — the epicentre projected to the surface. Depth is carried
        // by colour instead; positioning at true depth would bury deep events
        // inside an opaque globe where nothing could see or click them.
        position: Cesium.Cartesian3.fromDegrees(event.longitude, event.latitude),
        point: {
          pixelSize: magnitudePixelSize(event.magnitude),
          color: Cesium.Color.fromCssColorString(depthColorHex(event.depthKm, tone)),
          outlineColor: halo,
          outlineWidth: 1.5,
        },
      });
    }
  }

  function applyVisibility(): void {
    if (!dataSource) return;

    dataSource.show = visible;

    if (timeWindow === null) {
      for (const entity of dataSource.entities.values) entity.show = true;
      return;
    }

    for (const event of events) {
      const timeMs = Date.parse(event.timeUtc);
      const inWindow =
        Number.isFinite(timeMs) && timeMs >= timeWindow.startMs && timeMs <= timeWindow.endMs;

      // Dot and ring must move together, or a filtered-out event leaves an
      // orphaned ring floating on the globe.
      const dot = dataSource.entities.getById(event.id);
      if (dot) dot.show = inWindow;

      const ring = dataSource.entities.getById(ringEntityId(event.id));
      if (ring) ring.show = inWindow;
    }
  }

  return {
    id: 'earthquakes',
    label: 'Earthquakes',
    category: 'events',
    defaultVisible: true,

    mount(v) {
      viewer = v;
      mounted = true;

      const source = new Cesium.CustomDataSource('earthquakes');
      buildEntities(source);
      dataSource = source;
      applyVisibility();

      // add() is async. If this layer unmounts while the add is still in
      // flight, the data source would end up attached to the viewer with
      // nothing left holding a reference to detach it — a leak of exactly the
      // kind non-negotiable #5 exists to prevent.
      void v.dataSources.add(source).then(
        () => {
          if (!mounted && !v.isDestroyed()) {
            v.dataSources.remove(source, true);
          }
        },
        (error: unknown) => {
          console.error('Failed to add earthquake data source', error);
        },
      );
    },

    unmount() {
      mounted = false;
      // remove(source, true) destroys the data source and every entity in it
      // in one call, rather than per-entity bookkeeping. Guarded on
      // isDestroyed() because effect-cleanup order relative to the viewer's
      // own teardown isn't something to rely on.
      if (viewer && !viewer.isDestroyed() && dataSource) {
        viewer.dataSources.remove(dataSource, true);
      }
      viewer = null;
      dataSource = null;
    },

    setTimeWindow(start, end) {
      timeWindow = { startMs: start.getTime(), endMs: end.getTime() };
      applyVisibility();
    },

    setVisible(v) {
      visible = v;
      applyVisibility();
    },
  };
}
