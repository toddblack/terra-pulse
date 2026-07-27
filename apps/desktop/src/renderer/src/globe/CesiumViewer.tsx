import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import { useGlobeStore } from '../state/useGlobeStore';
import { useEarthquakeStore } from '../state/useEarthquakeStore';
import { createOsmBasemap } from '../layers/osm-basemap';
import { createSatelliteBasemap } from '../layers/satellite-basemap';
import { createEarthquakeLayer, eventIdFromEntityId } from '../layers/earthquake-layer';
import styles from './CesiumViewer.module.css';

const BASEMAP_FACTORIES = {
  osm: createOsmBasemap,
  satellite: createSatelliteBasemap,
} as const;

/**
 * Floor for the camera height used when centring on an event. The current
 * height is preserved otherwise — snapping to a fixed altitude would tear away
 * the user's global view every time they clicked something.
 */
const MIN_FOCUS_ALTITUDE_M = 250_000;

/** Show events regardless if the basemap's tiles haven't settled by now. */
const TILE_WAIT_FALLBACK_MS = 5_000;

export function CesiumViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  // Whether events have been on screen at least once — gates the first-paint
  // wait for basemap tiles so it doesn't re-trigger on later rebuilds.
  const hasShownEventsRef = useRef(false);
  const activeBasemap = useGlobeStore((state) => state.activeBasemap);
  const events = useEarthquakeStore((state) => state.events);
  const select = useEarthquakeStore((state) => state.select);
  const focusRequest = useEarthquakeStore((state) => state.focusRequest);

  // Viewer lifecycle: created once on mount, destroyed once on unmount.
  useEffect(() => {
    if (!containerRef.current) return;

    const viewer = new Cesium.Viewer(containerRef.current, {
      baseLayer: false, // we mount our own basemap layers below
      animation: false,
      timeline: false,
      baseLayerPicker: false, // replaced by our own BasemapToggle panel
      geocoder: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false, // replaced by our own EarthquakeInspector panel
    });
    viewerRef.current = viewer;

    return () => {
      // Non-negotiable #5: Cesium objects are not reclaimed by GC —
      // the viewer must be destroyed explicitly.
      viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  // Active basemap lifecycle: swaps whenever the store's selection changes.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    const layer = BASEMAP_FACTORIES[activeBasemap]();
    layer.mount(viewer);

    return () => {
      layer.unmount();
    };
  }, [activeBasemap]);

  // Earthquake layer. Rebuilt wholesale when the event set or basemap changes
  // — the depth ramp is basemap-dependent, so a swap genuinely needs new
  // colours. Rebuilding a few hundred entities is cheap and obviously
  // correct; incremental diffing is a Phase 6 concern needing a benchmark.
  //
  // On the very first paint this waits for the globe's tiles. Events come from
  // local SQLite in milliseconds while basemap tiles come over the network, so
  // without the wait the dots hang in empty space before the planet arrives.
  // Only the first mount waits: after that, switching basemaps briefly empties
  // the tile queue again, and re-gating would make the events blink out.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || events.length === 0) return;

    let layer: ReturnType<typeof createEarthquakeLayer> | null = null;
    let cancelled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const mountLayer = () => {
      if (cancelled || layer) return;
      hasShownEventsRef.current = true;
      layer = createEarthquakeLayer(events, activeBasemap);
      layer.mount(viewer);
    };

    const onTileProgress = (queuedTileCount: number) => {
      if (queuedTileCount === 0) mountLayer();
    };

    if (hasShownEventsRef.current || viewer.scene.globe.tilesLoaded) {
      mountLayer();
    } else {
      viewer.scene.globe.tileLoadProgressEvent.addEventListener(onTileProgress);
      // If tiles never finish — offline, a blocked host — the events should
      // still show rather than being held hostage by the basemap.
      fallbackTimer = setTimeout(mountLayer, TILE_WAIT_FALLBACK_MS);
    }

    return () => {
      cancelled = true;
      clearTimeout(fallbackTimer);
      if (!viewer.isDestroyed()) {
        viewer.scene.globe.tileLoadProgressEvent.removeEventListener(onTileProgress);
      }
      layer?.unmount();
    };
  }, [events, activeBasemap]);

  // Globe click → store. Using selectedEntityChanged rather than a raw
  // ScreenSpaceEventHandler gets deselect-on-empty-click for free and leaves
  // nothing extra to tear down.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    const onSelectionChanged = () => {
      const entityId = viewer.selectedEntity?.id;
      // Clicking a large event's emphasis ring must select the event itself,
      // not the ring entity that happens to carry the hit.
      select(typeof entityId === 'string' ? eventIdFromEntityId(entityId) : null);
    };

    viewer.selectedEntityChanged.addEventListener(onSelectionChanged);
    return () => {
      viewer.selectedEntityChanged.removeEventListener(onSelectionChanged);
    };
  }, [select]);

  // "Centre camera" from the inspector panel.
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
