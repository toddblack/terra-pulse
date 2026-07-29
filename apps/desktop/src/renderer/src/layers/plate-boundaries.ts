import * as Cesium from 'cesium';
import type { BackdropTone, GlobeLayer } from '@terra-pulse/schema';
import boundaryData from '../data/plate-boundaries.json';
import {
  KINEMATIC_CASING_WIDTH,
  isKinematicGroup,
  kinematicCasingColorHex,
  kinematicColorHex,
  kinematicLineWidth,
  kinematicTotalLineWidth,
  type KinematicGroup,
} from './plate-kinematics';

/**
 * Plate boundaries from Bird (2003) PB2002, coloured by kinematic behaviour.
 * Provenance and licence in `../data/README.md` (ODC-BY — attribution is a
 * condition and appears in the legend).
 *
 * The vendored form is merged polylines rather than raw steps: 5,824 upstream
 * segments collapse to 1,683 runs sharing a boundary and class. Classification
 * varies correctly *along* a boundary, which the simpler boundaries file
 * couldn't express.
 */
interface BoundaryRun {
  /** Plate pair, e.g. "AF-AN". */
  b: string;
  /** Bird's step class — SUB, OSR, OTF… retained for reference. */
  c: string;
  /** Kinematic group. */
  g: string;
  /** Flat [lon, lat, lon, lat, …]. */
  p: number[];
}

export function createPlateBoundariesLayer(tone: BackdropTone): GlobeLayer {
  let viewer: Cesium.Viewer | null = null;
  let dataSource: Cesium.CustomDataSource | null = null;
  let mounted = false;

  function buildEntities(target: Cesium.CustomDataSource): void {
    // One material per group rather than per polyline — 1,683 runs sharing
    // three materials instead of allocating 1,683 of them.
    //
    // (Safe to share here, unlike in `active-faults.ts`: these are entity
    // MaterialPropertys owned by the entity layer, not the `Polyline` objects
    // of a PolylineCollection, which destroy their own material on teardown.)
    // Casing only where it's been measured to help — over imagery, whose
    // backdrop varies. Null over the flat OSM surface. See plate-kinematics.ts.
    const casingHex = kinematicCasingColorHex(tone);
    const materials = new Map<KinematicGroup, Cesium.MaterialProperty>();
    for (const group of ['convergent', 'divergent', 'transform'] as const) {
      const color = Cesium.Color.fromCssColorString(kinematicColorHex(group, tone));
      materials.set(
        group,
        casingHex === null
          ? new Cesium.ColorMaterialProperty(color)
          : new Cesium.PolylineOutlineMaterialProperty({
              color,
              outlineColor: Cesium.Color.fromCssColorString(casingHex),
              outlineWidth: KINEMATIC_CASING_WIDTH,
            }),
      );
    }

    for (const [index, run] of (boundaryData as BoundaryRun[]).entries()) {
      if (!isKinematicGroup(run.g)) continue;

      target.entities.add({
        id: `boundary-${index}`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(run.p),
          material: materials.get(run.g),
          // With a casing the total is core + casing, so the coloured core
          // keeps the weight it had rather than getting thinner. Without one,
          // the core width *is* the whole line.
          width:
            casingHex === null ? kinematicLineWidth(run.g) : kinematicTotalLineWidth(run.g),
          // Runs span hundreds of km. Straight chords between vertices would
          // cut through the ellipsoid and vanish below the surface at grazing
          // angles; geodesic arcs follow the curve.
          arcType: Cesium.ArcType.GEODESIC,
        },
        properties: { plateBoundary: run.b, stepClass: run.c, kinematics: run.g },
      });
    }
  }

  return {
    id: 'plate-boundaries',
    label: 'Plate boundaries',
    category: 'overlay',
    defaultVisible: true,

    mount(v) {
      viewer = v;
      mounted = true;

      const source = new Cesium.CustomDataSource('plate-boundaries');
      buildEntities(source);
      dataSource = source;

      void v.dataSources.add(source).then(
        () => {
          // Toggled off while the add was in flight — detach, or it stays
          // attached with nothing holding a reference to remove it.
          if (!mounted && !v.isDestroyed()) {
            v.dataSources.remove(source, true);
          }
        },
        (error: unknown) => {
          console.error('Failed to add plate boundaries', error);
        },
      );
    },

    unmount() {
      mounted = false;
      if (viewer && !viewer.isDestroyed() && dataSource) {
        viewer.dataSources.remove(dataSource, true);
      }
      viewer = null;
      dataSource = null;
    },

    setTimeWindow() {
      // Geological, not time-driven — a 4-day window means nothing to a
      // feature moving centimetres per year.
    },

    setVisible(visible) {
      if (dataSource) dataSource.show = visible;
    },
  };
}
