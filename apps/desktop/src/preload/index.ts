import { contextBridge, ipcRenderer } from 'electron';
import type {
  AftershockSequence,
  AntipodalWindow,
  ArchiveProgress,
  EarthquakeEvent,
  EarthquakeQuery,
  EarthquakeSyncResult,
  MissedEvents,
  RegionalRecurrence,
} from '@terra-pulse/schema';

// Narrow, specific functions — never a raw ipcRenderer passthrough
// (non-negotiable #6/§8: all IPC through an explicit minimal bridge).
contextBridge.exposeInMainWorld('terraPulse', {
  earthquakes: {
    query: (query: EarthquakeQuery = {}): Promise<EarthquakeEvent[]> =>
      ipcRenderer.invoke('earthquakes:query', query),
    // Returns the sync result, not the catalogue — the caller follows up with
    // its own windowed `query`, which is the only thing that knows what window
    // is on screen.
    refresh: (): Promise<EarthquakeSyncResult> => ipcRenderer.invoke('earthquakes:refresh'),

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

    /**
     * Fires when a poll or refresh brings in a large event worth announcing.
     * Never fires for the launch backfill — see PROJECT_PLAN §5.8.
     */
    onLargeEvent: (callback: (event: EarthquakeEvent) => void): (() => void) => {
      const listener = (_ipcEvent: unknown, quake: EarthquakeEvent) => {
        callback(quake);
      };
      ipcRenderer.on('earthquakes:large-event', listener);
      return () => {
        ipcRenderer.removeListener('earthquakes:large-event', listener);
      };
    },

    /**
     * What arrived while the app was shut, or null if nothing did.
     *
     * Pulled rather than pushed: main captures this once at startup and the
     * renderer asks when it is ready, so there is no window in which a send can
     * arrive before anyone is listening.
     */
    missed: (): Promise<MissedEvents | null> => ipcRenderer.invoke('earthquakes:missed'),

    /**
     * What actually followed an event, as observed (PROJECT_PLAN §5.9).
     *
     * Null when the id isn't in the catalogue. Pure observation — no forecast
     * crosses this bridge, which is what keeps it Explore-safe.
     */
    sequence: (eventId: string): Promise<AftershockSequence | null> =>
      ipcRenderer.invoke('earthquakes:sequence', eventId),

    /**
     * How often independent earthquakes have occurred near a point.
     *
     * The record starts where the catalogue becomes complete at the requested
     * floor — 1970 below M7.5, 1900 at or above it — and the result carries its
     * own `epochYear` so the caller never has to assume.
     *
     * Descriptive only: it reports gaps the catalogue recorded and never
     * extrapolates to the next one. See PROJECT_PLAN §5.11 for why neither 57
     * nor 126 years can speak to whether anywhere is "overdue".
     */
    recurrence: (request: {
      latitude: number;
      longitude: number;
      radiusKm: number;
      minMagnitude: number;
    }): Promise<RegionalRecurrence> => ipcRenderer.invoke('earthquakes:recurrence', request),

    /**
     * What the catalogue recorded near an event's antipode (PROJECT_PLAN §5.3).
     *
     * Observation, with the antipode's background rate attached so the result
     * cannot be read as evidence on its own. The registered H5 test is separate.
     */
    antipodal: (eventId: string): Promise<AntipodalWindow | null> =>
      ipcRenderer.invoke('earthquakes:antipodal', eventId),
  },
  archive: {
    status: (): Promise<ArchiveProgress> => ipcRenderer.invoke('archive:status'),
    // Resolves when the whole backfill settles — minutes, not milliseconds.
    // The UI follows `onProgress` and doesn't await this.
    start: (): Promise<ArchiveProgress> => ipcRenderer.invoke('archive:start'),
    cancel: (): Promise<ArchiveProgress> => ipcRenderer.invoke('archive:cancel'),

    onProgress: (callback: (progress: ArchiveProgress) => void): (() => void) => {
      const listener = (_event: unknown, progress: ArchiveProgress) => {
        callback(progress);
      };
      ipcRenderer.on('archive:progress', listener);
      return () => {
        ipcRenderer.removeListener('archive:progress', listener);
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
