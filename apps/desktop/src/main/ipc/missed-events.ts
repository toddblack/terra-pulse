import { ipcMain } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import {
  countMissedEarthquakes,
  queryMissedEarthquakes,
  readSeenThrough,
  writeSeenThrough,
} from '@terra-pulse/db';
import {
  ALERT_MIN_MAGNITUDE,
  MISSED_EVENTS_LIMIT,
  type MissedEvents,
} from '@terra-pulse/schema';

/**
 * "What did I miss while the app was closed" — PROJECT_PLAN §5.8.
 *
 * The passive counterpart to the alert. An alert interrupts and claims *this
 * just happened*, so it carries a one-hour freshness bound; this is a digest
 * you choose to read, so it has none and covers however long you were away.
 *
 * Same magnitude threshold as the alert, deliberately: "notable" should mean
 * one thing in this app, and two numbers would have to be kept in agreement by
 * hand for no gain.
 */

/**
 * Computed **before** the first poll advances the watermark.
 *
 * Order matters and is easy to get backwards: `startEarthquakePolling` now
 * fires immediately, and that poll writes a new seen-through timestamp. Reading
 * this afterwards would compare "now" against "now" and report that nothing was
 * missed, every single launch.
 *
 * Returns `null` when there is nothing to show, which covers two distinct
 * cases that both mean "no digest": a first-ever launch with no watermark (you
 * cannot have missed anything yet), and a quiet absence.
 */
export function collectMissedEvents(db: DatabaseSync): MissedEvents | null {
  const sinceUtc = readSeenThrough(db);
  if (sinceUtc === null) return null;

  const totalCount = countMissedEarthquakes(db, sinceUtc, ALERT_MIN_MAGNITUDE);
  if (totalCount === 0) return null;

  return {
    events: queryMissedEarthquakes(db, sinceUtc, ALERT_MIN_MAGNITUDE, MISSED_EVENTS_LIMIT),
    totalCount,
    sinceUtc,
  };
}

/**
 * Moves the watermark to now.
 *
 * Called on every successful poll rather than on quit. A crash or a force-quit
 * then costs at most one poll interval, where a quit-time write would replay a
 * whole session as "missed" — and the digest exists precisely for people who
 * were not there to close the app tidily.
 */
export function markSeenThrough(db: DatabaseSync, at: Date = new Date()): void {
  writeSeenThrough(db, at.toISOString());
}

/**
 * Serves the launch digest on request, rather than pushing it.
 *
 * **This has to be a pull, and the first version got it wrong.** Pushing on
 * `did-finish-load` looks right — the page has loaded, so surely someone is
 * listening — but the renderer subscribes inside a React effect, which runs
 * after mount and after paint. `ipcRenderer.on` does not buffer, so a send that
 * lands first is not late, it is *gone*, and the panel never appears. Nothing
 * errors; you just never see the feature.
 *
 * The value is captured once at startup and handed out unchanged, because it
 * cannot be recomputed later: the first poll fires immediately and moves the
 * seen-through watermark, so a fresh `collectMissedEvents` a second afterwards
 * compares now against now and returns nothing.
 */
export function registerMissedEventsHandler(missedAtLaunch: MissedEvents | null): void {
  ipcMain.handle('earthquakes:missed', (): MissedEvents | null => missedAtLaunch);
}
