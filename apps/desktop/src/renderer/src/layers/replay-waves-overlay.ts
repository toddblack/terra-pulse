import * as Cesium from 'cesium';
import type { QuakeReplay } from '@terra-pulse/schema';
import { circlePoints, wavefrontRadiusKm } from '../waveforms/replay-playback';

/**
 * The replayed quake on the globe: its epicentre, home, and — for a local
 * quake — the P and S wavefronts spreading out at the speeds the detector
 * assumes. The gap between the alert and the S ring reaching home *is* the
 * warning time; this is the picture of it.
 *
 * Not a registry layer, for `waveform-stations-overlay`'s reasons: nobody turns
 * it on, it exists exactly while a replay is on screen.
 *
 * **Built once, never rebuilt per frame.** The rings are polylines whose
 * positions come from a `CallbackProperty` reading the replay clock — the
 * magnetopause lesson: replacing entities on every tick leaves frames with
 * nothing drawn. Positions are cached by radius, so a paused replay computes
 * nothing. Polylines rather than ellipse outlines because an outline is 1 px
 * on most GPUs, which is invisible at whole-globe zoom.
 *
 * **No rings for a distant quake.** Crustal speeds across the mantle would
 * draw nonsense thousands of kilometres wide; the guide says so.
 */

/** P: the first, quick arrival. Amber, the replay's colour for "heard". */
const P_COLOR = '#fcd34d';
/** S: the strong shaking. The alert banner's red. */
const S_COLOR = '#f87171';
const HOME_COLOR = '#f8fafc';
/** Past this the rings have left everything the replay is about. */
const MAX_RING_KM = 600;

export interface ReplayWavesOverlay {
  destroy(): void;
}

function ringPositions(
  replay: QuakeReplay,
  velocityKmS: number,
  positionMs: () => number,
): Cesium.CallbackProperty {
  let cachedKm = -1;
  let cached: Cesium.Cartesian3[] = [];
  return new Cesium.CallbackProperty(() => {
    const radius = wavefrontRadiusKm(positionMs() - replay.request.originMs, velocityKmS, replay.geometry.depthKm);
    if (radius === null || radius > MAX_RING_KM) return [];
    // Half a kilometre is far below a pixel at any zoom the replay is read at.
    const rounded = Math.round(radius * 2) / 2;
    if (rounded !== cachedKm) {
      cachedKm = rounded;
      cached = circlePoints(replay.request, rounded).map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
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

  source.entities.add({
    position: Cesium.Cartesian3.fromDegrees(replay.home.longitude, replay.home.latitude),
    point: {
      pixelSize: 9,
      color: Cesium.Color.fromCssColorString(HOME_COLOR),
      outlineColor: casing,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: replay.home.label,
      font: '600 11px system-ui, sans-serif',
      fillColor: Cesium.Color.fromCssColorString(HOME_COLOR),
      outlineColor: casing,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -9),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });

  if (replay.kind === 'local') {
    for (const [velocity, color] of [
      [replay.geometry.pVelocityKmS, P_COLOR],
      [replay.geometry.sVelocityKmS, S_COLOR],
    ] as const) {
      source.entities.add({
        polyline: {
          positions: ringPositions(replay, velocity, positionMs),
          width: 2.5,
          material: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
          arcType: Cesium.ArcType.GEODESIC,
          clampToGround: false,
        },
      });
    }
  }

  // Framed on the replay, because at whole-globe zoom the rings are a few
  // pixels under the selection reticle — measured: ~140 km wide 23 s in, on a
  // planet 12,700 km across. The same move the magnetopause layer makes, and
  // likewise not undone on close: flying back would fight a reader who has
  // since moved on. A distant quake frames home, where its rows are.
  //
  // **Framed for the chrome, not the viewport.** A replay has the dock open
  // across the bottom and usually the inspector left of centre; a frame that
  // fits the subject to the whole window put Burbank behind the inspector, the
  // one place it most needs to be seen as the S ring reaches it. So the frame
  // is extended west and south — empty map under those panels — which leaves
  // the subject in the clear upper-right of the globe.
  const focus = replay.kind === 'local' ? [replay.request, replay.home] : [replay.home];
  const lats = focus.map((p) => p.latitude);
  const lons = focus.map((p) => p.longitude);
  const pad = replay.kind === 'local' ? 1.5 : 3;
  const west = Math.min(...lons) - pad;
  const east = Math.max(...lons) + pad;
  const south = Math.min(...lats) - pad;
  const north = Math.max(...lats) + pad;
  viewer.camera.flyTo({
    destination: Cesium.Rectangle.fromDegrees(
      west - (east - west) * 0.9,
      south - (north - south) * 0.8,
      east,
      north,
    ),
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
