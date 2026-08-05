/**
 * Deciding when the globe has actually painted, from Cesium's tile-queue
 * counter. Pure and Cesium-free so the latch can be tested without a viewer.
 */

export interface FirstPaintState {
  /** Whether the tile queue has ever been non-empty. */
  loadingStarted: boolean;
  /** Latched: once the globe has painted it never un-paints. */
  ready: boolean;
}

export const INITIAL_FIRST_PAINT: FirstPaintState = {
  loadingStarted: false,
  ready: false,
};

/**
 * Folds one `tileLoadProgressEvent` reading into the latch.
 *
 * **An empty queue only means "loaded" if loading ever started.** This is the
 * whole reason the module exists. `globe.tilesLoaded` is `true` on a freshly
 * created viewer, and the queue count is `0`, because Cesium doesn't request
 * anything until its next render frame — so a gate that trusts either one opens
 * immediately, and the data layers mount against an empty planet. That is
 * exactly the bug this replaces: earthquake dots hanging in space before the
 * globe arrives.
 *
 * `ready` latches. Switching basemaps refills the queue, and re-gating on that
 * would make every data layer blink out on each switch.
 */
export function observeTileQueue(state: FirstPaintState, queuedTileCount: number): FirstPaintState {
  if (state.ready) return state;

  if (queuedTileCount > 0) {
    return state.loadingStarted ? state : { ...state, loadingStarted: true };
  }

  // Queue is empty. Meaningful only if we saw it fill first.
  if (state.loadingStarted) return { loadingStarted: true, ready: true };

  return state;
}
