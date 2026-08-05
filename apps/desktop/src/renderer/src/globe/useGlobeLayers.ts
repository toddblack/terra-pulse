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
import { INITIAL_FIRST_PAINT, observeTileQueue } from './first-paint';
import { createAntipodeLayer } from '../layers/antipode-layer';

/** Show data layers regardless if basemap tiles haven't settled by now. */
const TILE_WAIT_FALLBACK_MS = 5_000;

interface UseGlobeLayersOptions {
  viewerRef: RefObject<Cesium.Viewer | null>;
  activeBasemapId: BasemapId;
  layerVisibility: Record<string, boolean>;
  events: readonly EarthquakeEvent[];
  /**
   * The event whose antipode chord is on screen, or `null`.
   *
   * Not a registered layer — it is a mode entered from one event rather than
   * something toggled in the layer panel — so it is mounted here alongside
   * them instead of through the registry.
   */
  antipodeEvent: EarthquakeEvent | null;
  /**
   * The window layers should currently display, or `null` for "everything".
   *
   * Passed as a window rather than a playhead because `GlobeLayer.setTimeWindow`
   * is the contract every layer already implements — playback is a moving upper
   * bound on that window, not a new concept.
   */
  timeWindow: { startMs: number; endMs: number } | null;
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

    // No `tilesLoaded` short-circuit. It reads `true` on a freshly created
    // viewer — nothing is queued because nothing has been *requested* yet — so
    // checking it here opened the gate immediately and put the dots back in
    // front of the globe. `observeTileQueue` requires the queue to fill before
    // an empty queue counts as painted.
    let paintState = INITIAL_FIRST_PAINT;

    const onTileProgress = (queuedTileCount: number) => {
      paintState = observeTileQueue(paintState, queuedTileCount);
      if (paintState.ready) setReady(true);
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

/**
 * Mounts a set of overlays and returns the matching teardown.
 *
 * `track` receives the mounted layers so the caller can keep pushing time
 * windows at them after mount, and drops them again on teardown.
 */
function mountOverlays(
  viewer: Cesium.Viewer,
  registrations: readonly OverlayRegistration[],
  context: { events: readonly EarthquakeEvent[]; backdropTone: ReturnType<typeof backdropToneFor> },
  window: { startMs: number; endMs: number } | null,
  track: Set<GlobeLayer>,
): () => void {
  const mounted: GlobeLayer[] = [];

  for (const registration of registrations) {
    const layer = registration.create(context);
    layer.mount(viewer);
    // Apply the current window immediately: a layer mounted mid-playback must
    // not flash its full event set before the next tick corrects it.
    if (window) layer.setTimeWindow(new Date(window.startMs), new Date(window.endMs));
    mounted.push(layer);
    track.add(layer);
  }

  return () => {
    for (const layer of mounted) {
      track.delete(layer);
      layer.unmount();
    }
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
  antipodeEvent,
  timeWindow,
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

  /**
   * Every currently-mounted overlay, so the playhead can be pushed to them
   * without remounting anything.
   *
   * Playback updates the window up to twenty times a second. Rebuilding layers
   * at that rate is out of the question, which is why `setTimeWindow` exists on
   * the contract — it's the cheap channel. A Set rather than an array because
   * two independent effects add and remove from it.
   */
  const mountedLayersRef = useRef<Set<GlobeLayer>>(new Set());

  /** Read by the mount effects without making them depend on the playhead. */
  const timeWindowRef = useRef(timeWindow);
  useEffect(() => {
    timeWindowRef.current = timeWindow;
  }, [timeWindow]);

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
      timeWindowRef.current,
      mountedLayersRef.current,
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
      timeWindowRef.current,
      mountedLayersRef.current,
    );
  }, [viewerRef, events, backdropTone, layerVisibility, firstPaintReady, viewerReadyToken]);

  // --- Antipode: a mode, not a registered layer ---------------------------
  //
  // Rebuilt only when the event changes. It owns globe translucency, so its
  // unmount is what gives the planet back — an early return that skipped
  // cleanup would leave the whole globe see-through.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !firstPaintReady || !antipodeEvent) return;

    const layer = createAntipodeLayer(antipodeEvent, backdropTone);
    layer.mount(viewer);

    return () => {
      layer.unmount();
    };
  }, [viewerRef, antipodeEvent, backdropTone, firstPaintReady, viewerReadyToken]);

  // Fades the event marks while the chord is up, so 26,000 dots visible through
  // a translucent globe don't drown the one line that was asked for. Pushed to
  // mounted layers rather than rebuilding them — same channel as the playhead,
  // and for the same reason.
  useEffect(() => {
    for (const layer of mountedLayersRef.current) {
      layer.setDimmed?.(antipodeEvent !== null);
    }
  }, [antipodeEvent, events]);

  // --- Playhead: pushed to whatever is mounted, no rebuild ----------------
  //
  // Declared last so it runs after the mount effects in any commit that does
  // both — a layer mounted this tick has already had the window applied by
  // `mountOverlays`, and this then keeps it current.
  useEffect(() => {
    if (!timeWindow) return;
    const start = new Date(timeWindow.startMs);
    const end = new Date(timeWindow.endMs);
    for (const layer of mountedLayersRef.current) {
      layer.setTimeWindow(start, end);
    }
  }, [timeWindow]);
}
