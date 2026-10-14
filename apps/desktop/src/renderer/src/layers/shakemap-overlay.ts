import * as Cesium from 'cesium';
import {
  ISOSEISMAL_CASING,
  intensityColor,
  intensityNumeral,
  labelPoint,
  type Isoseismal,
} from './shakemap-encoding';

/**
 * The selected quake's shaking-intensity lines on the globe.
 *
 * Not a registry layer, for `location-highlight`'s reasons: it belongs to the
 * selection, nobody toggles it in the layer panel, and it exists exactly while
 * a quake with a ShakeMap is selected and the lines are switched on.
 *
 * ## Primitives, not entities, and the reason is the pointer
 *
 * Every other overlay here is built from entities. These are `Primitive`s
 * with **`allowPicking: false`**, because the lines sit on top of the very
 * things a reader points at next: the mainshock and its aftershocks. An
 * entity line is picked like any other object. The hover pick drills only
 * four deep, so nested lines over a dot can use up the slots before the dot is
 * reached; and Cesium's own click handler would put the earthquake's selection
 * reticle onto a line. Unpickable, the lines are not there as far as the
 * pointer is concerned: no tooltip, no reticle, and a click on one is a click
 * on the globe underneath — which deselects, as a click on bare globe always
 * has. (Checked in the running app: hovering a line shows nothing.)
 *
 * It also means no `dataSources.add()`, which is asynchronous and needs a
 * guard against being destroyed before it resolves. `scene.primitives.add()`
 * is immediate.
 *
 * One primitive per intensity, because the cased-line material is a uniform:
 * every line in a primitive shares its colour.
 */

/** Line widths in pixels: the colour, and the dark casing either side of it. */
const LINE_WIDTH = 3;
const CASING_WIDTH = 1.25;

export interface ShakeMapOverlay {
  destroy(): void;
}

export function createShakeMapOverlay(
  viewer: Cesium.Viewer,
  isoseismals: readonly Isoseismal[],
): ShakeMapOverlay {
  const casing = Cesium.Color.fromCssColorString(ISOSEISMAL_CASING);
  const primitives: Cesium.Primitive[] = [];

  for (const isoseismal of isoseismals) {
    const instances = isoseismal.lines.map(
      (line) =>
        new Cesium.GeometryInstance({
          geometry: new Cesium.PolylineGeometry({
            positions: line.map(([longitude, latitude]) =>
              Cesium.Cartesian3.fromDegrees(longitude, latitude),
            ),
            width: LINE_WIDTH + 2 * CASING_WIDTH,
            // The points are a few kilometres apart, so the default geodesic
            // arc between them follows the ground.
            vertexFormat: Cesium.PolylineMaterialAppearance.VERTEX_FORMAT,
          }),
        }),
    );
    if (instances.length === 0) continue;

    primitives.push(
      viewer.scene.primitives.add(
        new Cesium.Primitive({
          geometryInstances: instances,
          appearance: new Cesium.PolylineMaterialAppearance({
            material: Cesium.Material.fromType('PolylineOutline', {
              color: Cesium.Color.fromCssColorString(intensityColor(isoseismal.intensity)),
              outlineColor: casing,
              outlineWidth: CASING_WIDTH,
            }),
          }),
          allowPicking: false,
          // A few thousand points in all. Built on the next frame rather than
          // handed to a worker, so the lines appear together instead of one
          // intensity at a time as each worker finishes.
          asynchronous: false,
        }),
      ) as Cesium.Primitive,
    );
  }

  // The numerals. Colour says which intensity only to someone who knows the
  // ShakeMap scale; the numeral says it to everyone.
  const labels = viewer.scene.primitives.add(new Cesium.LabelCollection()) as Cesium.LabelCollection;
  for (const isoseismal of isoseismals) {
    const point = labelPoint(isoseismal);
    if (point === null) continue;
    labels.add({
      position: Cesium.Cartesian3.fromDegrees(point[0], point[1]),
      text: intensityNumeral(isoseismal.intensity),
      font: '700 13px system-ui, sans-serif',
      fillColor: Cesium.Color.fromCssColorString(intensityColor(isoseismal.intensity)),
      outlineColor: casing,
      outlineWidth: 4,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -3),
      // Hidden once the lines are too small to tell apart, where the numerals
      // would pile into one unreadable knot over the epicentre.
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 9_000_000),
    });
  }

  viewer.scene.requestRender();

  return {
    destroy() {
      // The viewer can be torn down before this cleanup runs; its primitives
      // went with it, and touching the scene then throws.
      if (viewer.isDestroyed()) return;
      // `remove` destroys what it removes (`destroyPrimitives` is on).
      for (const primitive of primitives) viewer.scene.primitives.remove(primitive);
      viewer.scene.primitives.remove(labels);
      viewer.scene.requestRender();
    },
  };
}
