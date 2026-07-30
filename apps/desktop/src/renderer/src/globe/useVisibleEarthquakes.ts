import { useMemo } from 'react';
import { nextMagnitudeFloorAbove, type EarthquakeEvent } from '@terra-pulse/schema';
import { useEarthquakeStore } from '../state/useEarthquakeStore';
import { useNow } from './useNow';

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
  /**
   * Exclusive upper bound, when isolating a band rather than taking a floor.
   * `null` means no ceiling — the ordinary "everything at least this big".
   */
  maxMagnitudeExclusive: number | null = null,
): EarthquakeEvent[] {
  const cutoffMs = now - windowHours * 60 * 60 * 1000;

  return events.filter((event) => {
    if (event.magnitude < minMagnitude) return false;
    // Exclusive so adjacent bands tile without overlapping: an M2.5 belongs to
    // M2.5-4.5, never to M1-2.5 as well.
    if (maxMagnitudeExclusive !== null && event.magnitude >= maxMagnitudeExclusive) return false;
    const timeMs = Date.parse(event.timeUtc);
    // An unparseable timestamp can't be placed in the window, so it's
    // excluded rather than silently shown outside the range the user picked.
    return Number.isFinite(timeMs) && timeMs >= cutoffMs;
  });
}

/**
 * The whole window's events, regardless of playhead.
 *
 * The layer builds entities from this and then *shows or hides* them as the
 * playhead moves. Keeping the built set stable is the entire reason playback is
 * affordable: narrowing this array instead would rebuild every Cesium entity on
 * every tick.
 */
export function useVisibleEarthquakes(): EarthquakeEvent[] {
  const events = useEarthquakeStore((state) => state.events);
  const minMagnitude = useEarthquakeStore((state) => state.minMagnitude);
  const windowHours = useEarthquakeStore((state) => state.windowHours);
  const isolateBand = useEarthquakeStore((state) => state.isolateBand);
  // Through `useNow` rather than `Date.now()`. The window cutoff was already
  // reading the clock — via the default parameter, which hid it from both the
  // linter and from re-rendering — so the trailing edge of the window silently
  // froze until some unrelated state change happened to refresh it.
  const nowMs = useNow();

  return useMemo(() => {
    const ceiling = isolateBand ? nextMagnitudeFloorAbove(minMagnitude) : null;
    return filterEarthquakes(events, minMagnitude, windowHours, nowMs, ceiling);
  }, [events, minMagnitude, windowHours, isolateBand, nowMs]);
}

/**
 * Drops events later than the playhead. `null` means live — nothing is dropped.
 */
export function narrowToPlayhead(
  events: readonly EarthquakeEvent[],
  playheadMs: number | null,
): EarthquakeEvent[] {
  if (playheadMs === null) return events as EarthquakeEvent[];

  return events.filter((event) => {
    const timeMs = Date.parse(event.timeUtc);
    // Same rule as the window filter: an unplaceable timestamp is excluded
    // rather than shown at an instant it can't be pinned to.
    return Number.isFinite(timeMs) && timeMs <= playheadMs;
  });
}

/**
 * Events actually on screen right now — the window narrowed to the playhead.
 *
 * Separate from `useVisibleEarthquakes` because the two answer different
 * questions. That one asks "what did we build?", this asks "what can the user
 * see?", and during playback those diverge. Counts and the inspector want this
 * one; the layer wants the other.
 */
export function useEarthquakesUpToPlayhead(): EarthquakeEvent[] {
  const windowEvents = useVisibleEarthquakes();
  const playheadMs = useEarthquakeStore((state) => state.playheadMs);

  return useMemo(() => narrowToPlayhead(windowEvents, playheadMs), [windowEvents, playheadMs]);
}
