import * as Cesium from 'cesium';
import type { GlobeLayer } from '@terra-pulse/schema';
import {
  dynamicPressureNPa,
  EARTH_RADIUS_KM,
  GEOSYNCHRONOUS_RE,
  magnetopauseProfile,
  magnetopauseStandoff,
  subsolarPoint,
  type MagnetopauseShape,
} from './magnetopause';

/*
 * The legend does not read the shape back off this layer — it recomputes it
 * from the same pure functions on the same inputs, so the two cannot disagree
 * and there is no second channel to keep in sync. That is why nothing here
 * exposes the current shape.
 */

/**
 * The magnetopause — the outer boundary of the magnetosphere, from Shue et al.
 * (1998) evaluated on the measured solar wind.
 *
 * ## This is the only layer on the globe that draws model output
 *
 * Everything else is a measurement or a mapped feature: an epicentre, a fault
 * trace, an observed field. This is an empirical fit, evaluated on observed
 * inputs. It is drawn as a **thin open wireframe** rather than a solid shaded
 * surface for exactly that reason — a filled skin would read as an object that
 * is there, and this is a calculated boundary that moves continuously and has
 * no sharp edge in reality either. The legend says so in words; the drawing
 * says so in weight.
 *
 * ## Why enabling it moves the camera
 *
 * The boundary sits around 10 Earth radii — roughly **67,000 km** from the
 * centre against a globe of radius 6,371. At any normal viewing distance it is
 * entirely off screen, so a layer that drew it and left the camera alone would
 * appear to do nothing at all. Toggling it is an explicit act, so it answers
 * with an explicit view change.
 *
 * The camera is **not** restored on unmount. Flying back would fight a reader
 * who turned the layer off precisely because they had already navigated
 * somewhere else.
 *
 * ## Why geosynchronous orbit is drawn beside it
 *
 * "The magnetopause is at 6.3 Re" is a number. "The magnetopause has moved
 * inside geosynchronous orbit, so those satellites are now outside the
 * magnetosphere and sitting in raw solar wind" is an event — and it is what
 * severe storms actually do. Measured on this app's own record: 298 hours of
 * 396,183, about 0.075%. The reference is what makes the boundary legible.
 */
export const MAGNETOPAUSE_LAYER_ID = 'magnetopause';

/** The solar wind this layer needs. Nulls are ordinary — see the coverage notes. */
export interface SolarWindConditions {
  windSpeed: number | null;
  density: number | null;
  bzGsm: number | null;
}

export interface MagnetopauseLayer extends GlobeLayer {
  /** Pushes the conditions at the playhead. Null when nothing was measured. */
  setSolarWind(conditions: SolarWindConditions | null): void;
}

export function isMagnetopauseLayer(layer: GlobeLayer): layer is MagnetopauseLayer {
  return layer.id === MAGNETOPAUSE_LAYER_ID && 'setSolarWind' in layer;
}

/** Metres per Earth radius. */
const RE_METRES = EARTH_RADIUS_KM * 1000;

/** Meridional profiles around the Earth-Sun axis, and rings across them. */
const PROFILE_COUNT = 16;
const RING_THETAS_DEG = [30, 60, 90, 115];
const PROFILE_MAX_THETA_DEG = 120;
const PROFILE_STEPS = 48;

/** Where the camera goes: far enough that the whole dayside boundary fits. */
const VIEW_DISTANCE_RE = 26;

export function createMagnetopauseLayer(): MagnetopauseLayer {
  let viewer: Cesium.Viewer | null = null;
  let source: Cesium.CustomDataSource | null = null;
  let mounted = false;
  let conditions: SolarWindConditions | null = null;
  let instant = new Date();
  let shape: MagnetopauseShape | null = null;

  /**
   * Two unit vectors spanning the plane perpendicular to the Sun direction.
   *
   * Any pair will do — the boundary is a surface of revolution about the
   * Earth-Sun line, so the choice only sets where profile 0 lands. Earth's spin
   * axis is used as the seed, falling back to the x-axis in the degenerate case
   * where the Sun is directly over a pole, which the obliquity makes impossible
   * but which a caller passing a synthetic date could reach.
   */
  function basis(sunward: Cesium.Cartesian3): [Cesium.Cartesian3, Cesium.Cartesian3] {
    const seed =
      Math.abs(sunward.z) > 0.99 ? Cesium.Cartesian3.UNIT_X : Cesium.Cartesian3.UNIT_Z;
    const a = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.cross(sunward, seed, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
    const b = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.cross(sunward, a, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
    return [a, b];
  }

  function pointAt(
    sunward: Cesium.Cartesian3,
    a: Cesium.Cartesian3,
    b: Cesium.Cartesian3,
    thetaRad: number,
    phiRad: number,
    radiusRe: number,
  ): Cesium.Cartesian3 {
    const along = Math.cos(thetaRad);
    const across = Math.sin(thetaRad);
    const direction = new Cesium.Cartesian3(
      sunward.x * along + (a.x * Math.cos(phiRad) + b.x * Math.sin(phiRad)) * across,
      sunward.y * along + (a.y * Math.cos(phiRad) + b.y * Math.sin(phiRad)) * across,
      sunward.z * along + (a.z * Math.cos(phiRad) + b.z * Math.sin(phiRad)) * across,
    );
    return Cesium.Cartesian3.multiplyByScalar(
      direction,
      radiusRe * RE_METRES,
      new Cesium.Cartesian3(),
    );
  }

  /**
   * Positions, recomputed only when the inputs change — never per frame, and
   * never by replacing entities.
   *
   * ## Why the entities are built once and never removed
   *
   * The first version called `entities.removeAll()` and re-added all 21
   * polylines whenever the hour changed. Under playback that is several times a
   * second, and each pass leaves a frame with nothing drawn — the layer
   * flashed, exactly as the geomagnetic field raster did before it was rebuilt
   * around pre-rendered frames.
   *
   * It is the same lesson in a different medium, and the project already has a
   * name for it: **built set stable, visibility live.** The entity equivalent of
   * flipping an alpha is a `CallbackProperty` — the geometry stays, and only
   * what it reads changes. `antipode-layer.ts` uses the same mechanism for the
   * chord.
   *
   * The arrays are cached rather than computed inside the callback because the
   * callback runs **every frame**: 21 polylines of ~49 points would be about
   * 60,000 `Cartesian3` allocations a second to redraw geometry that had not
   * moved.
   */
  let profilePositions: Cesium.Cartesian3[][] = [];
  let ringPositions: Cesium.Cartesian3[][] = [];
  let boundaryColour = Cesium.Color.fromCssColorString('#67e8f9').withAlpha(0.6);

  function recompute(): void {
    shape = null;
    profilePositions = [];
    ringPositions = [];

    if (
      conditions?.windSpeed == null ||
      conditions.density == null ||
      conditions.bzGsm == null
    ) {
      // Nothing measured. The callbacks return empty position lists, so the
      // polylines stay in the scene graph and simply draw nothing — the same
      // rule the track's absence marks follow. A guessed surface here would be
      // indistinguishable from a computed one.
      return;
    }

    const pressure = dynamicPressureNPa(conditions.density, conditions.windSpeed);
    shape = magnetopauseStandoff(conditions.bzGsm, pressure);

    // Brighter when the boundary has been driven inside geosynchronous orbit —
    // the one state worth noticing at a glance.
    boundaryColour = shape.insideGeosynchronous
      ? Cesium.Color.fromCssColorString('#f87171').withAlpha(0.85)
      : Cesium.Color.fromCssColorString('#67e8f9').withAlpha(0.6);

    const sun = subsolarPoint(instant);
    const sunward = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.fromDegrees(sun.longitudeDeg, sun.latitudeDeg),
      new Cesium.Cartesian3(),
    );
    const [a, b] = basis(sunward);

    const profile = magnetopauseProfile(shape, PROFILE_MAX_THETA_DEG, PROFILE_STEPS);

    for (let p = 0; p < PROFILE_COUNT; p += 1) {
      const phi = (2 * Math.PI * p) / PROFILE_COUNT;
      profilePositions.push(
        profile.map((point) => pointAt(sunward, a, b, point.thetaRad, phi, point.radiusRe)),
      );
    }

    for (const thetaDeg of RING_THETAS_DEG) {
      const thetaRad = (thetaDeg * Math.PI) / 180;
      const radiusRe = profile.reduce((best, point) =>
        Math.abs(point.thetaRad - thetaRad) < Math.abs(best.thetaRad - thetaRad) ? point : best,
      ).radiusRe;

      const ring: Cesium.Cartesian3[] = [];
      for (let i = 0; i <= 64; i += 1) {
        ring.push(pointAt(sunward, a, b, thetaRad, (2 * Math.PI * i) / 64, radiusRe));
      }
      ringPositions.push(ring);
    }
  }

  /** Created once on mount. Nothing here is added or removed afterwards. */
  function buildEntities(target: Cesium.CustomDataSource): void {
    const geosync: Cesium.Cartesian3[] = [];
    for (let i = 0; i <= 128; i += 1) {
      const angle = (2 * Math.PI * i) / 128;
      geosync.push(
        new Cesium.Cartesian3(
          Math.cos(angle) * GEOSYNCHRONOUS_RE * RE_METRES,
          Math.sin(angle) * GEOSYNCHRONOUS_RE * RE_METRES,
          0,
        ),
      );
    }
    // Fixed geometry and always drawn, even when the boundary cannot be: having
    // the reference on screen while the boundary is missing is what shows the
    // reader that the *boundary* is the unavailable part.
    target.entities.add({
      polyline: {
        positions: geosync,
        width: 1,
        arcType: Cesium.ArcType.NONE,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString('#94a3b8').withAlpha(0.55),
          dashLength: 12,
        }),
      },
    });

    const colour = new Cesium.ColorMaterialProperty(
      new Cesium.CallbackProperty(() => boundaryColour, false),
    );

    for (let p = 0; p < PROFILE_COUNT; p += 1) {
      const index = p;
      target.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(() => profilePositions[index] ?? [], false),
          width: 1,
          arcType: Cesium.ArcType.NONE,
          material: colour,
        },
      });
    }

    for (let r = 0; r < RING_THETAS_DEG.length; r += 1) {
      const index = r;
      target.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(() => ringPositions[index] ?? [], false),
          width: 1,
          arcType: Cesium.ArcType.NONE,
          material: colour,
        },
      });
    }
  }

  return {
    id: MAGNETOPAUSE_LAYER_ID,
    label: 'Magnetopause',
    category: 'analysis',
    defaultVisible: false,

    mount(nextViewer) {
      viewer = nextViewer;
      source = new Cesium.CustomDataSource(MAGNETOPAUSE_LAYER_ID);
      void viewer.dataSources.add(source);
      mounted = true;
      buildEntities(source);
      recompute();

      // See the note at the top: at normal zoom this layer is off screen, so a
      // toggle that did not move the camera would look like a toggle that did
      // nothing.
      const sun = subsolarPoint(instant);
      viewer.camera.flyTo({
        // Ninety degrees from the subsolar meridian, so the teardrop is seen in
        // profile rather than end-on down the Earth-Sun line.
        destination: Cesium.Cartesian3.fromDegrees(
          sun.longitudeDeg + 90,
          0,
          VIEW_DISTANCE_RE * RE_METRES,
        ),
        duration: 2,
      });
    },

    unmount() {
      if (viewer && !viewer.isDestroyed() && source) viewer.dataSources.remove(source, true);
      source = null;
      viewer = null;
      mounted = false;
      shape = null;
    },

    setTimeWindow(_start, end) {
      // The boundary is an instantaneous state, so it follows the playhead's
      // leading edge rather than the span. Rebuilt only when the hour changes:
      // the Sun moves 15 degrees an hour and the wind is stored hourly, so
      // anything finer would redraw identical geometry.
      const next = new Date(Math.floor(end.getTime() / 3_600_000) * 3_600_000);
      if (next.getTime() === instant.getTime()) return;
      instant = next;
      if (mounted) recompute();
    },

    setVisible(next) {
      if (source) source.show = next;
    },

    setSolarWind(next) {
      conditions = next;
      if (mounted) recompute();
    },
  };
}
