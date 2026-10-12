/**
 * The antipode view as a sequence: the camera pulls back and turns, the chord
 * is drawn through the planet, and the distance rings spread out from where it
 * lands. Timing and geometry only — pure and Cesium-free, so the choreography
 * can be tested without a WebGL context. `antipode-layer.ts` draws it and
 * `CesiumViewer` moves the camera.
 *
 * ## Why the camera moves at all
 *
 * A selected event is flown to the centre of the view, which puts the chord
 * exactly along the line of sight: it points straight away from the reader
 * and draws as a dot. Seeing a line through the planet needs the planet turned.
 */

import type { ScreenRect } from '../globe/camera-focus';
import { chordProgress } from './antipode';

const EARTH_RADIUS_M = 6_371_000;
const TO_RAD = Math.PI / 180;

/**
 * How far the camera turns away from the event — the user's choice
 * (2026-10-11), over the 90° first proposed.
 *
 * At 90° the chord spans the whole disc, but both ends sit exactly on the
 * limb: the rings at the far end are seen edge-on, as flat lines. At 45° the
 * chord shows at sin 45° = 71% of the diameter, the event stays on the near
 * face where it was, and the antipode is seen through the translucent planet
 * with its rings 71% as tall as they are wide — both ends legible at once.
 */
export const ANTIPODE_TURN_DEG = 45;

/** The camera move. Long enough to follow, short enough not to wait on. */
export const ANTIPODE_FLY_MS = 1_600;

/**
 * The chord, once the camera has arrived. It was 900 ms when it drew under a
 * camera that did not move; across a pulled-back globe that reads as a snap.
 */
export const CHORD_DURATION_MS = 1_300;

/** The ring front's trip from the landing point out to the widest ring. */
export const RING_SPREAD_MS = 1_400;

export interface LatLon {
  latitude: number;
  longitude: number;
}

/**
 * Below this latitude the camera can be placed so the chord is level with
 * north still up; above it there is no such place. See `antipodeViewpoint`.
 */
const LEVEL_VIEW_MAX_LATITUDE_DEG = 40;

/**
 * The point the camera ends up above: `turnDeg` of arc from the event, to its
 * east, chosen so the chord runs **level, left to right**, across the screen.
 *
 * A level chord is what lets the globe be framed large: the line and its rings
 * then need only a band of the window, not the whole disc.
 *
 * **Not simply "add 45° of longitude", and not simply "head due east".** With
 * north up, the event appears due west of the camera only if the great circle
 * joining them runs east–west *at the camera* — that is, if the camera sits at
 * that circle's highest latitude. So the camera goes there: at
 * `asin(sin(lat) / cos(turn))`, further from the equator than the event. Heading
 * due east from the event instead puts that crest at the event, and the chord
 * came out tilted 13° for a quake at 18°S and would be 51° at 60°N.
 *
 * **Beyond ±40° there is no such point** — the formula runs out at 45°, where
 * it would put the camera over the pole — so the camera heads due east from the
 * event and the chord is levelled by rolling the view instead
 * (`antipode-camera.ts` builds "up" from the geometry, which does both cases).
 * North is then not quite up, which matters least where it happens: near the
 * poles, "north up" was not saying much.
 */
export function antipodeViewpoint(event: LatLon, turnDeg: number = ANTIPODE_TURN_DEG): LatLon {
  const lat1 = event.latitude * TO_RAD;
  const lon1 = event.longitude * TO_RAD;
  const angular = turnDeg * TO_RAD;

  let lat2: number;
  let deltaLon: number;
  if (Math.abs(event.latitude) <= LEVEL_VIEW_MAX_LATITUDE_DEG) {
    // The crest of the great circle through the event: a right spherical
    // triangle with the pole, right-angled at the camera.
    lat2 = Math.asin(Math.sin(lat1) / Math.cos(angular));
    deltaLon = Math.atan2(Math.tan(angular), Math.cos(lat2));
  } else {
    // Bearing 90° from the event: cos(bearing) = 0 and sin(bearing) = 1.
    lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular));
    deltaLon = Math.atan2(Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
  }

  return {
    latitude: lat2 / TO_RAD,
    longitude: (((((lon1 + deltaLon) / TO_RAD + 540) % 360) + 360) % 360) - 180,
  };
}

export interface GlobeFraming {
  /** Camera height above the surface, metres. */
  heightM: number;
  /**
   * Where the planet's centre should appear, as tangents of the angle off the
   * camera's axis: right and up positive. Zero for both is a centred globe.
   */
  tanRight: number;
  tanUp: number;
}

/**
 * How far left and right of the globe's centre the chord and its rings reach,
 * in globe radii as drawn, for a camera `distanceInRadii` from the planet's
 * centre.
 *
 * **Not symmetric, and the first version assumed it was.** Seen from infinitely
 * far away both ends would sit `sin(turn)` out. From a real camera the near end
 * is closer to the eye and so drawn further out, and the far end nearer in: at
 * 4.5 radii and 45°, 0.82 of a radius on the event's side against 0.60 on the
 * antipode's. Framed as if symmetric, the event's reticle touched the inspector
 * while a strip twice as wide stood empty on the right.
 *
 * The far side also carries the widest ring, at its own angular radius
 * foreshortened by `cos(turn)` because it is seen at a slant.
 */
export function chordExtentInRadii(
  distanceInRadii: number,
  maxRingKm: number,
  turnDeg: number = ANTIPODE_TURN_DEG,
): { left: number; right: number } {
  const turn = turnDeg * TO_RAD;
  // The limb is where a sight line grazes the sphere; everything is measured
  // against it because it is the edge of the disc on screen.
  const limb = Math.sqrt(distanceInRadii ** 2 - 1);
  const near = (Math.sin(turn) * limb) / (distanceInRadii - Math.cos(turn));
  const farScale = limb / (distanceInRadii + Math.cos(turn));
  const ring = (maxRingKm / (EARTH_RADIUS_M / 1000)) * Math.abs(Math.cos(turn));
  return { left: near, right: (Math.sin(turn) + ring) * farScale };
}

/**
 * How much of the globe below its centre must stay clear of the dock, in
 * radii. Half: the level chord and its rings need far less (about 0.2), but a
 * planet cut off at its equator stops reading as a planet. At 0.5 the disc
 * comes out the size the app opens at, with its foot under the dock the way
 * the opening view's already is.
 */
const CLEAR_BELOW_CENTRE_IN_RADII = 0.5;

/**
 * How far back and how far off-axis the camera must be for the chord to sit
 * inside `clear` — the part of the window no panel covers.
 *
 * The window's centre is not the middle of what is visible: the selection
 * column takes the left, the dock the bottom. A globe centred on the window
 * would draw the chord's near end under the inspector, which is the thing the
 * reader just pressed a button to see.
 *
 * **Sized to the chord, not to the whole disc.** The first version fitted the
 * entire globe into the clear area, and with the timeline open that is a 410px
 * planet whose 250 km ring is 8px across. The chord is level, so it needs the
 * clear area's *width* and only a band of its height; the disc's top stays in
 * view and its foot goes under the dock.
 *
 * `fovRad` is Cesium's frustum angle, which spans the **larger** of the
 * viewport's two dimensions.
 */
export function frameGlobe(
  viewport: { width: number; height: number },
  clear: ScreenRect,
  fovRad: number,
  maxRingKm: number,
  turnDeg: number = ANTIPODE_TURN_DEG,
): GlobeFraming {
  const focalPx = Math.max(viewport.width, viewport.height) / 2 / Math.tan(fovRad / 2);
  // A clear area that has collapsed (a tiny window, a panel over everything)
  // falls back to the window itself rather than a zero-size globe.
  const usable = clear.right - clear.left > 80 && clear.bottom - clear.top > 80;
  const rect = usable ? clear : { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  const middleX = (rect.left + rect.right) / 2;
  const middleY = (rect.top + rect.bottom) / 2;

  // How far the chord reaches depends on the camera's distance, which depends
  // on how big the disc is drawn, which depends on how far the chord reaches.
  // It settles in a couple of rounds; the starting distance is the one the app
  // opens at.
  let distanceInRadii = 4.5;
  let radiusPx = 0;
  let discX = middleX;
  let discY = middleY;
  for (let round = 0; round < 4; round += 1) {
    const extent = chordExtentInRadii(distanceInRadii, maxRingKm, turnDeg);
    // 6% of the width kept as margin, so a ring does not touch a panel.
    radiusPx = Math.min((0.94 * width) / (extent.left + extent.right), height / (1 + CLEAR_BELOW_CENTRE_IN_RADII));
    // The chord's span centred in the clear width, which puts the disc's own
    // centre right of the middle by half the difference between its two sides.
    discX = middleX + ((extent.left - extent.right) / 2) * radiusPx;
    // Vertically centred when the disc fits; otherwise top edge at the top of
    // the clear area, which the radius above guarantees leaves the band clear.
    discY = Math.max(rect.top + radiusPx, Math.min(middleY, rect.bottom - CLEAR_BELOW_CENTRE_IN_RADII * radiusPx));

    // Off-axis, a pixel is further from the eye than the focal length, so the
    // same angular radius covers fewer pixels there.
    const reach = Math.hypot(focalPx, discX - viewport.width / 2, viewport.height / 2 - discY);
    distanceInRadii = 1 / Math.sin(Math.atan(radiusPx / reach));
  }

  return {
    heightM: (distanceInRadii - 1) * EARTH_RADIUS_M,
    tanRight: (discX - viewport.width / 2) / focalPx,
    tanUp: (viewport.height / 2 - discY) / focalPx,
  };
}

export type AntipodePhase = 'flying' | 'drawing' | 'spreading' | 'settled';

export interface AntipodeMoment {
  phase: AntipodePhase;
  /** 0–1 along the chord, eased. */
  chord: number;
  /**
   * How far the ring front has travelled from the landing point, km. Null
   * until the chord lands: nothing at the far end may show before then, or it
   * gives away the ending.
   */
  ringFrontKm: number | null;
}

/**
 * Where the sequence stands `elapsedMs` after the mode was entered.
 *
 * One clock for all three acts, so they cannot drift apart: the chord waits
 * for the camera, and the rings wait for the chord. Clamped at both ends — a
 * paused tab can hand back a very large elapsed time.
 */
export function antipodeMoment(elapsedMs: number, maxRingKm: number, flyMs: number = ANTIPODE_FLY_MS): AntipodeMoment {
  const sinceFlight = elapsedMs - flyMs;
  if (sinceFlight < 0) return { phase: 'flying', chord: 0, ringFrontKm: null };

  if (sinceFlight < CHORD_DURATION_MS) {
    return { phase: 'drawing', chord: chordProgress(sinceFlight, CHORD_DURATION_MS), ringFrontKm: null };
  }

  const sinceLanding = sinceFlight - CHORD_DURATION_MS;
  if (sinceLanding < RING_SPREAD_MS) {
    // The same ease as the chord: the front leaves fast and settles.
    return { phase: 'spreading', chord: 1, ringFrontKm: chordProgress(sinceLanding, RING_SPREAD_MS) * maxRingKm };
  }
  return { phase: 'settled', chord: 1, ringFrontKm: maxRingKm };
}

/**
 * A ring's radius while the front is passing: it grows with the front until
 * it reaches its own size, then stays. Null before the front has left.
 */
export function ringRadiusKm(ringKm: number, frontKm: number | null): number | null {
  if (frontKm === null || frontKm <= 0) return null;
  return Math.min(ringKm, frontKm);
}
