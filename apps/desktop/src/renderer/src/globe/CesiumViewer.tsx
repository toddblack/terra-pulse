import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { useGlobeStore } from '../state/useGlobeStore';
import { useEarthquakeStore } from '../state/useEarthquakeStore';
import { eventIdFromEntityId } from '../layers/earthquake-layer';
import { useGlobeLayers } from './useGlobeLayers';
import { useVisibleEarthquakes } from './useVisibleEarthquakes';
import styles from './CesiumViewer.module.css';

/**
 * Floor for the camera height used when centring on an event. The current
 * height is preserved otherwise — snapping to a fixed altitude would tear away
 * the user's global view every time they clicked something.
 */
const MIN_FOCUS_ALTITUDE_M = 250_000;

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
  const select = useEarthquakeStore((state) => state.select);
  const selectedEventId = useEarthquakeStore((state) => state.selectedEventId);
  const focusRequest = useEarthquakeStore((state) => state.focusRequest);

  // Viewer lifecycle: created once on mount, destroyed once on unmount.
  useEffect(() => {
    if (!containerRef.current) return;

    const viewer = new Cesium.Viewer(containerRef.current, {
      baseLayer: false, // basemaps are mounted by the layer registry
      animation: false,
      timeline: false,
      baseLayerPicker: false, // replaced by our own LayerPanel
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
    viewerReadyToken,
  });

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

      select(null);
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
  }, [selectedEventId, events, viewerReadyToken]);

  // Centring on an event, from selection or the inspector's Recenter button.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !focusRequest) return;

    const event = events.find((candidate) => candidate.id === focusRequest.eventId);
    if (!event) return;

    // Rotate to the event at the height the camera is already at, so the
    // user's zoom level survives the click.
    const height = Math.max(viewer.camera.positionCartographic.height, MIN_FOCUS_ALTITUDE_M);

    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(event.longitude, event.latitude, height),
      duration: 1,
    });
  }, [focusRequest, events]);

  return <div id="cesium-viewport" ref={containerRef} className={styles.viewport} />;
}
