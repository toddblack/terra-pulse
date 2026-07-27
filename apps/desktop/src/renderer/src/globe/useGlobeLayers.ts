import { useEffect, useRef, type RefObject } from 'react';
import type * as Cesium from 'cesium';
import type { EarthquakeEvent, GlobeLayer } from '@terra-pulse/schema';
import {
  BASEMAP_REGISTRATIONS,
  OVERLAY_REGISTRATIONS,
  backdropToneFor,
  isOverlayVisible,
  type BasemapId,
} from '../layers/registry';

/** Show data layers regardless if basemap tiles haven't settled by now. */
const TILE_WAIT_FALLBACK_MS = 5_000;

interface UseGlobeLayersOptions {
  viewerRef: RefObject<Cesium.Viewer | null>;
  activeBasemapId: BasemapId;
  layerVisibility: Record<string, boolean>;
  events: readonly EarthquakeEvent[];
  /**
   * Changes once the viewer has been created. Effects here read the viewer
   * through a ref, which doesn't trigger re-renders, so this is what tells
   * them the viewer now exists.
   */
  viewerReadyToken: number;
}

/**
 * Owns mount/unmount for every registered layer.
 *
 * Toggling a layer mounts or unmounts it rather than calling `setVisible` —
 * one code path, and nothing switched off keeps holding Cesium objects.
 * `setVisible` stays on the `GlobeLayer` contract for layers that want to hide
 * without discarding expensive state.
 */
export function useGlobeLayers({
  viewerRef,
  activeBasemapId,
  layerVisibility,
  events,
  viewerReadyToken,
}: UseGlobeLayersOptions): void {
  // Whether data layers have been on screen at least once. Gates the
  // first-paint tile wait so it doesn't re-trigger on later rebuilds.
  const hasShownDataLayersRef = useRef(false);

  // --- Basemap: exclusive, mounts immediately (it *is* the planet) ---------
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    const registration = BASEMAP_REGISTRATIONS.find((entry) => entry.id === activeBasemapId);
    if (!registration) return;

    const layer = registration.create();
    layer.mount(viewer);

    return () => {
      layer.unmount();
    };
  }, [viewerRef, activeBasemapId, viewerReadyToken]);

  // --- Data layers: independent toggles, gated on the planet being there ---
  const backdropTone = backdropToneFor(activeBasemapId);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    const registrations = OVERLAY_REGISTRATIONS.filter((entry) =>
      isOverlayVisible(entry, layerVisibility),
    );
    if (registrations.length === 0) return;

    const mounted: GlobeLayer[] = [];
    let cancelled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const mountAll = () => {
      if (cancelled || mounted.length > 0) return;
      hasShownDataLayersRef.current = true;
      for (const registration of registrations) {
        const layer = registration.create({ events, backdropTone });
        layer.mount(viewer);
        mounted.push(layer);
      }
    };

    const onTileProgress = (queuedTileCount: number) => {
      if (queuedTileCount === 0) mountAll();
    };

    // Don't draw data on an empty planet. Local data returns in milliseconds
    // while basemap tiles come over the network, so without this the marks
    // hang in space before the globe arrives. Only the first paint waits —
    // switching basemaps re-fills the tile queue, and re-gating would make
    // every data layer blink out on each switch.
    if (hasShownDataLayersRef.current || viewer.scene.globe.tilesLoaded) {
      mountAll();
    } else {
      viewer.scene.globe.tileLoadProgressEvent.addEventListener(onTileProgress);
      // If tiles never settle — offline, blocked host — show the data anyway
      // rather than holding it hostage to the basemap.
      fallbackTimer = setTimeout(mountAll, TILE_WAIT_FALLBACK_MS);
    }

    return () => {
      cancelled = true;
      clearTimeout(fallbackTimer);
      if (!viewer.isDestroyed()) {
        viewer.scene.globe.tileLoadProgressEvent.removeEventListener(onTileProgress);
      }
      for (const layer of mounted) layer.unmount();
    };
    // `layerVisibility` keeps a stable identity across unrelated store writes
    // (Zustand merges shallowly), so it only changes when a layer is toggled.
  }, [viewerRef, events, backdropTone, layerVisibility, viewerReadyToken]);
}
