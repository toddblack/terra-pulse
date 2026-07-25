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
    };
  }
}
