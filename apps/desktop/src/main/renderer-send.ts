import type { BrowserWindow } from 'electron';

/**
 * Pushes a message to the renderer, or does nothing if there is no renderer
 * left to receive it.
 *
 * **`window.isDestroyed()` alone is not a sufficient guard, and believing it
 * was shipped a crash dialog.** On quit Electron tears the `WebContents` down
 * *before* the `BrowserWindow` reports itself destroyed, so there is a window
 * — in both senses — where `mainWindow.isDestroyed()` is `false` while
 * `mainWindow.webContents.send()` throws `TypeError: Object has been
 * destroyed`. In the main process that is an uncaught exception, which
 * Electron shows as a modal error box on the way out.
 *
 * Every other push in this app happens on a timer or in reply to an IPC call,
 * so none of them is in flight while the renderer is being destroyed and none
 * ever hit this. The live waveform stream is the exception: it watches the
 * renderer's `WebContents` for `destroyed` precisely so the socket is closed
 * when the renderer goes away, and that handler necessarily runs *during*
 * teardown, emitting a status change as it stops.
 *
 * So the check has to be on the object `send` actually lives on.
 */
export function sendToRenderer(
  window: BrowserWindow | null,
  channel: string,
  payload?: unknown,
): boolean {
  if (window === null || window.isDestroyed() || window.webContents.isDestroyed()) return false;
  if (payload === undefined) window.webContents.send(channel);
  else window.webContents.send(channel, payload);
  return true;
}
