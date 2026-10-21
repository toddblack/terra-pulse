/**
 * How the globe is drawn: on the graphics card, or in software.
 *
 * **Why this exists.** The Microsoft Store's certification run rejected the
 * app twice on the same machine, a Windows 11 Enterprise Insider VM (build
 * 29691). 0.1.0 stopped on "Fragment shader failed to compile. Compile log:" —
 * an empty log, which is a driver refusing a shader without saying why. 0.1.2,
 * which restarted one step off the graphics card on such a failure, opened to
 * a **white window with nothing in it** on both launches. Neither reproduces
 * here: the same packages draw on this PC's GPU and in every software mode,
 * and the restart works inside the installed package.
 *
 * **Every step below the graphics card now puts its pixels on screen in
 * software.** 0.1.2's middle step was `--use-angle=d3d11-warp`, which moves
 * WebGL onto Windows' software rasteriser but still shows the window through
 * the GPU path (DirectComposition). A window that renders but cannot be shown
 * looks exactly like that white window, and it is the known failure of
 * Chromium apps on virtual machines and over Remote Desktop — VS Code's own
 * fix for it is turning hardware acceleration off. So both software steps use
 * Electron's `disableHardwareAcceleration()`: Chromium composites in software
 * and copies the frame to the window itself, with no graphics card involved.
 *
 * It costs nothing, measured on this PC dragging the globe: hardware 41 fps,
 * the old WARP step 7.4, `software` 7.7 (Chromium puts WebGL on WARP by
 * itself once hardware acceleration is off), `swiftshader` 4.0.
 *
 * **`swiftshader` is the last step** because it depends on nothing in
 * Windows: SwiftShader ships inside Electron. It exists for a machine whose
 * WARP is the thing that is broken — an Insider build's WARP failing a shader
 * would look exactly like 0.1.0's report.
 *
 * Main reads the choice before the app is ready (a Chromium switch cannot be
 * set after), so it lives in a small file beside the database rather than in
 * `app_state`, which only opens once the app is ready.
 */

export type GraphicsMode = 'hardware' | 'software' | 'swiftshader';

/** Most capable first. Each failure moves one step along. */
export const GRAPHICS_MODES: readonly GraphicsMode[] = ['hardware', 'software', 'swiftshader'];

/** What main tells the renderer about how this session is drawing. */
export interface GraphicsStatus {
  mode: GraphicsMode;
  /** Why the graphics card was left: the error the globe hit there. */
  reason: string | null;
  /**
   * True when software was chosen because this is a Remote Desktop session,
   * not because anything failed. For this session only — nothing is saved,
   * so the same PC used at its own screen still gets the graphics card.
   */
  remoteSession?: boolean;
}

/**
 * True for the session name Windows gives a Remote Desktop session
 * (`RDP-Tcp#3`); the PC's own screen is `Console`.
 *
 * Over Remote Desktop the graphics card often cannot put Chromium's frames on
 * screen, and the result is a window that runs but stays white — the failure
 * the Store's review VM showed, which is surely reached that way. Software
 * presentation sidesteps it before the first frame, at no cost on a machine
 * where "the graphics card" is a virtual one anyway.
 *
 * Read from `SESSIONNAME`, which is the one signal available before the app
 * is ready (a native check would need an addon). It can be stale — an RDP
 * reconnect to a session started at the console keeps `Console` — and then
 * the ordinary fallback still applies.
 */
export function isRemoteSessionName(sessionName: string | undefined): boolean {
  return typeof sessionName === 'string' && /^RDP-/i.test(sessionName);
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
 * leave someone in software rendering for no reason they can find. A file
 * from 0.1.2/0.1.3 says `warp`, which no longer exists — but it also names an
 * older version, so it is ignored on that ground before the mode matters.
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
  if (mode !== 'software' && mode !== 'swiftshader') return HARDWARE_GRAPHICS;
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
 * `software` exists only on Windows, where Chromium falls back to WARP for
 * WebGL; elsewhere turning acceleration off leaves no WebGL at all, so
 * hardware goes straight to SwiftShader. SwiftShader is the last step: a
 * failure there is not a driver the app can route around, and restarting
 * again would loop forever.
 */
export function modeAfterFailure(mode: GraphicsMode, platform: string): GraphicsMode | null {
  if (mode === 'hardware') return platform === 'win32' ? 'software' : 'swiftshader';
  if (mode === 'software') return 'swiftshader';
  return null;
}

/** The longest failure description kept: an error plus the GPU's name, not a shader's source. */
export const GLOBE_FAILURE_DETAIL_MAX = 600;

/** One line for the About panel while drawing in software. */
export function softwareRenderingNote(status: GraphicsStatus): string | null {
  if (status.mode === 'hardware') return null;
  if (status.remoteSession === true) {
    return 'This is a Remote Desktop session, where the graphics card often cannot show the window, so the globe is drawn with software rendering. Run at the PC itself, Terra Pulse uses the graphics card.';
  }
  const renderer =
    status.mode === 'software' ? 'software rendering' : 'software rendering (SwiftShader)';
  return `The graphics card could not be used to draw the globe, so it is drawn with ${renderer}. That works on any PC but is slower. Each update tries the graphics card again.`;
}

// --- No graphics card at all ----------------------------------------------

/** One adapter as Electron's `app.getGPUInfo('basic')` lists it. */
export interface GpuDeviceInfo {
  active?: boolean;
  vendorId?: number;
  deviceId?: number;
}

/** PCI vendor id Windows' own adapters report: Basic Render Driver, Basic Display, Remote Display. */
const MICROSOFT_VENDOR_ID = 0x1414;

/**
 * True when the GPU Chromium is using is one of Windows' own software
 * adapters — a virtual machine, or a Remote Desktop session, with no real
 * graphics card.
 *
 * There the "graphics card" *is* WARP already, so `software` draws the globe
 * just as fast, and it shows the window without the GPU path that the Store
 * review VM is suspected of failing. So the app moves there before the first
 * frame rather than waiting for a failure that may only ever show as a white
 * window, which nothing inside the page can detect.
 *
 * The active adapter decides; with none flagged active, the first listed, which
 * is the one Chromium picked. An empty or unreadable list is not evidence of
 * anything and answers false.
 */
export function onlySoftwareAdapter(devices: readonly GpuDeviceInfo[] | undefined): boolean {
  if (!devices || devices.length === 0) return false;
  const chosen = devices.find((device) => device.active === true) ?? devices[0];
  return chosen?.vendorId === MICROSOFT_VENDOR_ID;
}

// --- Frames that never reach the screen ------------------------------------

/**
 * Seconds of a visible window with running timers and not one animation
 * frame before the page counts it as a graphics failure.
 *
 * Long on purpose. A busy main thread stops timers too, so it cannot trip
 * this; what can is a hidden or minimised window, which is why only visible
 * seconds count. Ten seconds of a visible page that has drawn nothing is not
 * a slow machine — the slowest mode here still draws four frames a second.
 */
export const NO_FRAME_TIMEOUT_S = 10;

/** One check of the frame watchdog, once a second. */
export interface FrameWatchTick {
  /** `document.visibilityState === 'visible'`. */
  visible: boolean;
  /** Animation frames since the previous tick. */
  frames: number;
}

/**
 * Counts consecutive visible seconds with no frame; returns the new count.
 * A frame resets it; a hidden second neither counts nor resets, so a window
 * minimised for a minute is not "ten seconds without a frame".
 */
export function nextFramelessSeconds(previous: number, tick: FrameWatchTick): number {
  if (tick.frames > 0) return 0;
  if (!tick.visible) return previous;
  return previous + 1;
}
