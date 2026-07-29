import { useEffect, useRef, useState, type RefObject } from 'react';
import type * as Cesium from 'cesium';
import type { EarthquakeEvent, GlobeLayer } from '@terra-pulse/schema';
import {
  BASEMAP_REGISTRATIONS,
  OVERLAY_REGISTRATIONS,
  backdropToneFor,
  isOverlayVisible,
  type BasemapId,
  type OverlayRegistration,
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
 * Whether the globe has painted at least once, so data layers can go on.
 *
 * Local data returns in milliseconds while basemap tiles come over the
 * network, so without this the marks hang in space before the planet arrives.
 * Latches true and stays there: switching basemaps re-fills the tile queue,
 * and re-gating would make every data layer blink out on each switch.
 *
 * This is deliberately *shared* by both overlay effects. When each effect
 * tracked its own gate, whichever mounted first satisfied it for the other —
 * which let the earthquake dots skip the wait and appear before the globe.
 */
function useFirstPaintReady(
  viewerRef: RefObject<Cesium.Viewer | null>,
  viewerReadyToken: number,
): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || ready) return;

    if (viewer.scene.globe.tilesLoaded) {
      setReady(true);
      return;
    }

    const onTileProgress = (queuedTileCount: number) => {
      if (queuedTileCount === 0) setReady(true);
    };
    viewer.scene.globe.tileLoadProgressEvent.addEventListener(onTileProgress);

    // If tiles never settle — offline, blocked host — show the data anyway
    // rather than holding it hostage to the basemap.
    const fallbackTimer = setTimeout(() => setReady(true), TILE_WAIT_FALLBACK_MS);

    return () => {
      clearTimeout(fallbackTimer);
      if (!viewer.isDestroyed()) {
        viewer.scene.globe.tileLoadProgressEvent.removeEventListener(onTileProgress);
      }
    };
  }, [viewerRef, viewerReadyToken, ready]);

  return ready;
}

/** Mounts a set of overlays and returns the matching teardown. */
function mountOverlays(
  viewer: Cesium.Viewer,
  registrations: readonly OverlayRegistration[],
  context: { events: readonly EarthquakeEvent[]; backdropTone: ReturnType<typeof backdropToneFor> },
): () => void {
  const mounted: GlobeLayer[] = [];

  for (const registration of registrations) {
    const layer = registration.create(context);
    layer.mount(viewer);
    mounted.push(layer);
  }

  return () => {
    for (const layer of mounted) layer.unmount();
  };
}

/**
 * Owns mount/unmount for every registered layer.
 *
 * Toggling a layer mounts or unmounts it rather than calling `setVisible` —
 * one code path, and nothing switched off keeps holding Cesium objects.
 * `setVisible` stays on the `GlobeLayer` contract for layers that want to hide
 * without discarding expensive state.
 *
 * Overlays are mounted in **two groups**, split on `consumesEvents`. A single
 * effect keyed on `events` rebuilt everything on every poll, which meant
 * throwing away and recreating 13,696 fault polylines on a timer — a visible
 * stutter mid-rotation, and 124 ms of material allocation for no change in
 * what was drawn. Geology doesn't move between polls.
 */
export function useGlobeLayers({
  viewerRef,
  activeBasemapId,
  layerVisibility,
  events,
  viewerReadyToken,
}: UseGlobeLayersOptions): void {
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

  const backdropTone = backdropToneFor(activeBasemapId);
  const firstPaintReady = useFirstPaintReady(viewerRef, viewerReadyToken);

  /**
   * Read by the static group through a ref rather than a dependency.
   *
   * Those layers ignore `events` entirely — `LayerContext` just carries it for
   * every layer — so depending on it would reintroduce the per-poll rebuild
   * this split exists to remove.
   *
   * Synced in an effect rather than during render (writing a ref while
   * rendering is a React anti-pattern, and the linter is right to reject it).
   * Ordering is not a hazard: this effect is declared before its consumer, and
   * a change to `events` alone doesn't re-run the static effect at all.
   */
  const eventsRef = useRef(events);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  // --- Static overlays: geology. Rebuilt only on tone or toggle changes ----
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !firstPaintReady) return;

    return mountOverlays(
      viewer,
      OVERLAY_REGISTRATIONS.filter(
        (entry) => isOverlayVisible(entry, layerVisibility) && entry.consumesEvents !== true,
      ),
      { events: eventsRef.current, backdropTone },
    );
    // `layerVisibility` keeps a stable identity across unrelated store writes
    // (Zustand merges shallowly), so it only changes when a layer is toggled.
  }, [viewerRef, backdropTone, layerVisibility, firstPaintReady, viewerReadyToken]);

  // --- Event-driven overlays: rebuilt when the catalogue changes -----------
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !firstPaintReady) return;

    return mountOverlays(
      viewer,
      OVERLAY_REGISTRATIONS.filter(
        (entry) => isOverlayVisible(entry, layerVisibility) && entry.consumesEvents === true,
      ),
      { events, backdropTone },
    );
  }, [viewerRef, events, backdropTone, layerVisibility, firstPaintReady, viewerReadyToken]);
}
