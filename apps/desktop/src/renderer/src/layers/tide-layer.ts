import * as Cesium from 'cesium';
import type { BackdropTone, GlobeLayer } from '@terra-pulse/schema';
import { sampleTideGrid, type TidalBody } from './tides';
import { paintTideRgba } from './tide-encoding';
import { instantOnScreen } from '../globe/display-window';

export const TIDE_LAYER_ID = 'tides';

/**
 * The lunisolar equilibrium tide, as a raster that follows the scrubber.
 *
 * ## Why this one is computed live, when the field layer pre-renders frames
 *
 * `geomagnetic-field.ts` renders 66 frames up front and flips an alpha between
 * them, because the main field is effectively static over a year and a grid
 * costs 7.1 ms. **Neither is true here.** The tide has a 12.42-hour period, so
 * quantising finely enough to look smooth would mean thousands of frames per
 * month of playback — the pre-render trades memory for time in a ratio that
 * only works when time is coarse.
 *
 * What makes live rendering affordable is that a tide grid is **0.11 ms** at 2
 * degrees, measured — about 65x cheaper than the field's, because there is no
 * spherical-harmonic expansion here. Two body positions, then a dot product per
 * cell.
 *
 * ## The repaint budget, and the trap it is avoiding
 *
 * Computing the grid is not the cost; **turning it into an imagery layer is.**
 * Every repaint is a `toDataURL`, an async image decode and a new
 * `ImageryLayer`, and the field layer's notes are emphatic that Cesium's
 * `ImageryLayer` is not built to be swapped several times a second.
 *
 * So repaints are bounded twice over:
 *
 * - **Model time is quantised** to `QUANTUM_MS`, so a slow scrub that moves the
 *   playhead by seconds does not repaint at all. The tide pattern rotates about
 *   15 degrees an hour, so ten minutes is a quarter of a degree — well under
 *   what a 2-degree grid can express.
 * - **Wall-clock is throttled** with a trailing edge, so fast playback cannot
 *   outrun the decode. The trailing edge is what guarantees the *final*
 *   playhead position is the one drawn, rather than whichever frame won a race.
 *
 * The swap itself follows `tec-layer.ts`: add the new layer, and only then
 * remove the old one. Dropping the old at *request* time is what left a bare
 * globe under load, because `addImageryProvider` resolves before the PNG behind
 * it has decoded. `show` is never touched during a swap — hiding an imagery
 * layer destroys its tile imagery, which is what made the field layer flicker.
 */

/** Grid step. 2 degrees for the same reason the field grid uses it: the
 * quantity has no structure finer than this to lose. */
const STEP_DEG = 2;

/** How far the playhead must move before the picture is worth redrawing. */
const QUANTUM_MS = 10 * 60_000;

/**
 * Minimum wall-clock spacing between repaints, with a trailing edge.
 *
 * Every repaint is a new `ImageryLayer`, and each of those makes Cesium rebuild
 * tile-imagery skeletons for every visible tile. That is the expensive part —
 * not the grid, which is 0.11 ms — so this bounds the churn rather than the
 * arithmetic.
 */
const THROTTLE_MS = 300;

/**
 * Opacity of the raster, carried by the **layer** rather than by the pixels.
 *
 * It has to live here because `alpha` is also the cross-fade control: a frame
 * is added at 0 and raised to this once it is actually rendering. Baking the
 * opacity into the RGBA instead would leave nothing to fade with, and reaching
 * for `show` instead is the exact move that destroys tile imagery.
 */
const TIDE_ALPHA = 0.66;

/**
 * Runs `done` once the layer just added is genuinely on screen.
 *
 * `SingleTileImageryProvider.fromUrl` resolving only means the PNG decoded.
 * Cesium then has to re-run `_createTileImagerySkeletons` for every visible
 * tile and upload the texture, which happens over subsequent render frames —
 * so the moment the promise settles is precisely *not* the moment it is safe to
 * drop the previous frame.
 *
 * **`tilesLoaded` alone is not the signal**, and `first-paint.ts` records why:
 * it reads `true` before anything has been requested, because Cesium queues
 * work on its next render frame. So at least two frames must pass before an
 * empty queue is allowed to count. The frame cap keeps a busy or stalled globe
 * from parking a frame at alpha 0 forever.
 */
function whenRendering(viewer: Cesium.Viewer, done: () => void, maxFrames = 12): void {
  let frames = 0;
  const stop = viewer.scene.postRender.addEventListener(() => {
    frames += 1;
    if ((frames >= 2 && viewer.scene.globe.tilesLoaded) || frames >= maxFrames) {
      stop();
      done();
    }
  });
}

export interface TideLayer extends GlobeLayer {
  /** The sub-body points behind the frame on screen, for the legend. */
  currentBodies(): { sun: TidalBody; moon: TidalBody } | null;
}

export function isTideLayer(layer: GlobeLayer): layer is TideLayer {
  return layer.id === TIDE_LAYER_ID && 'currentBodies' in layer;
}

export function createTideLayer(tone: BackdropTone): TideLayer {
  let viewer: Cesium.Viewer | null = null;
  let mounted = false;
  let visible = false;
  let imageryLayer: Cesium.ImageryLayer | null = null;

  /** The instant on screen — the window's end, as every other layer reads it. */
  let instantMs = Date.now();
  /** The quantised instant actually drawn, so a repaint can be skipped. */
  let renderedQuantum: number | null = null;
  let bodies: { sun: TidalBody; moon: TidalBody } | null = null;

  /** Discards a decode superseded while it was in flight. */
  let sequence = 0;
  let lastPaintMs = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;

  function paint(): void {
    if (!viewer || viewer.isDestroyed() || !mounted) return;

    const at = new Date(instantMs);
    const grid = sampleTideGrid(at, STEP_DEG);
    bodies = grid.bodies;

    const canvas = document.createElement('canvas');
    canvas.width = grid.width;
    canvas.height = grid.height;

    const context = canvas.getContext('2d');
    if (context) {
      const image = context.createImageData(grid.width, grid.height);
      image.data.set(paintTideRgba(grid.values, tone));
      context.putImageData(image, 0, 0);
    }

    sequence += 1;
    const claimed = sequence;

    void Cesium.SingleTileImageryProvider.fromUrl(canvas.toDataURL('image/png'), {
      rectangle: Cesium.Rectangle.MAX_VALUE,
      credit: 'Lunisolar equilibrium tide (computed)',
    })
      .then((provider) => {
        if (claimed !== sequence || !mounted) return;
        if (!viewer || viewer.isDestroyed()) return;
        const active = viewer;

        const next = active.imageryLayers.addImageryProvider(provider);
        // Resident but not drawn. `alpha = 0` is the cheap flag — Cesium skips
        // it in `addDrawCommandsForTile` *before* counting texture units, so it
        // costs nothing to draw while still loading normally. `show = false`
        // would be the opposite: it routes to `_onLayerRemoved` and destroys
        // the tile imagery, which is what made the field layer flicker.
        next.alpha = 0;
        next.show = true;

        whenRendering(active, () => {
          if (!mounted || active.isDestroyed()) return;
          if (claimed !== sequence) {
            // Superseded while it was settling — drop it rather than let it
            // fight the newer frame for the same slot.
            active.imageryLayers.remove(next, true);
            return;
          }

          next.alpha = visible ? TIDE_ALPHA : 0;
          // Safe *now*: the replacement is genuinely on screen, so removing the
          // old one cannot leave a gap.
          if (imageryLayer) active.imageryLayers.remove(imageryLayer, true);
          imageryLayer = next;
        });
      })
      .catch((error: unknown) => {
        console.error('Tide raster failed to load', error);
      });
  }

  /**
   * Repaint if the picture would actually differ, no faster than the throttle.
   *
   * `force` bypasses the wall-clock throttle for a mount or a visibility
   * change, because a deferred response to a button press reads as a dead
   * button — the same carve-out the field layer makes for a quantity change.
   */
  function schedulePaint(force = false): void {
    const quantum = Math.round(instantMs / QUANTUM_MS);
    if (!force && quantum === renderedQuantum) return;
    renderedQuantum = quantum;

    if (trailing) {
      clearTimeout(trailing);
      trailing = null;
    }

    const sinceLast = Date.now() - lastPaintMs;
    if (force || sinceLast >= THROTTLE_MS) {
      lastPaintMs = Date.now();
      paint();
      return;
    }

    // Trailing edge: whatever the playhead settles on is what gets drawn.
    trailing = setTimeout(() => {
      trailing = null;
      lastPaintMs = Date.now();
      paint();
    }, THROTTLE_MS - sinceLast);
  }

  return {
    id: TIDE_LAYER_ID,
    label: 'Tidal potential',
    category: 'analysis',
    defaultVisible: false,

    mount(nextViewer) {
      viewer = nextViewer;
      mounted = true;
      // Mounted means visible: `useGlobeLayers` toggles overlays by mounting
      // and unmounting and never calls `setVisible`. The field layer shipped a
      // bug here once by defaulting this to false, and drew nothing while
      // looking entirely healthy.
      visible = true;
      // Deferred one microtask, because `mountOverlays` calls `mount` and then
      // `setTimeWindow` synchronously — painting now would render the frame for
      // whatever instant this closure was constructed with, usually today,
      // rather than for the playhead the caller is about to set.
      void Promise.resolve().then(() => {
        if (mounted) schedulePaint(true);
      });
    },

    unmount() {
      mounted = false;
      if (trailing) {
        clearTimeout(trailing);
        trailing = null;
      }
      if (viewer && !viewer.isDestroyed() && imageryLayer) {
        viewer.imageryLayers.remove(imageryLayer, true);
      }
      imageryLayer = null;
      bodies = null;
      renderedQuantum = null;
      viewer = null;
    },

    setTimeWindow(_start, end) {
      // Clamped to now: in live mode the window's end sits an hour ahead
      // (`LIVE_END_MARGIN_MS`, an allowance for events with clock skew, not a
      // statement about the time). Unclamped, the live view would draw the tide
      // an hour in the future — 15 degrees of rotation, a visibly wrong bulge
      // position. Scrubbed into the past, `end` is the playhead and this is a
      // no-op.
      instantMs = instantOnScreen(end.getTime(), Date.now());
      schedulePaint();
    },

    setVisible(next) {
      visible = next;
      // Alpha, never `show` — see `whenRendering`. Hiding an imagery layer
      // destroys its tile imagery and showing it again re-uploads the texture,
      // so toggling this layer off and on would cost a full reload.
      if (imageryLayer) imageryLayer.alpha = next ? TIDE_ALPHA : 0;
    },

    currentBodies() {
      return bodies;
    },
  };
}
