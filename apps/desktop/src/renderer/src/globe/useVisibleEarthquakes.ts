import { useMemo } from 'react';
import type { EarthquakeEvent } from '@terra-pulse/schema';
import { useEarthquakeStore } from '../state/useEarthquakeStore';

/**
 * Narrows the canonical event set to the current magnitude floor and time
 * window.
 *
 * A projection rather than a query (PROJECT_PLAN §7.5 point 2: one in-memory
 * copy, all views derived from it). The store already holds the widest range
 * main ingests, so every selection is a subset — which is what makes changing
 * the range instant instead of an IPC round trip and a layer rebuild.
 */
export function filterEarthquakes(
  events: readonly EarthquakeEvent[],
  minMagnitude: number,
  windowHours: number,
  now: number = Date.now(),
): EarthquakeEvent[] {
  const cutoffMs = now - windowHours * 60 * 60 * 1000;

  return events.filter((event) => {
    if (event.magnitude < minMagnitude) return false;
    const timeMs = Date.parse(event.timeUtc);
    // An unparseable timestamp can't be placed in the window, so it's
    // excluded rather than silently shown outside the range the user picked.
    return Number.isFinite(timeMs) && timeMs >= cutoffMs;
  });
}

export function useVisibleEarthquakes(): EarthquakeEvent[] {
  const events = useEarthquakeStore((state) => state.events);
  const minMagnitude = useEarthquakeStore((state) => state.minMagnitude);
  const windowHours = useEarthquakeStore((state) => state.windowHours);

  return useMemo(
    () => filterEarthquakes(events, minMagnitude, windowHours),
    [events, minMagnitude, windowHours],
  );
}
