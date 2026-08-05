/// <reference types="vite/client" />

import type {
  ArchiveProgress,
  EarthquakeEvent,
  EarthquakeQuery,
  EarthquakeSyncResult,
  MissedEvents,
} from '@terra-pulse/schema';

export {};

declare global {
  interface Window {
    terraPulse: {
      earthquakes: {
        query(query?: EarthquakeQuery): Promise<EarthquakeEvent[]>;
        /** Polls USGS now. Returns the sync result, not the catalogue. */
        refresh(): Promise<EarthquakeSyncResult>;
        /** Subscribe to main's poll results; returns an unsubscribe function. */
        onUpdated(callback: (result: EarthquakeSyncResult) => void): () => void;
        /** Subscribe to large-event alerts; returns an unsubscribe function. */
        onLargeEvent(callback: (event: EarthquakeEvent) => void): () => void;
        /** What arrived while the app was closed, or null. Fixed at launch. */
        missed(): Promise<MissedEvents | null>;
      };
      archive: {
        status(): Promise<ArchiveProgress>;
        /** Settles when the whole backfill finishes — follow onProgress instead. */
        start(): Promise<ArchiveProgress>;
        cancel(): Promise<ArchiveProgress>;
        /** Subscribe to backfill progress; returns an unsubscribe function. */
        onProgress(callback: (progress: ArchiveProgress) => void): () => void;
      };
      shell: {
        /** Resolves false if main refused to open the URL. */
        openExternal(url: string): Promise<boolean>;
      };
    };
  }
}
