import { ipcMain } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import { insertEarthquakes, queryEarthquakes, type EarthquakeQuery } from '@terra-pulse/db';
import { fetchRecentEarthquakes } from '@terra-pulse/ingest';
import type { EarthquakeEvent } from '@terra-pulse/schema';

const SEVENTY_TWO_HOURS_MS = 72 * 60 * 60 * 1000;
const DEFAULT_MIN_MAGNITUDE = 2.5;

async function refreshEarthquakes(db: DatabaseSync): Promise<EarthquakeEvent[]> {
  const endUtc = new Date();
  const startUtc = new Date(endUtc.getTime() - SEVENTY_TWO_HOURS_MS);
  const events = await fetchRecentEarthquakes({
    startUtc,
    endUtc,
    minMagnitude: DEFAULT_MIN_MAGNITUDE,
  });
  insertEarthquakes(db, events);
  return events;
}

export function registerEarthquakeIpcHandlers(db: DatabaseSync): void {
  ipcMain.handle('earthquakes:query', (_event, query: EarthquakeQuery = {}): EarthquakeEvent[] => {
    return queryEarthquakes(db, query);
  });

  ipcMain.handle('earthquakes:refresh', (): Promise<EarthquakeEvent[]> => refreshEarthquakes(db));
}

// Exported separately from the IPC registration so main/index.ts can call it
// directly on startup (populate if empty) without going through IPC itself.
export { refreshEarthquakes };
