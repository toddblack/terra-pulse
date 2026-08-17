import * as Cesium from 'cesium';
import {
  TEC_GRID_HEIGHT,
  TEC_GRID_WIDTH,
  type BackdropTone,
  type GlobeLayer,
  type TecGrid,
  type TecQuantity,
} from '@terra-pulse/schema';
import { paintTecRgba } from './tec-encoding';

/**
 * Total electron content — the charged upper atmosphere, from SWPC's GloTEC.
 *
 * ## Why the async raster swap is fine here
 *
 * The geomagnetic field layer had to be rebuilt around pre-rendered frames
 * because the *playhead* asked it to change several times a second, and Cesium's
 * imagery pipeline cannot keep up with that. This layer changes when a new map
 * is published — **every ten minutes** — so there is nothing to pre-render and
 * an async build is the right shape.
 *
 * The one rule carried over: the outgoing raster is removed only **after** the
 * replacement has decoded, via `fromUrl`. Dropping it at request time leaves a
 * gap that a busy main thread never closes, which is the bug that made the field
 * layer appear frozen.
 *
 * ## Why it does not follow the scrubber
 *
 * `setTimeWindow` is a deliberate no-op, as on the aurora. SWPC indexes about a
 * month of past maps, so history exists upstream — but nothing here stores it,
 * so scrubbing to 1975, or to last week, cannot show the ionosphere of then.
 * Leaving the current map up while the playhead sits in the past, unlabelled,
 * would be a straightforward lie about what is drawn; the legend says so.
 */
export const TEC_LAYER_ID = 'tec';

export interface TecLayer extends GlobeLayer {
  /** Draws a newly-arrived map. */
  setGrid(grid: TecGrid | null): void;
  /** Switches between total content and departure-from-expected. */
  setQuantity(quantity: TecQuantity): void;
}

export function isTecLayer(layer: GlobeLayer): layer is TecLayer {
  return layer.id === TEC_LAYER_ID && 'setGrid' in layer;
}

export function createTecLayer(
  tone: BackdropTone,
  initialGrid: TecGrid | null = null,
  initialQuantity: TecQuantity = 'tec',
): TecLayer {
  let viewer: Cesium.Viewer | null = null;
  let imageryLayer: Cesium.ImageryLayer | null = null;
  let mounted = false;
  let visible = false;
  let grid = initialGrid;
  let quantity = initialQuantity;

  /** Discards a decode superseded while it was in flight. */
  let sequence = 0;

  function render(): void {
    if (!viewer || viewer.isDestroyed() || !mounted) return;

    if (!grid) {
      // Nothing to draw — before the first fetch, or offline. Cleared rather
      // than left up: a map with no timestamp behind it is worse than none.
      if (imageryLayer) {
        viewer.imageryLayers.remove(imageryLayer, true);
        imageryLayer = null;
      }
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = TEC_GRID_WIDTH;
    canvas.height = TEC_GRID_HEIGHT;

    const context = canvas.getContext('2d');
    if (context) {
      const image = context.createImageData(TEC_GRID_WIDTH, TEC_GRID_HEIGHT);
      image.data.set(paintTecRgba(grid, quantity, tone));
      context.putImageData(image, 0, 0);
    }

    sequence += 1;
    const claimed = sequence;

    void Cesium.SingleTileImageryProvider.fromUrl(canvas.toDataURL('image/png'), {
      rectangle: Cesium.Rectangle.MAX_VALUE,
      credit: 'GloTEC (NOAA SWPC)',
    })
      .then((provider) => {
        if (claimed !== sequence || !mounted) return;
        if (!viewer || viewer.isDestroyed()) return;

        const next = viewer.imageryLayers.addImageryProvider(provider);
        next.show = visible;

        // Only now is the old one safe to drop.
        if (imageryLayer) viewer.imageryLayers.remove(imageryLayer, true);
        imageryLayer = next;
      })
      .catch((error: unknown) => {
        console.error('TEC raster failed to load', error);
      });
  }

  return {
    id: TEC_LAYER_ID,
    label: 'Ionosphere (live)',
    category: 'overlay',
    defaultVisible: false,

    mount(nextViewer) {
      viewer = nextViewer;
      mounted = true;
      // Mounted means visible: `useGlobeLayers` toggles overlays by mounting and
      // unmounting and never calls `setVisible`. The field layer shipped a bug
      // here once by defaulting this to false, and drew nothing while looking
      // entirely healthy.
      visible = true;
      render();
    },

    unmount() {
      mounted = false;
      if (viewer && !viewer.isDestroyed() && imageryLayer) {
        viewer.imageryLayers.remove(imageryLayer, true);
      }
      imageryLayer = null;
      viewer = null;
    },

    setTimeWindow() {
      // Deliberate no-op — see the note at the top of this file.
    },

    setVisible(next) {
      visible = next;
      if (imageryLayer) imageryLayer.show = next;
    },

    setGrid(next) {
      grid = next;
      render();
    },

    setQuantity(next) {
      if (next === quantity) return;
      quantity = next;
      render();
    },
  };
}
