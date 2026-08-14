import * as Cesium from 'cesium';
import type { AuroraGrid, GlobeLayer } from '@terra-pulse/schema';
import { paintAuroraRgba } from './aurora-encoding';

/**
 * The auroral oval, live from NOAA SWPC's OVATION Prime forecast.
 *
 * ## Why this one may swap rasters asynchronously and the field layer may not
 *
 * The field layer pre-renders every frame because the playhead asks it to
 * change several times a second, and Cesium's imagery pipeline cannot keep up
 * with that. This layer changes when **new data arrives — every five minutes**.
 * At that rate an async build is not merely acceptable, it is the right shape:
 * there is nothing to pre-render, because the next grid does not exist yet.
 *
 * The one thing carried over from that episode: the outgoing raster is removed
 * only **after** the replacement has decoded, via `fromUrl`. Removing it at
 * request time leaves a gap, which at this cadence would be a visible blink
 * every five minutes rather than a permanent disappearance.
 *
 * ## It is not time-driven
 *
 * `setTimeWindow` is a deliberate no-op. The product is a forecast for the next
 * hour and there is no archive of past grids — scrubbing to 1975 cannot show
 * the aurora of 1975, and quietly leaving the current oval on screen while the
 * playhead sits in the past would be a lie about what is being displayed. The
 * legend prints the observation time so the reader can see it does not follow.
 */
export const AURORA_LAYER_ID = 'aurora';

export interface AuroraLayer extends GlobeLayer {
  /** Draws a newly-arrived grid. */
  setGrid(grid: AuroraGrid | null): void;
}

export function isAuroraLayer(layer: GlobeLayer): layer is AuroraLayer {
  return layer.id === AURORA_LAYER_ID && 'setGrid' in layer;
}

export function createAuroraLayer(initialGrid: AuroraGrid | null = null): AuroraLayer {
  let viewer: Cesium.Viewer | null = null;
  let imageryLayer: Cesium.ImageryLayer | null = null;
  let mounted = false;
  let visible = false;
  let grid = initialGrid;

  /** Discards a decode superseded while it was in flight. */
  let sequence = 0;

  function render(): void {
    if (!viewer || viewer.isDestroyed() || !mounted) return;

    if (!grid) {
      // Nothing to draw — before the first poll, or offline. Clearing rather
      // than leaving the last oval up: a forecast with no timestamp behind it
      // is worse than an empty globe.
      if (imageryLayer) {
        viewer.imageryLayers.remove(imageryLayer, true);
        imageryLayer = null;
      }
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = grid.width;
    canvas.height = grid.height;

    const context = canvas.getContext('2d');
    if (context) {
      const image = context.createImageData(grid.width, grid.height);
      image.data.set(paintAuroraRgba(grid));
      context.putImageData(image, 0, 0);
    }

    sequence += 1;
    const claimed = sequence;

    void Cesium.SingleTileImageryProvider.fromUrl(canvas.toDataURL('image/png'), {
      rectangle: Cesium.Rectangle.MAX_VALUE,
      credit: 'OVATION Prime (NOAA SWPC)',
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
        console.error('Aurora raster failed to load', error);
      });
  }

  return {
    id: AURORA_LAYER_ID,
    label: 'Aurora (live)',
    category: 'overlay',
    defaultVisible: false,

    mount(v) {
      viewer = v;
      mounted = true;
      // Mounted means visible: `useGlobeLayers` toggles overlays by mounting
      // and unmounting and never calls `setVisible`.
      visible = true;
      render();
    },

    unmount() {
      mounted = false;
      // Invalidates any decode in flight so it can't attach to a dead viewer.
      sequence += 1;
      if (viewer && !viewer.isDestroyed() && imageryLayer) {
        viewer.imageryLayers.remove(imageryLayer, true);
      }
      viewer = null;
      imageryLayer = null;
    },

    setTimeWindow() {
      // Deliberately nothing — see the note at the top. This layer shows now.
    },

    setVisible(v) {
      visible = v;
      if (imageryLayer) imageryLayer.show = v;
    },

    setGrid(next) {
      grid = next;
      render();
    },
  };
}
