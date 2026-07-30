import * as Cesium from 'cesium';
import type { BackdropTone, EarthquakeEvent, GlobeLayer } from '@terra-pulse/schema';
import {
  HALO_WIDTH,
  RECENT_HALO_WIDTH,
  depthColorHex,
  emphasisRingColorHex,
  emphasisRingPixelSize,
  haloColorHex,
  isEmphasized,
  isRecentEvent,
  magnitudePixelSize,
  recentHaloColorHex,
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

  const halo = Cesium.Color.fromCssColorString(haloColorHex(tone));
  const recentHalo = Cesium.Color.fromCssColorString(recentHaloColorHex(tone));

  /**
   * Entity handles per event, captured at build time.
   *
   * `applyVisibility` runs on every playhead tick — up to twenty times a second
   * during playback — and two `getById` hash lookups per event per tick is work
   * that never needed doing. Holding the references costs one map.
   */
  interface EventEntities {
    event: EarthquakeEvent;
    timeMs: number;
    dot: Cesium.Entity;
    ring: Cesium.Entity | null;
    /** Last recency state written, so unchanged strokes aren't reassigned. */
    strokedRecent: boolean;
  }
  let entityIndex: EventEntities[] = [];

  function buildEntities(target: Cesium.CustomDataSource): void {
    const ringColor = Cesium.Color.fromCssColorString(emphasisRingColorHex(tone));
    // One "now" for the whole build, so two events either side of the 24h
    // boundary can't disagree within a single render.
    const nowMs = Date.now();
    entityIndex = [];

    for (const event of events) {
      // Ring first, so the dot draws over it rather than under.
      let ring: Cesium.Entity | null = null;
      if (isEmphasized(event.magnitude)) {
        ring = target.entities.add({
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

      const recent = isRecentEvent(event.timeUtc, nowMs);
      const dot = target.entities.add({
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
          // A red, slightly heavier stroke on anything from the last 24 hours.
          // Independent of the emphasis ring, so a recent large event shows
          // both: red stroke for "today", ring for "big".
          outlineColor: recent ? recentHalo : halo,
          outlineWidth: recent ? RECENT_HALO_WIDTH : HALO_WIDTH,
        },
      });

      entityIndex.push({
        event,
        timeMs: Date.parse(event.timeUtc),
        dot,
        ring,
        strokedRecent: recent,
      });
    }
  }

  /**
   * Repaints the recency stroke relative to an instant.
   *
   * During playback this is what makes an event flash red as it happens and
   * settle to neutral a simulated day later — the encoding tracks the playhead
   * rather than the wall clock, so "past 24 hours" stays true of whatever
   * moment is on screen.
   *
   * Only writes when the state actually flips. Reassigning an unchanged colour
   * on every entity twenty times a second is exactly the kind of work that
   * turns smooth playback into a stutter.
   */
  function applyRecency(atMs: number): void {
    for (const entry of entityIndex) {
      const recent = isRecentEvent(entry.event.timeUtc, atMs);
      if (recent === entry.strokedRecent) continue;
      entry.strokedRecent = recent;

      const point = entry.dot.point;
      if (!point) continue;
      point.outlineColor = new Cesium.ConstantProperty(recent ? recentHalo : halo);
      point.outlineWidth = new Cesium.ConstantProperty(
        recent ? RECENT_HALO_WIDTH : HALO_WIDTH,
      );
    }
  }

  function applyVisibility(): void {
    if (!dataSource) return;

    dataSource.show = visible;

    if (timeWindow === null) {
      for (const entry of entityIndex) {
        entry.dot.show = true;
        if (entry.ring) entry.ring.show = true;
      }
      applyRecency(Date.now());
      return;
    }

    for (const entry of entityIndex) {
      const inWindow =
        Number.isFinite(entry.timeMs) &&
        entry.timeMs >= timeWindow.startMs &&
        entry.timeMs <= timeWindow.endMs;

      // Dot and ring must move together, or a filtered-out event leaves an
      // orphaned ring floating on the globe.
      entry.dot.show = inWindow;
      if (entry.ring) entry.ring.show = inWindow;
    }

    // The window's end is the playhead, so recency is measured from there —
    // clamped to now, because live mode passes an end slightly in the future so
    // that a freshly-polled event can't fall outside the window. Without the
    // clamp that margin would drag the 24-hour boundary forward with it.
    applyRecency(Math.min(timeWindow.endMs, Date.now()));
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
