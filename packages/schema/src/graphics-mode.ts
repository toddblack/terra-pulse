/**
 * How the globe is drawn: on the graphics card, or in one of two software
 * renderers.
 *
 * **Why this exists.** The Microsoft Store's certification run (2026-10-20,
 * Windows 11 Enterprise build 29691) stopped on launch with "Fragment shader
 * failed to compile. Compile log:" — an empty log, which is a driver refusing
 * a shader without saying why. Nothing here reproduces it: the same build
 * draws correctly on this PC's GPU, on WARP and on SwiftShader. A lost context
 * was ruled out too, because it fails differently (Cesium reports "Expected
 * width to be greater than 0", and WebGL's log is `null`, not empty). So the
 * failure belongs to that machine's graphics stack, and the fix cannot be a
 * change to one shader. It is a way out: when the globe fails, the app
 * restarts one step further from the graphics card.
 *
 * **Two software steps, because one is fast and the other is certain.**
 * Measured on this PC, dragging the globe: hardware 43 fps, WARP 8, SwiftShader
 * 3. WARP is Windows' own software rasteriser, so it comes first. But it is
 * part of Windows, and a review VM with no GPU may already have been on WARP
 * when it failed. SwiftShader ships inside Electron and behaves the same on
 * every PC and every Windows build, so it is the last step.
 *
 * Main reads the choice before the app is ready (a Chromium switch cannot be
 * set after), so it lives in a small file beside the database rather than in
 * `app_state`, which only opens once the app is ready.
 */

export type GraphicsMode = 'hardware' | 'warp' | 'swiftshader';

/** Most capable first. Each failure moves one step along. */
export const GRAPHICS_MODES: readonly GraphicsMode[] = ['hardware', 'warp', 'swiftshader'];

/** What main tells the renderer about how this session is drawing. */
export interface GraphicsStatus {
  mode: GraphicsMode;
  /** Why the graphics card was left: the error the globe hit there. */
  reason: string | null;
}

/** Main's answer when the renderer reports that the globe could not draw. */
export type GlobeFailureAction =
  /** The next mode is saved and the app is restarting in it. */
  | 'restarting'
  /** No step left, or a dev build, where a restart would kill the dev server. */
  | 'stay';

/** What is stored on disk. */
export interface GraphicsState {
  mode: GraphicsMode;
  reason: string | null;
  /**
   * The app version that fell back. A later version tries the graphics card
   * again: an update brings a new Chromium and a new ANGLE, which may draw on
   * a driver the old one could not.
   */
  appVersion: string;
}

export const HARDWARE_GRAPHICS: GraphicsStatus = { mode: 'hardware', reason: null };

/**
 * The stored state, if it applies to this version; otherwise hardware.
 *
 * Strict, and failing toward the graphics card. A damaged file must never
 * leave someone in software rendering for no reason they can find.
 */
export function graphicsStatusFrom(text: string | null, appVersion: string): GraphicsStatus {
  if (text === null) return HARDWARE_GRAPHICS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return HARDWARE_GRAPHICS;
  }
  if (typeof parsed !== 'object' || parsed === null) return HARDWARE_GRAPHICS;
  const record = parsed as Record<string, unknown>;
  const mode = record['mode'];
  if (mode !== 'warp' && mode !== 'swiftshader') return HARDWARE_GRAPHICS;
  if (record['appVersion'] !== appVersion) return HARDWARE_GRAPHICS;
  const reason = record['reason'];
  return { mode, reason: typeof reason === 'string' ? reason : null };
}

export function serialiseGraphicsState(state: GraphicsState): string {
  return JSON.stringify(state);
}

/**
 * Where to go after the globe fails in `mode`: the next step, or nowhere.
 *
 * WARP exists only on Windows, so elsewhere hardware goes straight to
 * SwiftShader. SwiftShader is the last step: a failure there is not a driver
 * the app can route around, and restarting again would loop forever.
 */
export function modeAfterFailure(mode: GraphicsMode, platform: string): GraphicsMode | null {
  if (mode === 'hardware') return platform === 'win32' ? 'warp' : 'swiftshader';
  if (mode === 'warp') return 'swiftshader';
  return null;
}

/** The longest failure description kept: an error plus the GPU's name, not a shader's source. */
export const GLOBE_FAILURE_DETAIL_MAX = 600;

/** One line for the About panel while drawing in software. */
export function softwareRenderingNote(status: GraphicsStatus): string | null {
  if (status.mode === 'hardware') return null;
  const renderer =
    status.mode === 'warp' ? 'Windows’ software renderer (WARP)' : 'software (SwiftShader)';
  return `The graphics driver could not draw the globe, so it is drawn with ${renderer}. That works on any PC but is slower. Each update tries the graphics card again.`;
}
