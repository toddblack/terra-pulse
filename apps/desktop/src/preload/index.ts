import { contextBridge, ipcRenderer } from 'electron';
import type { EarthquakeEvent, EarthquakeQuery, EarthquakeSyncResult } from '@terra-pulse/schema';

// Narrow, specific functions — never a raw ipcRenderer passthrough
// (non-negotiable #6/§8: all IPC through an explicit minimal bridge).
contextBridge.exposeInMainWorld('terraPulse', {
  earthquakes: {
    query: (query: EarthquakeQuery = {}): Promise<EarthquakeEvent[]> =>
      ipcRenderer.invoke('earthquakes:query', query),
    refresh: (): Promise<EarthquakeEvent[]> => ipcRenderer.invoke('earthquakes:refresh'),

    /**
     * Subscribes to main's poll results. Returns an unsubscribe function.
     *
     * The Electron event object is deliberately dropped rather than forwarded
     * — it carries `sender`, which would hand the renderer a handle back into
     * the main process and defeat the point of the bridge.
     */
    onUpdated: (callback: (result: EarthquakeSyncResult) => void): (() => void) => {
      const listener = (_event: unknown, result: EarthquakeSyncResult) => {
        callback(result);
      };
      ipcRenderer.on('earthquakes:updated', listener);
      return () => {
        ipcRenderer.removeListener('earthquakes:updated', listener);
      };
    },
  },
  shell: {
    // Resolves false if main refused the URL. The allowlist lives in main
    // (ipc/external-links.ts) — the renderer can ask, but doesn't decide.
    openExternal: (url: string): Promise<boolean> =>
      ipcRenderer.invoke('shell:open-external', url),
  },
});
