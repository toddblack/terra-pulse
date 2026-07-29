import * as Cesium from 'cesium';
import type { BackdropTone, GlobeLayer } from '@terra-pulse/schema';
import trenchData from '../data/subduction-trenches.json';
import { kinematicColorHex } from './plate-kinematics';
import {
  TOOTH_PIXEL_HEIGHT,
  TOOTH_PIXEL_WIDTH,
  TRENCH_LINE_WIDTH,
  azimuthUnitVectorEnu,
  toothImageDataUri,
} from './subduction-encoding';

/**
 * Subduction zones from USGS Slab2, drawn with the conventional sawteeth
 * pointing in the direction the slab descends.
 *
 * Provenance, licence (CC0) and the strike-to-dip derivation are in
 * `../data/README.md` and `subduction-encoding.ts`.
 *
 * **Why this is its own layer rather than part of `plate-boundaries`.** Slab2's
 * trench and Bird's convergent boundary are separate datasets measuring
 * related but distinct things. They agree closely in the middle — median 21 km
 * apart — and diverge at the tails (p90 166 km, max 483 km). Merging them
 * would need a rule mapping Slab2 regions onto Bird runs, and a wrong match
 * would silently drop a real boundary. Keeping them apart means the teeth
 * always sit exactly on the line they were derived from, and the two sources
 * stay comparable. The cost, accepted deliberately: with both layers on, a few
 * arcs show a doubled line.
 */
interface TrenchRun {
  /** Slab2 region code, e.g. "sam". */
  s: string;
  /** Plate pair as Slab2 labels it, e.g. "NZ/SA". */
  b: string;
  /** Flat [lon, lat, lon, lat, …]. */
  p: number[];
}

interface Tooth {
  lon: number;
  lat: number;
  /** Dip azimuth, degrees clockwise from north. */
  d: number;
}

/**
 * The world-space direction a tooth's apex should point.
 *
 * Cesium's `alignedAxis` is the world vector a billboard's up points toward,
 * so converting the tooth's compass azimuth into the local east-north-up frame
 * and out to fixed coordinates makes the triangle lie down-dip on the globe
 * and turn with it.
 */
function dipAxis(position: Cesium.Cartesian3, azimuthDegrees: number): Cesium.Cartesian3 {
  const { east, north, up } = azimuthUnitVectorEnu(azimuthDegrees);
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  const axis = Cesium.Matrix4.multiplyByPointAsVector(
    frame,
    new Cesium.Cartesian3(east, north, up),
    new Cesium.Cartesian3(),
  );
  return Cesium.Cartesian3.normalize(axis, axis);
}

export function createSubductionZonesLayer(tone: BackdropTone): GlobeLayer {
  let viewer: Cesium.Viewer | null = null;
  let dataSource: Cesium.CustomDataSource | null = null;
  let mounted = false;

  function buildEntities(target: Cesium.CustomDataSource): void {
    // Subduction is the convergent case, so it reuses the already-validated
    // convergent colour rather than introducing a fourth hue that would need
    // the whole palette re-checked.
    const colorHex = kinematicColorHex('convergent', tone);
    // One material and one image shared across every entity rather than
    // allocating them per feature.
    const material = new Cesium.ColorMaterialProperty(
      Cesium.Color.fromCssColorString(colorHex),
    );
    const toothImage = toothImageDataUri(colorHex);

    for (const [index, run] of (trenchData.t as TrenchRun[]).entries()) {
      target.entities.add({
        id: `trench-${index}`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(run.p),
          material,
          width: TRENCH_LINE_WIDTH,
          // Runs reach thousands of km. Straight chords between vertices would
          // cut through the ellipsoid and disappear at grazing angles.
          arcType: Cesium.ArcType.GEODESIC,
        },
        properties: { slabRegion: run.s, plateBoundary: run.b },
      });
    }

    for (const [index, tooth] of (trenchData.k as Tooth[]).entries()) {
      const position = Cesium.Cartesian3.fromDegrees(tooth.lon, tooth.lat);

      target.entities.add({
        id: `tooth-${index}`,
        position,
        billboard: {
          image: toothImage,
          // Pixel-sized, like the earthquake marks — see the note on
          // TOOTH_PIXEL_WIDTH.
          width: TOOTH_PIXEL_WIDTH,
          height: TOOTH_PIXEL_HEIGHT,
          alignedAxis: dipAxis(position, tooth.d),
        },
        properties: { dipAzimuth: tooth.d },
      });
    }
  }

  return {
    id: 'subduction-zones',
    label: 'Subduction zones',
    category: 'overlay',
    // Off by default: this is detail on top of the boundary picture, and 376
    // teeth on a first load would compete with the earthquakes for attention.
    defaultVisible: false,

    mount(v) {
      viewer = v;
      mounted = true;

      const source = new Cesium.CustomDataSource('subduction-zones');
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
          console.error('Failed to add subduction zones', error);
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
      // Geological. A slab descends centimetres a year; a days-long window
      // means nothing to it.
    },

    setVisible(visible) {
      if (dataSource) dataSource.show = visible;
    },
  };
}
