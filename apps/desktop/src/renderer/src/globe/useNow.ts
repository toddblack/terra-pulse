import { useSyncExternalStore } from 'react';

/**
 * How often the shared clock advances.
 *
 * Deliberately coarse: nothing on screen resolves finer than a minute, so
 * ticking faster would re-render the app for no visible gain.
 */
export const CLOCK_INTERVAL_MS = 30_000;

/**
 * One clock for the whole app, rather than one per caller.
 *
 * `useNow` used to own a `setInterval` per call site, and there are seven of
 * them — the viewer's window, both event projections, the scrubber, the range
 * controls, the alert banner, the missed-events panel. That is seven timers at
 * seven arbitrary phases, so the app woke and re-rendered roughly every four
 * seconds in staggered bursts instead of once every thirty. Sharing one ticker
 * also means every consumer sees the *same* instant, which matters as soon as
 * two of them compare their answers — the event count and the marks on the
 * globe are supposed to agree exactly.
 */
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
  subscribers.add(onStoreChange);

  if (timer === null) {
    // The shared value stops advancing while nothing is subscribed, so refresh
    // it here rather than serving whatever it held when the last consumer
    // unmounted.
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of subscribers) notify();
    }, CLOCK_INTERVAL_MS);
  }

  return () => {
    subscribers.delete(onStoreChange);
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return now;
}

/**
 * The current time as a value that actually changes, rather than a clock read
 * during render.
 *
 * Several things here need "now": the live end of the display window, the
 * scrubber's track endpoint, the freshness label. Calling `Date.now()` inline
 * looks simpler and is wrong twice over — it makes render impure, and because
 * nothing re-renders when a clock ticks, the value silently goes stale until
 * some unrelated state change happens to refresh it.
 *
 * **Whatever this feeds must be on a cheap path.** Anything keyed on it re-runs
 * every thirty seconds, forever, for as long as the app is open. That is how
 * the earthquake layer ended up rebuilding all of its entities twice a minute —
 * see the note on `useVisibleEarthquakes`.
 */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
