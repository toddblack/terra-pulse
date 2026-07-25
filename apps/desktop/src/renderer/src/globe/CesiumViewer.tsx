import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import { useGlobeStore } from '../state/useGlobeStore';
import { createOsmBasemap } from '../layers/osm-basemap';
import { createSatelliteBasemap } from '../layers/satellite-basemap';
import styles from './CesiumViewer.module.css';

const BASEMAP_FACTORIES = {
  osm: createOsmBasemap,
  satellite: createSatelliteBasemap,
} as const;

export function CesiumViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const activeBasemap = useGlobeStore((state) => state.activeBasemap);

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

  return <div id="cesium-viewport" ref={containerRef} className={styles.viewport} />;
}
