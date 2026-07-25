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
});
