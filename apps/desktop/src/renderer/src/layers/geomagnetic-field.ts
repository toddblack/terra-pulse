import * as Cesium from 'cesium';
import type { BackdropTone, GlobeLayer } from '@terra-pulse/schema';
import { paintFieldRgba } from './field-encoding';
import {
  IGRF_FIRST_YEAR,
  IGRF_LAST_YEAR,
  decimalYear,
  sampleFieldGrid,
  type FieldQuantity,
} from './igrf';

/**
 * Earth's main magnetic field, drawn as a raster over the globe.
 *
 * ## Why a raster and not entities
 *
 * Even at 2 degrees this is 16,380 cells, and at 1 degree it would be 65,160 —
 * 2.4x the widest archive view, already measured at 590 ms to build. Entities
 * would make it the most expensive thing in the app by a wide margin, to draw
 * something that is fundamentally an image.
 *
 * ## Why the frames are pre-rendered
 *
 * **This is the second design; the first one could not be made to work.** It
 * built a fresh raster on every playhead tick: compute grid, paint canvas,
 * encode PNG, decode it asynchronously, construct a provider, add a layer,
 * remove the old one. Three separate bugs came out of that pipeline in
 * succession — a layer attached hidden, an old raster dropped before its
 * replacement had decoded, and a sequence guard that discarded every frame
 * because a newer one had always been *requested* before the previous finished
 * loading. Each fix exposed the next. Cesium's `ImageryLayer` is not built to be
 * swapped several times a second, and no amount of guarding changes that.
 *
 * So nothing is built during playback at all. The frames are rendered once and
 * playback selects between them with **`alpha`** — the same idea as the
 * earthquake layer's `show` flags, and the project's own rule: **built set
 * stable, visibility live.**
 *
 * ## Why alpha and not `show`
 *
 * Because `show` is not a cheap flag, which cost another round to discover. In
 * `GlobeSurfaceTileProvider`, `_onLayerShownOrHidden` routes a hide straight to
 * `_onLayerRemoved` — hiding a layer **destroys its tile imagery**, and showing
 * it again re-creates the skeletons and re-uploads the texture. Flipping `show`
 * per frame therefore tore down and rebuilt on every step, which showed up as an
 * even flicker throughout playback.
 *
 * `alpha` has no such path: it is read during compositing, where
 * `addDrawCommandsForTile` does `if (imagery.imageryLayer.alpha === 0.0)
 * continue;` **before** counting texture units. So a frame at alpha 0 keeps its
 * texture resident and costs nothing to draw, and selecting a frame is a uniform
 * change with nothing to reload. Every frame stays `show = true` for its whole
 * life; only alpha moves.
 *
 * The whole class of problem disappears with it — there is no encode, no decode,
 * no allocation and nothing to starve on the frame path, so a busy main thread
 * can no longer make the layer vanish.
 *
 * ## What it costs
 *
 * A frame is 180x91 RGBA, about 65 KB of texture; 66 of them is **~4 MB of
 * VRAM**, all resident. Sampling one costs **7.1 ms**, so a full warm-up is about **half a
 * second** of CPU spread across the background build — each image load yields to
 * the event loop, the frame under the playhead is built first, and whatever
 * exists already stays on screen meanwhile.
 */

/**
 * Grid resolution: two degrees.
 *
 * **Measured, not guessed.** One degree costs 47.4 ms a frame — 3.1 s for a full
 * warm-up — against 7.1 ms at two degrees, a 6.7x saving (better than the 4x the
 * area suggests, because the Legendre table is computed once per row). The
 * penalty is a maximum deviation of **402 nT on a 50,000 nT scale**: 0.8%, which
 * is 7% of one step of the colour ramp, so nothing is visible.
 *
 * It is free because there is no detail to lose. IGRF is a degree-13 model, so
 * its shortest wavelength is about 40,000/13 = 3,000 km, roughly 27 degrees —
 * two-degree sampling is an order of magnitude past what the model can resolve.
 * Cesium's bilinear filtering smooths the rest.
 */
const GRID_WIDTH = 180;
const GRID_HEIGHT = 91;

/**
 * Spacing between pre-rendered frames, in years.
 *
 * Two, not the model's own five-year epoch spacing. IGRF is linear between
 * epochs so epoch frames are the exact model states, but 27 of them across 130
 * years is about one frame per second of playback — visibly steppy. Two years
 * gives 66 frames, roughly 5 per second at the widest span.
 *
 * **This is the knob.** Halving it doubles the frame count, the warm-up time and
 * the VRAM. At the current grid all three are cheap, so the thing to watch is
 * the number of imagery layers rather than the memory.
 */
const FRAME_STEP_YEARS = 2;

/** Opaque enough to read as a field, sheer enough to keep the coastlines. */
const DEFAULT_ALPHA = 0.62;

export const GEOMAGNETIC_FIELD_LAYER_ID = 'geomagnetic-field';

export interface GeomagneticFieldLayer extends GlobeLayer {
  /** Switch between total intensity, declination and inclination. */
  setQuantity(quantity: FieldQuantity): void;
  /** Which quantity is currently drawn. */
  getQuantity(): FieldQuantity;
  /** How many frames are ready, out of how many. For tests and diagnostics. */
  frameProgress(): { ready: number; total: number };
}

/**
 * Narrows a mounted layer to this one.
 *
 * The quantity is deliberately **not** a `LayerContext` field and **not** an
 * optional method on `GlobeLayer`. In the context it would rebuild every static
 * overlay on each click — 13,696 fault polylines included — which is the exact
 * cost the `consumesEvents` split exists to avoid. On the shared interface it
 * would push a one-layer concern into the schema package. So the caller narrows.
 */
export function isGeomagneticFieldLayer(layer: GlobeLayer): layer is GeomagneticFieldLayer {
  return layer.id === GEOMAGNETIC_FIELD_LAYER_ID && 'setQuantity' in layer;
}

/** Every year a frame is rendered for, ascending. */
export function frameYears(stepYears: number = FRAME_STEP_YEARS): number[] {
  const years: number[] = [];
  for (let year = IGRF_FIRST_YEAR; year <= IGRF_LAST_YEAR; year += stepYears) {
    years.push(year);
  }
  return years;
}

/** The frame that best represents a date, clamped to the model's span. */
export function nearestFrameYear(year: number, stepYears: number = FRAME_STEP_YEARS): number {
  const clamped = Math.min(Math.max(year, IGRF_FIRST_YEAR), IGRF_LAST_YEAR);
  const steps = Math.round((clamped - IGRF_FIRST_YEAR) / stepYears);
  const snapped = IGRF_FIRST_YEAR + steps * stepYears;
  // The last step can overshoot when the span isn't an exact multiple.
  return Math.min(snapped, frameYears(stepYears).at(-1) ?? snapped);
}

/**
 * Sizing overrides.
 *
 * Exists so tests can use a coarse grid and a wide frame step: a full warm-up
 * is 66 frames of spherical-harmonic sampling, and a suite paying that several
 * times is slow enough to start timing out neighbouring tests under load. The
 * defaults are the real values, and `frameYears()` still reports the production
 * spacing.
 */
export interface FieldLayerSizing {
  gridWidth?: number;
  gridHeight?: number;
  frameStepYears?: number;
}

export function createGeomagneticFieldLayer(
  tone: BackdropTone,
  initialQuantity: FieldQuantity = 'intensity',
  sizing: FieldLayerSizing = {},
): GeomagneticFieldLayer {
  const gridWidth = sizing.gridWidth ?? GRID_WIDTH;
  const gridHeight = sizing.gridHeight ?? GRID_HEIGHT;
  const stepYears = sizing.frameStepYears ?? FRAME_STEP_YEARS;

  const years = (): number[] => frameYears(stepYears);
  const snap = (year: number): number => nearestFrameYear(year, stepYears);

  let viewer: Cesium.Viewer | null = null;
  let visible = false;
  let mounted = false;
  let quantity = initialQuantity;
  let currentYear = decimalYear(new Date());

  /** Rendered frames for the *current* quantity, keyed by frame year. */
  const frames = new Map<number, Cesium.ImageryLayer>();
  /** Which frame is currently showing, so it can be hidden when another wins. */
  let shownYear: number | null = null;
  /**
   * Bumped whenever the frame set is invalidated (quantity change, unmount), so
   * a build still in flight knows to stop and discard what it was about to add.
   */
  let generation = 0;
  /** Frames whose decode threw, so the build doesn't retry them forever. */
  const failed = new Set<number>();

  function renderCanvas(year: number): HTMLCanvasElement {
    const values = sampleFieldGrid(year, gridWidth, gridHeight, quantity);
    const rgba = paintFieldRgba(values, gridWidth, gridHeight, quantity, tone);

    const canvas = document.createElement('canvas');
    canvas.width = gridWidth;
    canvas.height = gridHeight;

    const context = canvas.getContext('2d');
    if (context) {
      // Built through the context rather than `new ImageData(rgba, ...)`: the
      // constructor's typing pins the backing buffer to a plain ArrayBuffer,
      // which a freshly allocated Uint8ClampedArray does not satisfy.
      const image = context.createImageData(gridWidth, gridHeight);
      image.data.set(rgba);
      context.putImageData(image, 0, 0);
    }

    return canvas;
  }

  /**
   * Selects the frame nearest the playhead by raising its alpha.
   *
   * The incoming frame is raised *before* the outgoing one is dropped, so there
   * is never an instant with neither on screen. If the frame isn't built yet
   * this does nothing and whatever is already up stays up — which is why a
   * partly-warm layer degrades to a coarser animation rather than a blank globe.
   */
  function applyFrame(): void {
    const target = snap(currentYear);
    const next = frames.get(target);
    if (!next) return;

    next.alpha = visible ? DEFAULT_ALPHA : 0;

    if (shownYear !== target) {
      const previous = shownYear === null ? undefined : frames.get(shownYear);
      if (previous && previous !== next) previous.alpha = 0;
      shownYear = target;
    }
  }

  /**
   * The unbuilt frame closest to where the playhead is *now*, or null when the
   * set is complete.
   *
   * Chosen per iteration rather than ordering the whole queue once up front, so
   * scrubbing during the warm-up re-aims the build at what is actually being
   * looked at instead of finishing a plan made at mount time.
   */
  function nextFrameToBuild(): number | null {
    const target = snap(currentYear);
    let best: number | null = null;
    let bestDistance = Infinity;

    for (const year of years()) {
      if (frames.has(year) || failed.has(year)) continue;
      const distance = Math.abs(year - target);
      if (distance < bestDistance) {
        best = year;
        bestDistance = distance;
      }
    }

    return best;
  }

  /**
   * Renders every frame, yielding between each so the app stays responsive.
   *
   * Deliberately sequential: sixty-six concurrent PNG decodes would contend for
   * exactly the main thread this is trying not to block.
   */
  async function buildFrames(): Promise<void> {
    const build = generation;

    // Yield once before rendering anything. `mountOverlays` calls `mount` and
    // then `setTimeWindow` synchronously, so building immediately would render
    // the first frame for whatever `currentYear` held at construction — usually
    // today — rather than for the playhead the caller is about to set.
    await Promise.resolve();

    for (;;) {
      if (build !== generation || !mounted) return;

      const year = nextFrameToBuild();
      if (year === null) return;

      const canvas = renderCanvas(year);
      let provider: Cesium.SingleTileImageryProvider;
      try {
        provider = await Cesium.SingleTileImageryProvider.fromUrl(canvas.toDataURL('image/png'), {
          rectangle: Cesium.Rectangle.MAX_VALUE,
          credit: 'IGRF-14 (IAGA)',
        });
      } catch (error: unknown) {
        console.error('Geomagnetic field frame failed to load', year, error);
        // Recorded as attempted so the loop cannot spin on it forever.
        failed.add(year);
        continue;
      }

      // Re-checked after the await: the layer may have been unmounted, or the
      // quantity switched, while this frame was decoding.
      if (build !== generation || !mounted || !viewer || viewer.isDestroyed()) return;

      const layer = viewer.imageryLayers.addImageryProvider(provider);
      // `show` stays true for the layer's whole life — see the note at the top.
      // Alpha 0 keeps it resident and free, and is what selection moves.
      layer.show = true;
      layer.alpha = 0;
      frames.set(year, layer);

      // Show it if it is the one wanted right now — which on the first frame it
      // always is, since the build starts from the playhead.
      applyFrame();
    }
  }

  /** Drops every frame. Called on unmount and whenever the quantity changes. */
  function clearFrames(): void {
    generation += 1;
    if (viewer && !viewer.isDestroyed()) {
      for (const layer of frames.values()) {
        viewer.imageryLayers.remove(layer, true);
      }
    }
    frames.clear();
    failed.clear();
    shownYear = null;
  }

  return {
    id: GEOMAGNETIC_FIELD_LAYER_ID,
    label: 'Magnetic field (IGRF)',
    category: 'overlay',
    defaultVisible: false,

    mount(v) {
      viewer = v;
      mounted = true;
      // **Mounted means visible.** `useGlobeLayers` toggles overlays by mounting
      // and unmounting and never calls `setVisible` — see `mountOverlays`.
      visible = true;
      generation += 1;
      void buildFrames();
    },

    unmount() {
      mounted = false;
      clearFrames();
      viewer = null;
    },

    setTimeWindow(_start, end) {
      // The window's *end* is the playhead, which is the instant on screen.
      currentYear = decimalYear(end);
      applyFrame();
    },

    setVisible(v) {
      visible = v;
      const shown = shownYear === null ? undefined : frames.get(shownYear);
      if (shown) shown.alpha = v ? DEFAULT_ALPHA : 0;
    },

    setQuantity(next) {
      if (next === quantity) return;
      quantity = next;
      // Every frame describes the old quantity, so they all go. `clearFrames`
      // bumps the generation, which stops any build still in flight.
      clearFrames();
      if (mounted) void buildFrames();
    },

    getQuantity() {
      return quantity;
    },

    frameProgress() {
      return { ready: frames.size, total: years().length };
    },
  };
}
