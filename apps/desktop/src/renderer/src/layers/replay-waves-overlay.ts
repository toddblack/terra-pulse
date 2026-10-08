import * as Cesium from 'cesium';
import { wavefrontKm, type QuakeReplay, type SeismicPhase } from '@terra-pulse/schema';
import { circlePoints, replayFrame } from '../waveforms/replay-playback';

/**
 * The replayed quake on the globe: its epicentre, and the P and S wavefronts
 * spreading out to the stations on the rows (those are drawn by the waveform
 * station overlay). Watching a ring reach a triangle as that station's row
 * starts shaking is the point of it.
 *
 * Not a registry layer, for `waveform-stations-overlay`'s reasons: nobody turns
 * it on, it exists exactly while a replay is on screen.
 *
 * **The rings follow IASP91, not one crustal speed** (`wavefrontKm`). Replays
 * reach stations thousands of kilometres out, where the wave travels mostly
 * through the faster mantle: at 2,000 km a crustal-speed ring would arrive
 * about 50 s after the row it is meant to explain.
 *
 * **Built once, never rebuilt per frame.** The rings are polylines whose
 * positions come from a `CallbackProperty` reading the replay clock — the
 * magnetopause lesson: replacing entities on every tick leaves frames with
 * nothing drawn. Positions are cached by radius, so a paused replay computes
 * nothing. Polylines rather than ellipse outlines because an outline is 1 px
 * on most GPUs, which is invisible at whole-globe zoom.
 */

/** P: the first, quick arrival. Amber, the replay's colour for "heard". */
const P_COLOR = '#fcd34d';
/** S: the strong shaking. */
const S_COLOR = '#f87171';

export interface ReplayWavesOverlay {
  destroy(): void;
}

function ringPositions(replay: QuakeReplay, phase: SeismicPhase, positionMs: () => number): Cesium.CallbackProperty {
  let cachedKm = -1;
  let cached: Cesium.Cartesian3[] = [];
  return new Cesium.CallbackProperty(() => {
    const radius = wavefrontKm(phase, (positionMs() - replay.request.originMs) / 1000);
    if (radius === null) return [];
    // A kilometre is far below a pixel at any zoom a replay is read at.
    const rounded = Math.round(radius);
    if (rounded !== cachedKm) {
      cachedKm = rounded;
      // More points for a wide ring, so it stays round at thousands of km.
      const steps = Math.min(240, Math.max(72, Math.round(rounded / 20)));
      cached = circlePoints(replay.request, rounded, steps).map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
    }
    return cached;
  }, false);
}

export function createReplayWavesOverlay(
  viewer: Cesium.Viewer,
  replay: QuakeReplay,
  positionMs: () => number,
): ReplayWavesOverlay {
  const source = new Cesium.CustomDataSource('replay-waves');
  let attached = false;
  let destroyed = false;
  const casing = Cesium.Color.fromCssColorString('#0b0b0b');

  source.entities.add({
    position: Cesium.Cartesian3.fromDegrees(replay.request.longitude, replay.request.latitude),
    point: {
      pixelSize: 11,
      color: Cesium.Color.fromCssColorString(S_COLOR),
      outlineColor: casing,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: `M${replay.request.magnitude.toFixed(1)}`,
      font: '600 12px system-ui, sans-serif',
      fillColor: Cesium.Color.fromCssColorString(S_COLOR),
      outlineColor: casing,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -10),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });

  for (const [phase, color] of [
    ['P', P_COLOR],
    ['S', S_COLOR],
  ] as const) {
    source.entities.add({
      polyline: {
        positions: ringPositions(replay, phase, positionMs),
        width: 2.5,
        material: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
        arcType: Cesium.ArcType.GEODESIC,
        clampToGround: false,
      },
    });
  }

  // Framed on the replay, because at whole-globe zoom a nearby quake's rings
  // are a few pixels under the selection reticle. The same move the
  // magnetopause layer makes, and likewise not undone on close: flying back
  // would fight a reader who has since moved on. See `replayFrame`.
  const frame = replayFrame(replay.request, replay.rows);
  viewer.camera.flyTo({
    destination: Cesium.Rectangle.fromDegrees(frame.west, frame.south, frame.east, frame.north),
    duration: 1.5,
  });

  // `add()` is async; destroyed before it resolves, the source would be
  // attached with nothing left to detach it. Same guard as the other overlays.
  void viewer.dataSources.add(source).then(
    () => {
      if (destroyed) {
        if (!viewer.isDestroyed()) viewer.dataSources.remove(source, true);
        return;
      }
      attached = true;
    },
    (error: unknown) => {
      console.error('Failed to add the replay overlay', error);
    },
  );

  return {
    destroy() {
      destroyed = true;
      // Non-negotiable #5.
      if (!viewer.isDestroyed() && attached) viewer.dataSources.remove(source, true);
    },
  };
}
