import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { sendToRenderer } from './renderer-send';

/**
 * `windowDestroyed` and `contentsDestroyed` are deliberately separate, because
 * the whole point is that they disagree during teardown.
 */
function fakeWindow(options: { windowDestroyed?: boolean; contentsDestroyed?: boolean } = {}) {
  const send = vi.fn(() => {
    if (options.contentsDestroyed === true) {
      throw new TypeError('Object has been destroyed');
    }
  });
  const window = {
    isDestroyed: () => options.windowDestroyed ?? false,
    webContents: {
      isDestroyed: () => options.contentsDestroyed ?? false,
      send,
    },
  } as unknown as BrowserWindow;
  return { window, send };
}

describe('sendToRenderer', () => {
  it('sends when the renderer is alive', () => {
    const { window, send } = fakeWindow();
    expect(sendToRenderer(window, 'waveforms:status-changed', { running: true })).toBe(true);
    expect(send).toHaveBeenCalledWith('waveforms:status-changed', { running: true });
  });

  it('omits the payload argument when there is none', () => {
    const { window, send } = fakeWindow();
    sendToRenderer(window, 'space-weather:updated');
    expect(send).toHaveBeenCalledWith('space-weather:updated');
  });

  it('does nothing without a window', () => {
    expect(sendToRenderer(null, 'waveforms:segment', {})).toBe(false);
  });

  it('does nothing once the window is destroyed', () => {
    const { window, send } = fakeWindow({ windowDestroyed: true });
    expect(sendToRenderer(window, 'waveforms:segment', {})).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing when the WebContents is destroyed but the window is not — the teardown gap that crashed the app', () => {
    // On quit the WebContents goes first. Guarding only on the window lets
    // `send` through, and it throws an uncaught TypeError in the main process,
    // which Electron surfaces as a modal error box.
    const { window, send } = fakeWindow({ windowDestroyed: false, contentsDestroyed: true });
    expect(sendToRenderer(window, 'waveforms:status-changed', {})).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
