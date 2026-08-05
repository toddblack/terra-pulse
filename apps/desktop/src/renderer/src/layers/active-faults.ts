import * as Cesium from 'cesium';
import type { BackdropTone, GlobeLayer } from '@terra-pulse/schema';
import { ACTIVE_FAULTS } from './fault-data';
import {
  FAULT_LINE_WIDTH,
  faultColorHex,
  faultMaxDistanceMeters,
} from './fault-encoding';

/**
 * Active faults from the GEM Global Active Faults Database.
 *
 * **Licence: CC-BY-SA 4.0.** Attribution is a condition and appears in the
 * legend. Share-alike binds the *derived dataset* in `../data/`, not this
 * source file — software that reads a dataset isn't an adaptation of it. Full
 * reasoning, including the one unsettled point about rendered imagery, is in
 * `scripts/vendor-gem-faults.mjs` and `../data/README.md`.
 *
 * **Why `PolylineCollection` rather than entities.** 13,696 faults is roughly
 * eight times the plate-boundaries layer. The Entity API allocates a primitive
 * per entity; `PolylineCollection` batches them into shared vertex buffers,
 * which is what makes this many lines viable at all. The trade is that this
 * layer manages a scene primitive directly instead of a `CustomDataSource`.
 *
 * The cost of that trade, handled in the vendor script rather than here:
 * `PolylineCollection` has no `ArcType.GEODESIC`, so geometry is pre-densified
 * upstream to a 50 km maximum chord.
 *
 * **This layer reads only `z` and `p`.** The record shape is declared in
 * `fault-association.ts` and applied once in `fault-data.ts`; the name and
 * slip-rate columns exist for the nearest-fault panel. Nothing here should start
 * depending on them without re-measuring the build cost of 13,696 polylines.
 */
export function createActiveFaultsLayer(tone: BackdropTone): GlobeLayer {
  let viewer: Cesium.Viewer | null = null;
  let collection: Cesium.PolylineCollection | null = null;

  function buildCollection(): Cesium.PolylineCollection {
    const built = new Cesium.PolylineCollection();
    const color = Cesium.Color.fromCssColorString(faultColorHex(tone));

    for (const fault of ACTIVE_FAULTS) {
      built.add({
        positions: Cesium.Cartesian3.fromDegreesArray(fault.p),
        width: FAULT_LINE_WIDTH,
        // A material PER POLYLINE, never one shared across them.
        //
        // `Polyline._destroy` calls `this._material.destroy()`, and the only
        // guard around it checks whether the *polyline* is destroyed, not the
        // material. A shared instance therefore gets destroyed once per
        // polyline; every call after the first throws DeveloperError and takes
        // the whole render loop down with it. Sharing one looks like the
        // obvious optimisation and is actively unsafe.
        //
        // It also isn't the optimisation it appears to be. PolylineCollection
        // batches via `createMaterialId`, which keys on material *type plus
        // uniform values* rather than instance identity — so 13,696 separate
        // Color materials of the same colour land in a single bucket anyway.
        // Allocating them measures ~124 ms, paid only when this layer is
        // toggled on.
        material: Cesium.Material.fromType('Color', { color }),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
          0,
          faultMaxDistanceMeters(fault.z),
        ),
      });
    }

    return built;
  }

  return {
    id: 'active-faults',
    label: 'Active faults',
    category: 'overlay',
    // Off by default. This is the densest layer in the app and would bury the
    // earthquakes on a first load.
    defaultVisible: false,

    mount(v) {
      viewer = v;
      const built = buildCollection();
      collection = built;
      // Primitives are added synchronously, so unlike the data-source layers
      // there's no in-flight window to guard against.
      v.scene.primitives.add(built);
    },

    unmount() {
      if (viewer && !viewer.isDestroyed() && collection) {
        // remove() destroys the primitive, releasing its vertex buffers.
        viewer.scene.primitives.remove(collection);
      }
      viewer = null;
      collection = null;
    },

    setTimeWindow() {
      // Geological. "Active" here means Quaternary — a days-long window is
      // meaningless against a fault that last moved 10,000 years ago.
    },

    setVisible(visible) {
      if (collection) collection.show = visible;
    },
  };
}
