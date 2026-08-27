import { ipcMain } from 'electron';
import {
  EphemerisCancelledError,
  downloadEphemerisKernel,
  kernelPath,
  verifyKernel,
} from '@terra-pulse/ingest';
import { EPHEMERIS_KERNEL_BYTES, type EphemerisProgress } from '@terra-pulse/schema';

/**
 * The JPL ephemeris kernel H6 needs — download, status, and the path the engine
 * is told to read.
 *
 * ## How this differs from the five archive controllers
 *
 * Those fetch records into SQLite and resume by chunk. This fetches **one file
 * to disk** and its resume record is the part-file itself, so there is no
 * chunks table and no database involvement at all. The controller is
 * correspondingly thinner: no `attempt` retry wrapper (the two-host fallback in
 * the adapter covers the same ground), no chunk plan, no current-chunk label.
 *
 * ## Why the path goes to the renderer at all
 *
 * The renderer never opens it — it cannot, and non-negotiable #6's spirit says
 * it should not. The path travels renderer → engine in the H6 request body,
 * because **in dev the engine is adopted rather than spawned** (`pnpm
 * engine:dev` in a second terminal), so main has no opportunity to put it in
 * the engine's environment. A path in the request works for an adopted engine
 * and a spawned one identically, which an env var does not.
 *
 * ## The download is never automatic
 *
 * Same rule as every historical record here, and with more force: 31.2 MB for
 * a capability most sessions never reach. `ensure` exists so the H6 run path
 * can ask "is it there" without starting anything.
 */

export interface EphemerisController {
  status(): Promise<EphemerisProgress>;
  start(): Promise<EphemerisProgress>;
  cancel(): void;
  /** The verified kernel path, or null. Read by the analysis path before H6. */
  resolvedPath(): Promise<string | null>;
}

export function createEphemerisController(
  directory: string,
  onProgress: (progress: EphemerisProgress) => void,
): EphemerisController {
  let state: EphemerisProgress['state'] = 'idle';
  let downloadedBytes = 0;
  let error: string | null = null;
  let running: Promise<EphemerisProgress> | null = null;
  const signal = { aborted: false };

  const path = kernelPath(directory);

  async function status(): Promise<EphemerisProgress> {
    // Verified from disk rather than from a run-local flag, so a status call in
    // a fresh session reports a kernel downloaded weeks ago — and so a file
    // deleted behind the app's back is noticed rather than assumed present.
    const verified = await verifyKernel(path);
    return {
      state,
      present: verified.ok,
      path: verified.ok ? path : null,
      downloadedBytes: verified.ok ? EPHEMERIS_KERNEL_BYTES : downloadedBytes,
      totalBytes: EPHEMERIS_KERNEL_BYTES,
      error,
    };
  }

  function publish(): void {
    void status().then(onProgress);
  }

  async function run(): Promise<EphemerisProgress> {
    state = 'running';
    error = null;
    downloadedBytes = 0;
    publish();

    try {
      await downloadEphemerisKernel({
        directory,
        signal,
        onProgress: (downloaded) => {
          downloadedBytes = downloaded;
          publish();
        },
      });
      state = 'complete';
    } catch (caught: unknown) {
      if (caught instanceof EphemerisCancelledError) {
        state = 'cancelled';
      } else {
        state = 'failed';
        error = caught instanceof Error ? caught.message : String(caught);
        console.error('Ephemeris kernel download failed', caught);
      }
    } finally {
      running = null;
      signal.aborted = false;
      publish();
    }

    return status();
  }

  return {
    status,
    start(): Promise<EphemerisProgress> {
      running ??= run();
      return running;
    },
    cancel(): void {
      if (running) signal.aborted = true;
    },
    async resolvedPath(): Promise<string | null> {
      const verified = await verifyKernel(path);
      return verified.ok ? path : null;
    },
  };
}

export function registerEphemerisIpcHandlers(controller: EphemerisController): void {
  ipcMain.handle('ephemeris:status', (): Promise<EphemerisProgress> => controller.status());
  ipcMain.handle('ephemeris:start', (): Promise<EphemerisProgress> => controller.start());
  ipcMain.handle('ephemeris:cancel', (): Promise<EphemerisProgress> => {
    controller.cancel();
    return controller.status();
  });
}
