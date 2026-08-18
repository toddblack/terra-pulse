import { useEffect, useState } from 'react';
import type { CmeArrival, SolarFlare } from '@terra-pulse/schema';

export interface SolarEventsState {
  flares: SolarFlare[];
  cmeArrivals: CmeArrival[];
}

const EMPTY: SolarEventsState = { flares: [], cmeArrivals: [] };

/** The half-open UTC range one span selection queries. Pure so it's directly testable. */
export function solarEventsQueryRange(
  windowHours: number,
  nowMs: number,
): { startUtc: string; endUtc: string } {
  return {
    startUtc: new Date(nowMs - windowHours * 3_600_000).toISOString(),
    endUtc: new Date(nowMs).toISOString(),
  };
}

/**
 * Flares and CME arrivals across the currently selected span, for the two
 * DONKI marker layers.
 *
 * ## Queries the whole selected span, not the live playhead window
 *
 * An earlier version took `startMs`/`endMs` from the live, playhead-tracking
 * display window and re-queried on every change to it — which during
 * playback is up to twenty times a second. Every tick fired a fresh IPC
 * round-trip *and*, downstream, a full Cesium entity rebuild (`removeAll` +
 * re-add). This is the exact "built set stable, visibility live" mistake the
 * earthquake layer already paid for once — see CLAUDE.md's "30-second
 * rebuild" postmortem. `windowHours` is the one thing that should trigger a
 * requery: it only changes when the user actually picks a different span.
 * The live edge (including the trailing-window narrowing) reaches the Cesium
 * layers separately, through `setTimeWindow`, which only flips a `show` flag
 * per entity — the same split `loadedWindowStartMs` and `setTimeWindow` give
 * the earthquake layer.
 *
 * `startMs`/`endMs` are computed *inside* `load()`, from `Date.now()` at call
 * time, rather than taken as reactive props — same reason
 * `useEarthquakeStore`'s `load()` uses `windowStartMs(windowHours)`'s
 * `Date.now()` default rather than a value threaded in from a ticking clock:
 * it keeps this effect from re-running just because time passed.
 *
 * Both endpoints are queried together and settle independently: one being
 * slow or empty must not hold the other back, the same reasoning
 * `startDonkiPolling` uses for the live poll.
 */
export function useSolarEvents(windowHours: number): SolarEventsState {
  const [state, setState] = useState<SolarEventsState>(EMPTY);

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      const { startUtc, endUtc } = solarEventsQueryRange(windowHours, Date.now());

      void window.terraPulse.solarEvents.queryFlares({ startUtc, endUtc }).then(
        (flares) => {
          if (!cancelled) setState((prev) => ({ ...prev, flares }));
        },
        (error: unknown) => {
          console.error('Failed to read solar flares', error);
        },
      );

      void window.terraPulse.solarEvents.queryCmeArrivals({ startUtc, endUtc }).then(
        (cmeArrivals) => {
          if (!cancelled) setState((prev) => ({ ...prev, cmeArrivals }));
        },
        (error: unknown) => {
          console.error('Failed to read CME arrivals', error);
        },
      );
    };

    load();
    const unsubscribe = window.terraPulse.solarEvents.onUpdated(load);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [windowHours]);

  return state;
}
