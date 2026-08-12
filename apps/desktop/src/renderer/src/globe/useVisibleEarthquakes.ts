import { useMemo } from 'react';
import { nextMagnitudeFloorAbove, type EarthquakeEvent } from '@terra-pulse/schema';
import { useEarthquakeStore } from '../state/useEarthquakeStore';
import { displayWindow } from './display-window';
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
  return filterEarthquakesFrom(
    events,
    minMagnitude,
    now - windowHours * 60 * 60 * 1000,
    maxMagnitudeExclusive,
  );
}

/**
 * The same filter expressed as an absolute cutoff rather than a duration back
 * from "now".
 *
 * This is the form the hook uses, because the cutoff it wants comes from the
 * store — the instant the query ran — not from a clock it reads itself.
 * `cutoffMs` of `null` applies no lower bound.
 */
export function filterEarthquakesFrom(
  events: readonly EarthquakeEvent[],
  minMagnitude: number,
  cutoffMs: number | null,
  maxMagnitudeExclusive: number | null = null,
): EarthquakeEvent[] {
  return events.filter((event) => {
    if (event.magnitude < minMagnitude) return false;
    // Exclusive so adjacent bands tile without overlapping: an M2.5 belongs to
    // M2.5-4.5, never to M1-2.5 as well.
    if (maxMagnitudeExclusive !== null && event.magnitude >= maxMagnitudeExclusive) return false;
    if (cutoffMs === null) return true;
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
 *
 * ## Why the cutoff comes from the store and not from `useNow`
 *
 * It used to come from `useNow`, and that quietly undid the paragraph above.
 * Every thirty seconds the clock advanced, this memo recomputed, and even
 * though the filtered *contents* were almost always identical the array got a
 * **new identity** — which is what `useGlobeLayers`' event-driven effect is
 * keyed on. So the earthquake layer tore down and rebuilt every entity twice a
 * minute, forever: 110 ms at 30d/M2.5, 590 ms in the widest archive view. It
 * was visible as the selection reticle re-playing its appear animation on a
 * thirty-second rhythm, because the rebuild re-adds the data source and the
 * selection has to be re-applied to the new entity.
 *
 * `loadedWindowStartMs` is the instant the query actually ran, so this changes
 * when the *data* changes and not when the clock moves. Between loads the built
 * set keeps a few events that have since aged past the window; they are
 * harmless because they are hidden — the layer's `setTimeWindow` still tracks
 * the live edge and only flips visibility flags, which is the cheap channel
 * this split exists to protect.
 */
export function useVisibleEarthquakes(): EarthquakeEvent[] {
  const events = useEarthquakeStore((state) => state.events);
  const minMagnitude = useEarthquakeStore((state) => state.minMagnitude);
  const isolateBand = useEarthquakeStore((state) => state.isolateBand);
  const loadedWindowStartMs = useEarthquakeStore((state) => state.loadedWindowStartMs);

  return useMemo(() => {
    const ceiling = isolateBand ? nextMagnitudeFloorAbove(minMagnitude) : null;
    return filterEarthquakesFrom(events, minMagnitude, loadedWindowStartMs, ceiling);
  }, [events, minMagnitude, loadedWindowStartMs, isolateBand]);
}

/**
 * Drops events later than the playhead, and — when a trailing window is in
 * effect — earlier than the trail's start.
 *
 * `playheadMs` of `null` means live, so nothing is dropped from the top.
 * `trailStartMs` of `null` means the window runs from its own beginning.
 */
export function narrowToPlayhead(
  events: readonly EarthquakeEvent[],
  playheadMs: number | null,
  trailStartMs: number | null = null,
): EarthquakeEvent[] {
  if (playheadMs === null && trailStartMs === null) return events as EarthquakeEvent[];

  return events.filter((event) => {
    const timeMs = Date.parse(event.timeUtc);
    // Same rule as the window filter: an unplaceable timestamp is excluded
    // rather than shown at an instant it can't be pinned to.
    if (!Number.isFinite(timeMs)) return false;
    if (playheadMs !== null && timeMs > playheadMs) return false;
    if (trailStartMs !== null && timeMs < trailStartMs) return false;
    return true;
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
  const windowHours = useEarthquakeStore((state) => state.windowHours);
  const trailingWindow = useEarthquakeStore((state) => state.trailingWindow);
  const nowMs = useNow();

  return useMemo(() => {
    // Mirrors the window the layer is given, so the footnote's count matches
    // what is actually drawn. A count claiming 26,746 while a decade's worth is
    // on screen would be worse than no count.
    //
    // **This is where the live trailing edge is applied now.** It used to be
    // inherited from `useVisibleEarthquakes`, which no longer tracks the clock
    // — so without it here the count and list would keep events the globe had
    // already hidden. Literally the same function the viewer hands to
    // `setTimeWindow`, so the two cannot drift.
    //
    // No end margin: that exists to keep a fresh mark from being hidden, and a
    // future-dated event should not inflate a count.
    const { startMs } = displayWindow(windowHours, playheadMs, trailingWindow, nowMs);

    return narrowToPlayhead(windowEvents, playheadMs, startMs);
  }, [windowEvents, playheadMs, windowHours, trailingWindow, nowMs]);
}
