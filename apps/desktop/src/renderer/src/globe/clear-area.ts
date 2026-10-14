import * as Cesium from 'cesium';
import { aimForPixel, altitudeToFit, type ScreenRect } from './camera-focus';

/**
 * The part of the window no panel covers, and putting things in the middle of
 * it. The window's own centre is not that middle: the selection column takes
 * the left, the dock the bottom.
 *
 * Two readers: selecting an earthquake, which is flown to the centre of the
 * clear area rather than of the window (the user's ask, 2026-10-11 — once the
 * inspector became a column, the window's centre was no longer the centre of
 * what you could see), and the antipode view, which frames a whole chord there.
 */

/** Breathing room between what is framed and the chrome around it. */
const CLEAR_GAP_PX = 12;

/** The inspector's width in rem, for reserving its place before it exists. */
const INSPECTOR_WIDTH_REM = 24;
/** The gap `.selectionColumn` leaves after the left column, in rem. */
const SELECTION_COLUMN_GAP_REM = 1;

export function viewportOf(viewer: Cesium.Viewer): { width: number; height: number } {
  const canvas = viewer.scene.canvas;
  return { width: canvas.clientWidth, height: canvas.clientHeight };
}

/** Cesium's frustum angle, which spans the larger of the viewport's two dimensions. */
export function fovOf(viewer: Cesium.Viewer): number {
  const frustum = viewer.camera.frustum;
  return frustum instanceof Cesium.PerspectiveFrustum && frustum.fov !== undefined
    ? frustum.fov
    : Cesium.Math.toRadians(60);
}

/**
 * The clear area, measured from the panels themselves at the moment of asking.
 *
 * Measured, not assumed, for the reason `published-size.ts` gives: every one
 * of these edges moves at runtime — the dock minimises, the event list opens,
 * the inspector comes and goes. A panel that is not on screen simply does not
 * narrow the area.
 *
 * `reserveInspector` leaves room for the inspector even if it is not there
 * yet. A selection is centred against where the column *will* be: measured a
 * moment too early, the mark would be placed for a window with no inspector
 * and then covered by it.
 */
export function measureClearRect(
  viewport: { width: number; height: number },
  { reserveInspector = false }: { reserveInspector?: boolean } = {},
): ScreenRect {
  const rectOf = (id: string): DOMRect | null => {
    const rect = document.getElementById(id)?.getBoundingClientRect();
    return rect !== undefined && rect.width > 0 && rect.height > 0 ? rect : null;
  };
  const leftColumn = rectOf('left-column');
  const selection = rectOf('selection-column');
  const rightColumn = rectOf('right-column');
  const dock = rectOf('bottom-dock');
  const modeSwitch = rectOf('mode-switch');

  let left = Math.max(leftColumn?.right ?? 0, selection?.right ?? 0);
  if (reserveInspector && leftColumn !== null) {
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    left = Math.max(left, leftColumn.right + (SELECTION_COLUMN_GAP_REM + INSPECTOR_WIDTH_REM) * rem);
  }

  return {
    left: left + CLEAR_GAP_PX,
    right: (rightColumn?.left ?? viewport.width) - CLEAR_GAP_PX,
    top: (modeSwitch?.bottom ?? 0) + CLEAR_GAP_PX,
    bottom: (dock?.top ?? viewport.height) - CLEAR_GAP_PX,
  };
}

/**
 * A camera orientation that looks down at the planet from `outward`, with
 * `east` to the right and `north` up, aimed off the planet's centre so that
 * the centre — and whatever is directly beneath the camera — appears
 * `tanRight` right of and `tanUp` above the middle of the window.
 *
 * **A rotation of the view about the camera, not a move.** A real off-centre
 * projection would mean replacing Cesium's frustum, which is more machinery
 * than a few degrees of aim is worth. The cost is that the view is no longer
 * quite straight down: about 11° off on a typical window, which reads as a
 * slight tilt when zoomed in close.
 */
export function offAxisOrientation(
  outward: Cesium.Cartesian3,
  east: Cesium.Cartesian3,
  north: Cesium.Cartesian3,
  tanRight: number,
  tanUp: number,
): { direction: Cesium.Cartesian3; up: Cesium.Cartesian3 } {
  // To put the planet's centre right of and above the axis, aim left and down
  // by the same angles.
  const direction = Cesium.Cartesian3.negate(outward, new Cesium.Cartesian3());
  Cesium.Cartesian3.subtract(
    direction,
    Cesium.Cartesian3.multiplyByScalar(east, tanRight, new Cesium.Cartesian3()),
    direction,
  );
  Cesium.Cartesian3.subtract(
    direction,
    Cesium.Cartesian3.multiplyByScalar(north, tanUp, new Cesium.Cartesian3()),
    direction,
  );
  Cesium.Cartesian3.normalize(direction, direction);

  // Up must stay perpendicular to where the camera now points.
  const up = Cesium.Cartesian3.subtract(
    north,
    Cesium.Cartesian3.multiplyByScalar(direction, Cesium.Cartesian3.dot(north, direction), new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  Cesium.Cartesian3.normalize(up, up);
  return { direction, up };
}

/**
 * Flies to a point so that it lands in the middle of the clear area: between
 * the inspector column and the right column, and between the top of the
 * window's chrome and the dock.
 *
 * The camera goes directly above the point, north up, at `heightM`, and is
 * then aimed off-centre — see `offAxisOrientation`. Above the point rather
 * than beside it, so the point is seen face-on at any zoom: shifting the
 * camera sideways instead would, at whole-globe zoom, leave the point out near
 * the limb and seen at a slant.
 */
export function flyToInClearArea(
  viewer: Cesium.Viewer,
  point: { latitude: number; longitude: number },
  heightM: number,
  durationS: number,
): void {
  const viewport = viewportOf(viewer);
  const clear = measureClearRect(viewport, { reserveInspector: true });
  const aim = aimForPixel(
    viewport,
    { x: (clear.left + clear.right) / 2, y: (clear.top + clear.bottom) / 2 },
    fovOf(viewer),
  );

  const position = Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude, heightM);
  const outward = Cesium.Cartesian3.normalize(position, new Cesium.Cartesian3());
  const east = Cesium.Cartesian3.cross(Cesium.Cartesian3.UNIT_Z, outward, new Cesium.Cartesian3());
  // Directly over a pole there is no east; any horizontal direction will do.
  if (Cesium.Cartesian3.magnitude(east) < 1e-9) Cesium.Cartesian3.clone(Cesium.Cartesian3.UNIT_X, east);
  Cesium.Cartesian3.normalize(east, east);
  const north = Cesium.Cartesian3.cross(outward, east, new Cesium.Cartesian3());

  viewer.camera.flyTo({
    destination: position,
    orientation: offAxisOrientation(outward, east, north, aim.tanRight, aim.tanUp),
    duration: durationS,
  });
}

/** How much of the clear area a fitted circle may fill; the rest is margin. */
const FIT_FILL = 0.88;

/**
 * Flies to a point at the height where a circle of `radiusM` around it just
 * fits the clear area — for something with an extent, where
 * `flyToInClearArea` alone would centre it at whatever zoom the reader had.
 */
export function flyToFitInClearArea(
  viewer: Cesium.Viewer,
  point: { latitude: number; longitude: number },
  radiusM: number,
  durationS: number,
): void {
  const viewport = viewportOf(viewer);
  const clear = measureClearRect(viewport, { reserveInspector: true });
  // The smaller side: the circle has to fit both ways.
  const halfPx = (Math.min(clear.right - clear.left, clear.bottom - clear.top) / 2) * FIT_FILL;
  flyToInClearArea(
    viewer,
    point,
    // A clear area squeezed to nothing would ask for an infinite height.
    altitudeToFit(radiusM, Math.max(halfPx, 40), viewport, fovOf(viewer)),
    durationS,
  );
}
