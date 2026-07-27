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

/** Camera height when centring on an event — close enough to see the region. */
const FOCUS_ALTITUDE_M = 1_500_000;

export function CesiumViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
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
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || events.length === 0) return;

    const layer = createEarthquakeLayer(events, activeBasemap);
    layer.mount(viewer);

    return () => {
      layer.unmount();
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

    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(event.longitude, event.latitude, FOCUS_ALTITUDE_M),
    });
  }, [focusRequest, events]);

  return <div id="cesium-viewport" ref={containerRef} className={styles.viewport} />;
}
