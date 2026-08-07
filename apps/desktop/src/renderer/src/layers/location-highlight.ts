import * as Cesium from 'cesium';
import type { LocationSelection } from '../state/useGlobeStore';

/**
 * Marks the spot whose details are open in the location panel.
 *
 * Deliberately the **same shape as Cesium's selection indicator** — four corner
 * brackets — in a different colour. That reticle is the app's established "this
 * is selected" signal, and a selection that looks like a selection needs no
 * explaining; only the *kind* differs, so only the colour should.
 *
 * It cannot literally reuse Cesium's indicator: that one is driven by
 * `viewer.selectedEntity`, which already carries the earthquake selection, and
 * a fault is a `Polyline` in a batched collection rather than an entity, so
 * there is nothing to assign. Drawing the same shape ourselves also lets a
 * selected quake and a selected fault be marked at the same time, which sharing
 * `selectedEntity` would not.
 *
 * Two earlier attempts are recorded so they don't come back: a glow along the
 * feature's whole trace (reads as restyling the line, and a long boundary lights
 * up half the globe) and a plain cased ring (fine, but not the established
 * selection language).
 */
const FAULT_COLOR = '#f0b25a';
const BOUNDARY_COLOR = '#c4b5fd';
const POINT_COLOR = '#f1f5f9';

/** Screen pixels, so the reticle holds its size at every zoom. */
const RETICLE_PX = 48;

function reticleColor(kind: LocationSelection['kind']): string {
  if (kind === 'fault') return FAULT_COLOR;
  if (kind === 'boundary') return BOUNDARY_COLOR;
  return POINT_COLOR;
}

/**
 * Draws the bracket reticle to a canvas, for use as a billboard image.
 *
 * Rendered at 2× and displayed at 1× so it stays crisp on a high-DPI display —
 * a billboard is sampled from this bitmap, so drawing at final size would look
 * soft exactly where the eye is drawn.
 *
 * The dark under-stroke is the same casing idea the boundary lines use: the
 * backdrop is arbitrary photography, and a single-colour outline gets lost over
 * busy terrain.
 */
function reticleImage(color: string): HTMLCanvasElement {
  const scale = 2;
  const size = RETICLE_PX * scale;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext('2d');
  if (context === null) return canvas;

  // Bracket geometry: each corner is two strokes meeting at a right angle,
  // leaving the middle of every side open — which is what distinguishes a
  // reticle from a plain box, and keeps the marked thing visible inside it.
  const inset = 3 * scale;
  const arm = size * 0.28;
  const near = inset;
  const far = size - inset;

  const corners: [number, number, number, number][] = [
    // [x, y, dx, dy] for each of the four corners, drawn as two arms.
    [near, near, 1, 1],
    [far, near, -1, 1],
    [near, far, 1, -1],
    [far, far, -1, -1],
  ];

  const stroke = (width: number, strokeStyle: string) => {
    context.lineWidth = width * scale;
    context.strokeStyle = strokeStyle;
    context.lineCap = 'square';
    context.beginPath();
    for (const [x, y, dx, dy] of corners) {
      context.moveTo(x + dx * arm, y);
      context.lineTo(x, y);
      context.lineTo(x, y + dy * arm);
    }
    context.stroke();
  };

  // Casing first, colour over it.
  stroke(4.5, 'rgba(11, 11, 11, 0.85)');
  stroke(2.5, color);

  return canvas;
}

export interface LocationHighlight {
  update(selection: LocationSelection | null): void;
  destroy(): void;
}

export function createLocationHighlight(viewer: Cesium.Viewer): LocationHighlight {
  const source = new Cesium.CustomDataSource('location-highlight');
  let attached = false;
  let destroyed = false;

  // `add()` is async; destroyed before it resolves, the data source would be
  // attached with nothing left holding a reference to detach it — the same leak
  // `earthquake-layer.ts` guards against.
  void viewer.dataSources.add(source).then(
    () => {
      if (destroyed) {
        if (!viewer.isDestroyed()) viewer.dataSources.remove(source, true);
        return;
      }
      attached = true;
    },
    (error: unknown) => {
      console.error('Failed to add the location highlight', error);
    },
  );

  return {
    update(selection) {
      if (destroyed) return;
      source.entities.removeAll();
      if (selection === null) return;

      source.entities.add({
        position: Cesium.Cartesian3.fromDegrees(selection.longitude, selection.latitude),
        billboard: {
          image: reticleImage(reticleColor(selection.kind)),
          width: RETICLE_PX,
          height: RETICLE_PX,
          // Never buried by terrain or by the line being marked; without this
          // the reticle sinks behind a fault trace at grazing camera angles.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    },

    destroy() {
      destroyed = true;
      // Non-negotiable #5. Guarded on the viewer because effect-cleanup order
      // relative to the viewer's own teardown is not something to rely on.
      if (!viewer.isDestroyed() && attached) {
        viewer.dataSources.remove(source, true);
      }
    },
  };
}
