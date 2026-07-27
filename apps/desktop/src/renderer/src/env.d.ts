/// <reference types="vite/client" />

import type { EarthquakeEvent, EarthquakeQuery } from '@terra-pulse/schema';

export {};

declare global {
  interface Window {
    terraPulse: {
      earthquakes: {
        query(query?: EarthquakeQuery): Promise<EarthquakeEvent[]>;
        refresh(): Promise<EarthquakeEvent[]>;
      };
      shell: {
        /** Resolves false if main refused to open the URL. */
        openExternal(url: string): Promise<boolean>;
      };
    };
  }
}
