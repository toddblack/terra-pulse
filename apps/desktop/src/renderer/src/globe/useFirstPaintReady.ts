import { useEffect, useState, type RefObject } from 'react';
import type * as Cesium from 'cesium';
import { INITIAL_FIRST_PAINT, observeTileQueue } from './first-paint';

/** Show data layers regardless if basemap tiles haven't settled by now. */
export const TILE_WAIT_FALLBACK_MS = 5_000;

/**
 * Whether the globe has painted at least once, so marks can go on it.
 *
 * Local data returns in milliseconds while basemap tiles come over the
 * network, so without this the marks hang in space before the planet arrives.
 * Latches true and stays there: switching basemaps re-fills the tile queue,
 * and re-gating would make every data layer blink out on each switch.
 *
 * **One gate for everything drawn on the globe**, owned by `CesiumViewer` and
 * handed down. When each overlay effect tracked its own gate, whichever
 * mounted first satisfied it for the other — which let the earthquake dots
 * skip the wait and appear before the globe. And while the gate lived inside
 * `useGlobeLayers`, the watch pin (drawn by the viewer, not the registry)
 * never waited at all: a stored pin appeared alone in black space at every
 * launch, found by the user on 2026-10-21.
 */
export function useFirstPaintReady(
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
