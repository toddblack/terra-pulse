import { useEffect, useState } from 'react';
import type { CmeArrival, SolarFlare } from '@terra-pulse/schema';

export interface SolarEventsState {
  flares: SolarFlare[];
  cmeArrivals: CmeArrival[];
}

const EMPTY: SolarEventsState = { flares: [], cmeArrivals: [] };

/**
 * Flares and CME arrivals across the current display window, for the two
 * DONKI marker layers.
 *
 * Same shape as `useSpaceWeather`: re-queries whenever the range changes and
 * when the live poll stores something new. The range is two epoch
 * milliseconds rather than a `{startMs, endMs}` object so the effect depends
 * on primitives — an object would be a new identity every render and
 * re-query continuously, the exact bug class `CLAUDE.md` documents twice over
 * for this codebase.
 *
 * Both endpoints are queried together and settle independently: one being
 * slow or empty must not hold the other back, the same reasoning
 * `startDonkiPolling` uses for the live poll.
 */
export function useSolarEvents(startMs: number, endMs: number): SolarEventsState {
  const [state, setState] = useState<SolarEventsState>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    const startUtc = new Date(startMs).toISOString();
    const endUtc = new Date(endMs).toISOString();

    const load = () => {
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
  }, [startMs, endMs]);

  return state;
}
