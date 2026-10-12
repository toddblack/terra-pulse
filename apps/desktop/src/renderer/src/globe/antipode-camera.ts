import * as Cesium from 'cesium';
import { ANTIPODAL_RINGS_KM } from '@terra-pulse/schema';
import { ANTIPODE_FLY_MS, antipodeViewpoint, frameGlobe, type LatLon } from '../layers/antipode-sequence';
import { fovOf, measureClearRect, offAxisOrientation, viewportOf } from './clear-area';

/**
 * The camera half of the antipode view: pull back, turn 45°, and set the chord
 * in the part of the window no panel covers. The arithmetic is in
 * `antipode-sequence.ts`, and measuring the clear area and aiming off-centre
 * are in `clear-area.ts`, shared with ordinary selection.
 */

/**
 * Flies to the antipode view of `event`.
 *
 * **The camera does not look at the planet's centre.** It is aimed a little
 * off it, so the globe lands in the clear area instead of the middle of the
 * window, where its left side would be under the inspector. See
 * `offAxisOrientation`.
 */
export function flyToAntipodeView(viewer: Cesium.Viewer, event: LatLon): void {
  const viewport = viewportOf(viewer);
  const framing = frameGlobe(viewport, measureClearRect(viewport), fovOf(viewer), Math.max(...ANTIPODAL_RINGS_KM));

  const viewpoint = antipodeViewpoint(event);
  const position = Cesium.Cartesian3.fromDegrees(viewpoint.longitude, viewpoint.latitude, framing.heightM);

  // The frame of a camera looking straight down at the planet, turned so the
  // chord is level: `towardEvent` is the horizontal direction to the event,
  // which goes on the left, so "east" (screen right) is its opposite and
  // "north" (screen up) is whatever is perpendicular to both.
  //
  // Built from the geometry rather than from the compass, because that is what
  // makes the chord level in every case. Below 40° of latitude the viewpoint is
  // chosen so this comes out as true north anyway; above it, it is north
  // rolled by whatever the chord needs. See `antipodeViewpoint`.
  const outward = Cesium.Cartesian3.normalize(position, new Cesium.Cartesian3());
  const eventDirection = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.fromDegrees(event.longitude, event.latitude),
    new Cesium.Cartesian3(),
  );
  const towardEvent = Cesium.Cartesian3.subtract(
    eventDirection,
    Cesium.Cartesian3.multiplyByScalar(
      outward,
      Cesium.Cartesian3.dot(eventDirection, outward),
      new Cesium.Cartesian3(),
    ),
    new Cesium.Cartesian3(),
  );
  Cesium.Cartesian3.normalize(towardEvent, towardEvent);
  const east = Cesium.Cartesian3.negate(towardEvent, new Cesium.Cartesian3());
  const north = Cesium.Cartesian3.cross(outward, east, new Cesium.Cartesian3());

  viewer.camera.flyTo({
    destination: position,
    orientation: offAxisOrientation(outward, east, north, framing.tanRight, framing.tanUp),
    duration: ANTIPODE_FLY_MS / 1000,
  });
}
