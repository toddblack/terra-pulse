import * as Cesium from 'cesium';
import type { BackdropTone, GlobeLayer } from '@terra-pulse/schema';
import type { FaultRecord } from './fault-association';
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
 * ## One static Primitive per zoom tier, not a PolylineCollection
 *
 * This layer was one `PolylineCollection`, and with it on, dragging the globe
 * ran at **6-7 fps at every zoom** (21-45 fps with it off). The collection does
 * per-polyline work every frame for all 13,696 lines, visible or not: the zoom
 * tiers were per-polyline `distanceDisplayCondition`s, so the 12,417 lines
 * hidden at globe zoom still cost. Found first on the phone, where it was 5 fps
 * (`../terra-pulse-mobile/notes/faults-perf.md`).
 *
 * Now each tier is one static `Primitive`: its geometry is built once, in
 * Cesium's workers, into a single batch drawn in one call, with no per-line
 * work on later frames. Two things keep the tiers' behaviour:
 *
 * - Inside a tier, each instance keeps its cutoff as a
 *   `distanceDisplayCondition` *instance attribute*, evaluated on the GPU. Both
 *   renderers measure it the same way (squared distance to the bounding
 *   sphere's centre, minus its radius squared), so a line appears at exactly
 *   the zoom it used to.
 * - The whole tier's `show` turns off while the camera is higher than its
 *   cutoff. That measure can let a line draw a little *past* its cutoff, by
 *   about r²/2h for a line of bounding radius r: under 0.2 km at these cutoffs
 *   and lengths, so nothing visible is lost, and a hidden tier costs nothing.
 *
 * ## Lines are 1 px
 *
 * `SimplePolylineGeometry` draws GL lines, which are one pixel wide. That is
 * `FAULT_LINE_WIDTH` today, and the factory throws if it changes; a wider line
 * would need `PolylineGeometry` with `PolylineColorAppearance`. Geometry is
 * still pre-densified upstream to a 50 km maximum chord, and drawn with
 * `ArcType.NONE` so the chords are exactly the vendored ones.
 *
 * **This layer reads only `z` and `p`.** The record shape is declared in
 * `fault-association.ts` and applied once in `fault-data.ts`; the name and
 * slip-rate columns exist for the nearest-fault panel. Each instance carries its
 * record as `id`, which is the only way a pick can say *which* fault.
 */
export function createActiveFaultsLayer(tone: BackdropTone): GlobeLayer {
  let viewer: Cesium.Viewer | null = null;
  let tiers: { maxDistanceM: number; primitive: Cesium.Primitive }[] = [];
  let removePreRender: Cesium.Event.RemoveCallback | null = null;
  let visible = true;

  if (FAULT_LINE_WIDTH !== 1) {
    // SimplePolylineGeometry cannot draw anything else; fail loudly rather
    // than silently ignoring a width change in fault-encoding.ts.
    throw new Error('active-faults: SimplePolylineGeometry only draws 1 px lines');
  }

  function applyShow(): void {
    if (!viewer || viewer.isDestroyed()) return;
    const height = viewer.camera.positionCartographic.height;
    for (const tier of tiers) {
      tier.primitive.show = visible && height <= tier.maxDistanceM;
    }
  }

  function buildTier(faults: readonly FaultRecord[], maxDistanceM: number): Cesium.Primitive {
    const color = Cesium.ColorGeometryInstanceAttribute.fromColor(
      Cesium.Color.fromCssColorString(faultColorHex(tone)),
    );
    // "Always drawn" needs no cutoff, and Number.MAX_VALUE would overflow the
    // attribute's float32 anyway. Every instance in one Primitive must carry the
    // same attributes, which holds because a Primitive is one tier.
    const bounded = Number.isFinite(maxDistanceM) && maxDistanceM < Number.MAX_VALUE;
    const cutoff = bounded
      ? new Cesium.DistanceDisplayConditionGeometryInstanceAttribute(0, maxDistanceM)
      : undefined;

    const instances = faults.map(
      (fault) =>
        new Cesium.GeometryInstance({
          // Carried so `scene.pick()` can say which fault is under the pointer:
          // a pick returns this id. A reference to the record, not a copy.
          id: fault,
          geometry: new Cesium.SimplePolylineGeometry({
            positions: Cesium.Cartesian3.fromDegreesArray(fault.p),
            arcType: Cesium.ArcType.NONE,
          }),
          attributes: cutoff ? { color, distanceDisplayCondition: cutoff } : { color },
        }),
    );

    return new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: false }),
      // Built in Cesium's workers, so switching the layer on doesn't freeze the
      // UI; the lines appear a moment later. The plate-boundary entities already
      // build this way, so workers are known to work in the packaged app.
      asynchronous: true,
      // The instances are only needed to build the batch. Picking keeps working:
      // the pick ids are made from the instance ids before they are released.
      releaseGeometryInstances: true,
    });
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
      const byTier = new Map<number, FaultRecord[]>();
      for (const fault of ACTIVE_FAULTS) {
        const list = byTier.get(fault.z) ?? [];
        list.push(fault);
        byTier.set(fault.z, list);
      }
      // Long tier first, so it sits lowest in draw order.
      tiers = [...byTier.entries()]
        .sort(([a], [b]) => a - b)
        .map(([tier, faults]) => {
          const maxDistanceM = faultMaxDistanceMeters(tier);
          const primitive = buildTier(faults, maxDistanceM);
          v.scene.primitives.add(primitive);
          return { maxDistanceM, primitive };
        });
      // Re-check tier visibility on every rendered frame. It is three
      // comparisons, and a camera move always renders a frame.
      removePreRender = v.scene.preRender.addEventListener(applyShow);
      applyShow();
    },

    unmount() {
      removePreRender?.();
      removePreRender = null;
      if (viewer && !viewer.isDestroyed()) {
        // remove() destroys each primitive, releasing its vertex buffers.
        for (const tier of tiers) viewer.scene.primitives.remove(tier.primitive);
      }
      viewer = null;
      tiers = [];
    },

    setTimeWindow() {
      // Geological. "Active" here means Quaternary — a days-long window is
      // meaningless against a fault that last moved 10,000 years ago.
    },

    setVisible(next) {
      visible = next;
      applyShow();
    },
  };
}
