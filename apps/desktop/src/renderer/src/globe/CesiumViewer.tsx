import { useEffect, useMemo, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { useGlobeStore } from '../state/useGlobeStore';
import { previousWindowHours } from '@terra-pulse/schema';
import { useEarthquakeStore, windowStartMs } from '../state/useEarthquakeStore';
import { eventIdFromEntityId } from '../layers/earthquake-layer';
import { focusAltitudeM } from './camera-focus';
import { useGlobeLayers } from './useGlobeLayers';
import { useNow } from './useNow';
import { usePlayback } from './usePlayback';
import { useVisibleEarthquakes } from './useVisibleEarthquakes';
import styles from './CesiumViewer.module.css';

/**
 * How far the pointer must travel with the button held before it counts as a
 * drag rather than a slightly shaky click.
 */
const DRAG_THRESHOLD_PX = 5;

export function CesiumViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  // The viewer lives in a ref (it must not trigger re-renders), so this is
  // what tells dependent effects that it now exists.
  const [viewerReadyToken, setViewerReadyToken] = useState(0);

  const activeBasemapId = useGlobeStore((state) => state.activeBasemapId);
  const layerVisibility = useGlobeStore((state) => state.layerVisibility);

  // The filtered projection, not the canonical set — the layer, the camera
  // and the selection all operate on what's actually on screen.
  const events = useVisibleEarthquakes();
  const windowHours = useEarthquakeStore((state) => state.windowHours);
  const playheadMs = useEarthquakeStore((state) => state.playheadMs);

  /**
   * The window the layers should display.
   *
   * Always a window, never null — live mode is simply a window whose end sits
   * slightly in the future, which keeps one code path instead of two. The
   * margin exists so a freshly-polled event can't land after the end and be
   * hidden; the earthquake layer clamps it back to now before measuring
   * recency, so it doesn't drag the 24-hour boundary along with it.
   */
  const nowMs = useNow();
  const trailingWindow = useEarthquakeStore((state) => state.trailingWindow);
  const timeWindow = useMemo(() => {
    const endMs = playheadMs ?? nowMs + 60 * 60 * 1000;
    const trailHours = trailingWindow ? previousWindowHours(windowHours) : null;

    return {
      // A trailing window moves the *start* with the playhead instead of
      // pinning it to the span's beginning. It goes through `setTimeWindow`
      // rather than narrowing the built event set, because that is the cheap
      // channel — narrowing the set would rebuild every entity on every tick.
      startMs:
        trailHours === null ? windowStartMs(windowHours, nowMs) : endMs - trailHours * 3_600_000,
      endMs,
    };
  }, [windowHours, playheadMs, nowMs, trailingWindow]);
  const select = useEarthquakeStore((state) => state.select);
  const selectedEventId = useEarthquakeStore((state) => state.selectedEventId);
  const focusRequest = useEarthquakeStore((state) => state.focusRequest);
  const antipodeEventId = useEarthquakeStore((state) => state.antipodeEventId);
  const hideAntipode = useEarthquakeStore((state) => state.hideAntipode);

  // Resolved from the loaded set rather than held in the store, so the chord
  // follows revisions to the event like every other view does.
  const antipodeEvent = useMemo(
    () => events.find((candidate) => candidate.id === antipodeEventId) ?? null,
    [events, antipodeEventId],
  );

  /** Read by the drag handler without making it depend on the mode. */
  const antipodeActiveRef = useRef(antipodeEventId !== null);
  useEffect(() => {
    antipodeActiveRef.current = antipodeEventId !== null;
  }, [antipodeEventId]);

  // Escape leaves the antipode view. The mode covers the globe in translucency
  // and a chord, so it needs an exit that doesn't depend on finding a button.
  useEffect(() => {
    if (antipodeEventId === null) return;

    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') hideAntipode();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [antipodeEventId, hideAntipode]);

  // Viewer lifecycle: created once on mount, destroyed once on unmount.
  useEffect(() => {
    if (!containerRef.current) return;

    const viewer = new Cesium.Viewer(containerRef.current, {
      baseLayer: false, // basemaps are mounted by the layer registry
      animation: false,
      timeline: false,
      baseLayerPicker: false, // replaced by our own LayerPanel
      // The last default widget still on, and it sat under the event list.
      // Every other Cesium control here is already replaced by our own chrome,
      // so this was the odd one out visually as well as in the way.
      //
      // Worth knowing what goes with it: it was the only "reset the camera"
      // affordance, and preserving zoom across selections made staying zoomed
      // in stickier than it used to be. If getting back to a global view by
      // hand becomes annoying, the answer is a reset control in our own UI
      // where we choose the position — not this one back.
      homeButton: false,
      geocoder: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false, // replaced by our own EarthquakeInspector panel
    });
    viewerRef.current = viewer;
    setViewerReadyToken((token) => token + 1);

    return () => {
      // Non-negotiable #5: Cesium objects are not reclaimed by GC —
      // the viewer must be destroyed explicitly.
      viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  // All layer mounting/unmounting lives in the registry-driven hook.
  useGlobeLayers({
    viewerRef,
    activeBasemapId,
    layerVisibility,
    events,
    antipodeEvent,
    timeWindow,
    viewerReadyToken,
  });

  // Drives the playhead forward while playback is running.
  usePlayback();

  // Globe click → store.
  //
  // Explicit picking rather than Cesium's `selectedEntityChanged`, which fires
  // with `undefined` both when the user clicks empty space *and* when the
  // selected entity is destroyed. Those are indistinguishable to a listener —
  // so once the 60s poll started rebuilding the layer, the panel would close
  // on its own every time new data arrived. Doing our own pick means
  // "deselected" can only mean the user actually clicked nothing.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const picked: unknown = viewer.scene.pick(movement.position);
      const entityId: unknown =
        picked && typeof picked === 'object' && 'id' in picked
          ? (picked as { id?: { id?: unknown } }).id?.id
          : undefined;

      // Clicking a large event's emphasis ring must select the event itself,
      // not the ring entity that happens to carry the hit.
      select(typeof entityId === 'string' ? eventIdFromEntityId(entityId) : null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // Dragging the globe clears the selection: once you start moving the view
    // you're done with that event, and a panel describing it is just clutter.
    //
    // Tracked from the raw pointer rather than a camera event because the
    // camera also moves when *we* fly it to a freshly-selected event — using
    // camera movement would make selecting an event instantly deselect it.
    let dragOrigin: Cesium.Cartesian2 | undefined;

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      dragOrigin = Cesium.Cartesian2.clone(event.position);
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (!dragOrigin) return;
      if (Cesium.Cartesian2.distance(dragOrigin, event.endPosition) < DRAG_THRESHOLD_PX) return;

      // Suppressed while the antipode chord is up. Spinning the globe to see
      // where the chord comes out is the entire point of that mode, and
      // deselecting would take the chord *and* the inspector holding its exit
      // control away on the first drag. Read through a ref so this handler
      // isn't torn down and rebuilt every time the mode changes.
      if (!antipodeActiveRef.current) select(null);
      // Cleared so a single drag deselects once rather than on every frame.
      dragOrigin = undefined;
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction(() => {
      dragOrigin = undefined;
    }, Cesium.ScreenSpaceEventType.LEFT_UP);

    return () => {
      // Non-negotiable #5 applies to handlers too.
      handler.destroy();
    };
  }, [select, viewerReadyToken]);

  // Store → Cesium selection, so the reticle follows the store and survives a
  // layer rebuild. Entities live inside each layer's own data source, so this
  // searches the mounted sources rather than `viewer.entities`.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    if (selectedEventId === null) {
      viewer.selectedEntity = undefined;
      return;
    }

    for (let i = 0; i < viewer.dataSources.length; i++) {
      const entity = viewer.dataSources.get(i).entities.getById(selectedEventId);
      if (entity) {
        viewer.selectedEntity = entity;
        return;
      }
    }

    // Selected but not on screen — the filters excluded it, or the layer was
    // rebuilt without it. Clear rather than fall through: leaving the previous
    // value would keep Cesium holding an entity that has since been destroyed.
    viewer.selectedEntity = undefined;
  }, [selectedEventId, events, viewerReadyToken]);

  /**
   * Events for the focus effect, read through a ref so that changing the
   * filters doesn't move the camera.
   *
   * The focus effect needs the event list to look up coordinates, but it must
   * fire *only* when a new focus is requested. With `events` as a dependency,
   * adjusting the magnitude or time filter re-ran the effect while a
   * `focusRequest` from some earlier click was still in the store — so the
   * globe flew back to a previously selected quake instead of staying where
   * the user had it.
   */
  const eventsRef = useRef(events);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  // Centring on an event, from selection or the inspector's Recenter button.
  //
  // `focusRequest` carries a nonce, so this fires once per request and re-fires
  // when the same event is picked again. That nonce is the *only* thing that
  // should move the camera.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !focusRequest) return;

    const event = eventsRef.current.find((candidate) => candidate.id === focusRequest.eventId);
    if (!event) return;

    // Rotate to the event at the height the camera is already at, so the
    // user's zoom level survives the click — including when zoomed in close,
    // which is when it matters and is exactly what the old floor broke.
    const height = focusAltitudeM(viewer.camera.positionCartographic.height);

    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(event.longitude, event.latitude, height),
      duration: 1,
    });
  }, [focusRequest]);

  return <div id="cesium-viewport" ref={containerRef} className={styles.viewport} />;
}
