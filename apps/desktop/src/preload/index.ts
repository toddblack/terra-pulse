import { contextBridge, ipcRenderer } from 'electron';
import type { EarthquakeEvent, EarthquakeQuery } from '@terra-pulse/schema';

// Narrow, specific functions — never a raw ipcRenderer passthrough
// (non-negotiable #6/§8: all IPC through an explicit minimal bridge).
contextBridge.exposeInMainWorld('terraPulse', {
  earthquakes: {
    query: (query: EarthquakeQuery = {}): Promise<EarthquakeEvent[]> =>
      ipcRenderer.invoke('earthquakes:query', query),
    refresh: (): Promise<EarthquakeEvent[]> => ipcRenderer.invoke('earthquakes:refresh'),
  },
  shell: {
    // Resolves false if main refused the URL. The allowlist lives in main
    // (ipc/external-links.ts) — the renderer can ask, but doesn't decide.
    openExternal: (url: string): Promise<boolean> =>
      ipcRenderer.invoke('shell:open-external', url),
  },
});
