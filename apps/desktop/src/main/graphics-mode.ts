import { app, ipcMain } from 'electron';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GLOBE_FAILURE_DETAIL_MAX,
  graphicsStatusFrom,
  modeAfterFailure,
  serialiseGraphicsState,
  type GlobeFailureAction,
  type GraphicsMode,
  type GraphicsStatus,
} from '@terra-pulse/schema';

/**
 * The graphics fallback's Electron half: read the choice, apply it, and move
 * one step along when the renderer says the globe could not draw. The rules
 * and the reasoning are in `@terra-pulse/schema`'s `graphics-mode.ts`.
 */

/** Beside the database, in userData. Not `app_state`: see the schema module. */
const GRAPHICS_FILE = 'graphics.json';

/** ANGLE's backend for each software mode. Hardware sets nothing and lets Chromium choose. */
const ANGLE_BACKEND: Record<Exclude<GraphicsMode, 'hardware'>, string> = {
  warp: 'd3d11-warp',
  swiftshader: 'swiftshader',
};

function graphicsFilePath(): string {
  return join(app.getPath('userData'), GRAPHICS_FILE);
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
 * Reads the stored mode and sets the Chromium switch for it.
 *
 * **Must run before `app.whenReady()` resolves.** The GPU process is configured
 * when the app becomes ready; a switch appended after that is ignored without
 * any error, and the app would keep failing on the graphics card while
 * believing it had moved off it.
 */
export function applyGraphicsMode(): GraphicsStatus {
  const status = graphicsStatusFrom(readStored(), app.getVersion());
  if (status.mode !== 'hardware') {
    app.commandLine.appendSwitch('use-angle', ANGLE_BACKEND[status.mode]);
    console.warn(`Drawing the globe with ${status.mode}: ${status.reason ?? 'no reason recorded'}`);
  }
  return status;
}

interface GraphicsHandlerOptions {
  /**
   * False under `pnpm dev`: relaunching the Electron child would orphan the
   * dev server it was started from. A dev build reports the failure and stays.
   */
  canRestart: boolean;
}

export function registerGraphicsHandlers(
  status: GraphicsStatus,
  options: GraphicsHandlerOptions,
): void {
  // Once a restart is under way, later reports are the same failure seen
  // again (a lost context is followed by render errors), not a second one.
  let restarting = false;

  const restart = () => {
    restarting = true;
    // `quit`, not `exit`: every subsystem's `will-quit` cleanup still runs,
    // the engine process among them, and the window saves its size.
    app.relaunch();
    app.quit();
  };

  ipcMain.handle('graphics:status', (): GraphicsStatus => status);

  ipcMain.handle('graphics:globe-failed', (_event, detail: unknown): GlobeFailureAction => {
    if (restarting) return 'restarting';
    const reason =
      typeof detail === 'string' ? detail.slice(0, GLOBE_FAILURE_DETAIL_MAX) : 'unknown error';
    console.error(`The globe could not draw in ${status.mode} mode: ${reason}`);

    const next = modeAfterFailure(status.mode, process.platform);
    if (next === null || !options.canRestart) return 'stay';

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
      return 'stay';
    }
    restart();
    return 'restarting';
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
    restart();
    return true;
  });
}
