/// <reference types="vite/client" />

import type {
  EarthquakeEvent,
  EarthquakeQuery,
  EarthquakeSyncResult,
} from '@terra-pulse/schema';

export {};

declare global {
  interface Window {
    terraPulse: {
      earthquakes: {
        query(query?: EarthquakeQuery): Promise<EarthquakeEvent[]>;
        refresh(): Promise<EarthquakeEvent[]>;
        /** Subscribe to main's poll results; returns an unsubscribe function. */
        onUpdated(callback: (result: EarthquakeSyncResult) => void): () => void;
      };
      shell: {
        /** Resolves false if main refused to open the URL. */
        openExternal(url: string): Promise<boolean>;
      };
    };
  }
}
