import { app, ipcMain } from 'electron';
import { appendFileSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GLOBE_FAILURE_DETAIL_MAX,
  graphicsStatusFrom,
  isRemoteSessionName,
  modeAfterFailure,
  onlySoftwareAdapter,
  serialiseGraphicsState,
  type GlobeFailureAction,
  type GpuDeviceInfo,
  type GraphicsMode,
  type GraphicsStatus,
} from '@terra-pulse/schema';

/**
 * The graphics fallback's Electron half: read the choice, apply it, and move
 * one step along when the globe cannot draw. The rules and the reasoning are
 * in `@terra-pulse/schema`'s `graphics-mode.ts`.
 */

/** Beside the database, in userData. Not `app_state`: see the schema module. */
const GRAPHICS_FILE = 'graphics.json';

/**
 * What the graphics fallback did, and on what hardware, in plain text beside
 * the database. Console output from a packaged app goes nowhere, and the two
 * Store rejections arrived as screenshots alone; the next time someone has a
 * graphics problem, this is what they can send. Local only — nothing reads it
 * but a person.
 */
const GRAPHICS_LOG = 'graphics-log.txt';

/** The log restarts when it passes this, so it can never grow without bound. */
const GRAPHICS_LOG_MAX_BYTES = 64 * 1024;

/**
 * How long to wait for Chromium's GPU description before giving up on the
 * adapter check. It is usually tens of milliseconds; a GPU process that never
 * answers is not something to hold startup for.
 */
const GPU_INFO_TIMEOUT_MS = 5000;

function graphicsFilePath(): string {
  return join(app.getPath('userData'), GRAPHICS_FILE);
}

export function logGraphics(line: string): void {
  const path = join(app.getPath('userData'), GRAPHICS_LOG);
  try {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      // Absent: the first line of a fresh log.
    }
    const text = `${new Date().toISOString()} ${line}\n`;
    if (size > GRAPHICS_LOG_MAX_BYTES) writeFileSync(path, text, 'utf8');
    else appendFileSync(path, text, 'utf8');
  } catch {
    // A log that cannot be written must never stop the app starting.
  }
}

/**
 * What Chromium ended up using, once the window has painted. Asked any
 * earlier, it answers "disabled" for everything, because the GPU process has
 * not reported yet — measured, and misleading in a log meant for diagnosis.
 */
export function logGpuFeatures(): void {
  const features = app.getGPUFeatureStatus() as unknown as Record<string, string>;
  logGraphics(
    `drawing: compositing=${features['gpu_compositing'] ?? '?'} webgl=${features['webgl'] ?? '?'} rasterization=${features['rasterization'] ?? '?'}`,
  );
}

function readStored(): string | null {
  try {
    return readFileSync(graphicsFilePath(), 'utf8');
  } catch {
    // Absent is the ordinary case: nobody has ever needed to fall back.
    return null;
  }
}

/**
 * Reads the stored mode and configures Chromium for it.
 *
 * **Must run before `app.whenReady()` resolves.** The GPU process is configured
 * when the app becomes ready; a switch set after that is ignored without any
 * error, and the app would keep failing on the graphics card while believing
 * it had moved off it.
 *
 * Both software modes turn hardware acceleration off, which is what makes
 * Chromium composite in software and copy each frame to the window itself —
 * the window no longer depends on the GPU path at all. With it off, Chromium
 * draws WebGL on WARP by itself; `enable-unsafe-swiftshader` moves it to
 * SwiftShader instead. ("Unsafe" because SwiftShader runs shaders on the CPU
 * inside the GPU process, which web browsers no longer allow for arbitrary
 * pages. This app's pages are its own.)
 */
export function applyGraphicsMode(): GraphicsStatus {
  let status = graphicsStatusFrom(readStored(), app.getVersion());
  // Remote Desktop: software from the first frame, for this session only.
  // Not saved, so the next launch at the PC's own screen tries the card.
  if (
    status.mode === 'hardware' &&
    process.platform === 'win32' &&
    isRemoteSessionName(process.env['SESSIONNAME'])
  ) {
    status = { mode: 'software', reason: 'Remote Desktop session', remoteSession: true };
  }
  if (status.mode !== 'hardware') {
    app.disableHardwareAcceleration();
    if (status.mode === 'swiftshader') app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  }
  logGraphics(
    `start ${app.getVersion()} mode=${status.mode}${status.reason ? ` reason="${status.reason}"` : ''}`,
  );
  return status;
}

interface GraphicsHandlerOptions {
  /**
   * False under `pnpm dev`: relaunching the Electron child would orphan the
   * dev server it was started from. A dev build reports the failure and stays.
   */
  canRestart: boolean;
}

export interface GraphicsController {
  /**
   * Looks at the adapter Chromium chose and, on hardware with nothing but a
   * Windows software adapter, moves to `software` before the first frame.
   * Resolves true when a restart is under way, so startup can stop there.
   */
  checkAdapter(): Promise<boolean>;
}

export function registerGraphicsHandlers(
  status: GraphicsStatus,
  options: GraphicsHandlerOptions,
): GraphicsController {
  // Once a restart is under way, later reports are the same failure seen
  // again (a lost context is followed by render errors), not a second one.
  let restarting = false;

  const restart = () => {
    restarting = true;
    logGraphics('restarting');
    // `quit`, not `exit`: every subsystem's `will-quit` cleanup still runs,
    // the engine process among them, and the window saves its size.
    app.relaunch();
    app.quit();
  };

  /** Saves `next` and restarts in it; false when it could not be saved. */
  const moveTo = (next: GraphicsMode, reason: string): boolean => {
    try {
      writeFileSync(
        graphicsFilePath(),
        serialiseGraphicsState({ mode: next, reason, appVersion: app.getVersion() }),
        'utf8',
      );
    } catch (error) {
      // Restarting without the choice saved would start in the same mode,
      // fail the same way and restart again — a loop with no way out.
      console.error('Could not save the graphics fallback; not restarting', error);
      logGraphics(`could not save ${next}; staying in ${status.mode}`);
      return false;
    }
    logGraphics(`moving to ${next}: ${reason}`);
    restart();
    return true;
  };

  // A GPU process that dies is otherwise invisible from here.
  app.on('child-process-gone', (_event, details) => {
    if (details.type === 'GPU') logGraphics(`GPU process gone: ${details.reason} (exit ${details.exitCode})`);
  });

  ipcMain.handle('graphics:status', (): GraphicsStatus => status);

  ipcMain.handle('graphics:globe-failed', (_event, detail: unknown): GlobeFailureAction => {
    if (restarting) return 'restarting';
    const reason =
      typeof detail === 'string' ? detail.slice(0, GLOBE_FAILURE_DETAIL_MAX) : 'unknown error';
    console.error(`The globe could not draw in ${status.mode} mode: ${reason}`);
    logGraphics(`globe failed in ${status.mode}: ${reason}`);

    const next = modeAfterFailure(status.mode, process.platform);
    if (next === null || !options.canRestart) return 'stay';
    return moveTo(next, reason) ? 'restarting' : 'stay';
  });

  /** The About panel's way back: forget the fallback and try the graphics card. */
  ipcMain.handle('graphics:use-hardware', (): boolean => {
    if (status.mode === 'hardware' || !options.canRestart || restarting) return false;
    try {
      rmSync(graphicsFilePath(), { force: true });
    } catch (error) {
      console.error('Could not clear the graphics fallback', error);
      return false;
    }
    logGraphics('reader asked for the graphics card again');
    restart();
    return true;
  });

  return {
    async checkAdapter() {
      let devices: GpuDeviceInfo[] | undefined;
      try {
        const info = await Promise.race([
          app.getGPUInfo('basic'),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), GPU_INFO_TIMEOUT_MS)),
        ]);
        if (info === null) {
          logGraphics('no GPU description within 5 s');
          return false;
        }
        devices = (info as { gpuDevice?: GpuDeviceInfo[] }).gpuDevice;
      } catch (error) {
        logGraphics(`GPU description unavailable: ${String(error)}`);
        return false;
      }
      const listed = (devices ?? [])
        .map(
          (device) =>
            `${(device.vendorId ?? 0).toString(16)}:${(device.deviceId ?? 0).toString(16)}${device.active ? '*' : ''}`,
        )
        .join(' ');
      logGraphics(`adapters ${listed || 'none listed'}`);

      if (status.mode !== 'hardware' || restarting || !options.canRestart) return false;
      if (process.platform !== 'win32' || !onlySoftwareAdapter(devices)) return false;
      return moveTo('software', 'No graphics card: only Windows’ software adapter is present');
    },
  };
}
