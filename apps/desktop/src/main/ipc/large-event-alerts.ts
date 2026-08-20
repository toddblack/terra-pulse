import type { EarthquakeEvent } from '@terra-pulse/schema';

/**
 * Deciding which arriving event, if any, is worth interrupting someone for.
 *
 * Pure and Electron-free so the rules can be tested directly — the traps here
 * are all about *which* event qualifies, not about how it's displayed.
 *
 * This is notification, not warning. It reports an earthquake that has already
 * happened and makes no forward claim. Early warning is impossible from this
 * input and is recorded as rejected in PROJECT_PLAN §11: USGS first-publish lag
 * is 78 s minimum / 222 s median, by which time the S-wave has covered
 * ~270–780 km.
 */

export interface AlertRules {
  minMagnitude: number;
  /**
   * How recent an event must be to be worth announcing.
   *
   * This exists for the first poll after launch. That poll pulls a 24-hour
   * feed, so an M6 from yesterday is new *to us* without being news — without
   * this bound, opening the app after a quiet morning would announce something
   * that happened while you were asleep as though it had just occurred.
   *
   * Stateless on purpose. The alternative — a "have we done the first poll yet"
   * flag — is a piece of state that has to be right, and gets it wrong after a
   * network blip retries the first poll.
   */
  maxAgeMs: number;
  nowMs: number;
  /**
   * Event ids already announced.
   *
   * Tracks *alerted*, not *seen*, and the distinction is load-bearing. USGS
   * revises magnitudes: an M5.8 that arrives below the threshold is never
   * recorded here, so when a later poll brings it back as M6.1 it is still
   * eligible. Recording everything seen would silently swallow exactly the
   * events that grew into being worth announcing.
   */
  alreadyAlerted: ReadonlySet<string>;
}

/**
 * The one event to announce from a batch, or `null`.
 *
 * **Called with the events a poll or refresh just fetched — never with a query
 * over stored events.** That is what makes the launch backfill incapable of
 * firing alerts: it simply isn't a source. The alternative, scanning the
 * catalogue for "large events we haven't alerted on", has to actively defend
 * against announcing every big earthquake of the past month on startup.
 *
 * Returns one event rather than a list because the UI holds a single alert
 * slot. When a batch contains several qualifying events the newest wins — it is
 * the one still unfolding, and a queue of historical alerts to click through is
 * worse than the most recent fact.
 */
export function selectAlert(
  events: readonly EarthquakeEvent[],
  rules: AlertRules,
): EarthquakeEvent | null {
  let best: EarthquakeEvent | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;

  for (const event of events) {
    if (event.magnitude < rules.minMagnitude) continue;
    if (rules.alreadyAlerted.has(event.id)) continue;

    const timeMs = Date.parse(event.timeUtc);
    // An event with no placeable time can't be shown to be recent, and
    // announcing it would be claiming a freshness we can't support.
    if (!Number.isFinite(timeMs)) continue;

    const ageMs = rules.nowMs - timeMs;
    if (ageMs > rules.maxAgeMs) continue;
    // Clock skew between USGS and this machine puts events a little in the
    // future. Those are the newest ones, not ones to discard.

    if (timeMs > bestMs) {
      best = event;
      bestMs = timeMs;
    }
  }

  return best;
}

export interface LargeEventAlerter {
  /** Feeds a freshly-fetched batch in. Returns what it announced, if anything. */
  consider(events: readonly EarthquakeEvent[]): EarthquakeEvent | null;
  /**
   * The announced-but-not-dismissed alert, for the renderer to ask for.
   *
   * **This exists because pushing alone loses the one that matters most.**
   * The poll fires immediately at launch, while the renderer only subscribes
   * inside a React effect after Cesium and the renderer bundle have loaded —
   * so main wins that race and `webContents.send` reaches nobody. The symptom
   * is precise and was found by hitting it: the OS notification appears (it is
   * emitted here in main) and the in-app banner does not.
   *
   * It fails in exactly the case the feature is for. `maxAgeMs` is four hours
   * so that opening the app shortly after a large event still announces it —
   * and that is the launch poll, the one poll guaranteed to lose the race.
   *
   * Same fix as `earthquakes:missed`, `aurora:latest` and
   * `magnetometer:latest`, all of which are pulled for their first read for
   * this reason: the renderer asks when it is ready, so there is no window in
   * which a send can arrive before anyone is listening. The push stays for
   * every later poll, when the renderer is demonstrably subscribed.
   */
  current(): EarthquakeEvent | null;
  /**
   * Clears the retained alert when the reader dismisses it.
   *
   * Required, not a nicety. The renderer's store is module-level and survives
   * `ExploreShell` unmounting, so switching to Analyze and back remounts the
   * shell and re-runs its pull. Without this, that pull would hand back an
   * alert the reader had already dismissed, and it would come back every time
   * they changed mode.
   *
   * Dismissing does **not** un-record the id in `alerted` — the event has been
   * announced, and dismissing means "I have seen this", not "show it to me
   * again on the next poll".
   */
  dismiss(): void;
}

/**
 * Stateful wrapper holding the already-alerted set for the life of the process.
 *
 * Not persisted to disk. A restart forgets what it announced, but `maxAgeMs`
 * bounds the damage to one repeat of something from the last hour — and the
 * cost of getting persistence subtly wrong (an alert that never fires again
 * because a stale row says it did) is worse than that.
 */
export function createLargeEventAlerter(
  rules: Omit<AlertRules, 'nowMs' | 'alreadyAlerted'> & {
    /** Fires once per announced event, before it is recorded as announced. */
    onAlert?: (event: EarthquakeEvent) => void;
  },
  now: () => number = () => Date.now(),
): LargeEventAlerter {
  const { onAlert, ...thresholds } = rules;
  const alerted = new Set<string>();
  let currentAlert: EarthquakeEvent | null = null;

  return {
    consider(events) {
      const found = selectAlert(events, {
        ...thresholds,
        nowMs: now(),
        alreadyAlerted: alerted,
      });

      if (found) {
        alerted.add(found.id);
        // Retained before notifying, for the same reason the id is: a throwing
        // listener must not be able to leave the alert un-fetchable either.
        currentAlert = found;
        // Recorded before notifying, so a throwing listener can't cause the
        // same event to be announced again on the next poll.
        onAlert?.(found);
      }
      return found;
    },

    current() {
      return currentAlert;
    },

    dismiss() {
      currentAlert = null;
    },
  };
}
