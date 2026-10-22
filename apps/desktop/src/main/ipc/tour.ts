import { ipcMain } from 'electron';
import type { TourStatus } from '@terra-pulse/schema';

/**
 * The first-run tour's two facts, kept in main: whether this is a fresh
 * install, and which version's tour was last finished or skipped. Which steps
 * to show is `tourStepsToShow` in the schema; this only remembers.
 */

/** In `app_state`. Absent means no tour has ever been finished or skipped. */
export const TOUR_SEEN_KEY = 'tour_seen_version';

export interface TourState {
  status: () => TourStatus;
  /** Records the current version as toured. Main's own version, never the renderer's. */
  markSeen: () => TourStatus;
}

export interface TourStateOptions {
  /**
   * No "seen through" watermark at startup — read **before** polling starts,
   * for the same reason `collectMissedEvents` is: the first poll fires
   * immediately and writes one, after which every install looks like an old
   * one. Captured once and never re-read.
   */
  freshInstall: boolean;
  currentVersion: string;
  readState: (key: string) => string | null;
  writeState: (key: string, value: string) => void;
}

export function createTourState(options: TourStateOptions): TourState {
  const { freshInstall, currentVersion, readState, writeState } = options;
  const status = (): TourStatus => ({ freshInstall, seenVersion: readState(TOUR_SEEN_KEY), currentVersion });
  return {
    status,
    markSeen() {
      writeState(TOUR_SEEN_KEY, currentVersion);
      return status();
    },
  };
}

/** Pulled by the renderer once the globe has drawn; nothing is pushed. */
export function registerTourHandlers(tour: TourState): void {
  ipcMain.handle('tour:status', (): TourStatus => tour.status());
  ipcMain.handle('tour:mark-seen', (): TourStatus => tour.markSeen());
}
