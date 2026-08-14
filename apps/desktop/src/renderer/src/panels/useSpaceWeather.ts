import { useEffect, useState } from 'react';
import type { SpaceWeatherSample } from '@terra-pulse/schema';

export type SpaceWeatherState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; samples: SpaceWeatherSample[] };

/**
 * Kp and Dst across a time range.
 *
 * Re-queries whenever the range changes, and when the rolling Kp poll stores
 * something new. The range is passed as epoch milliseconds rather than as an
 * object so the effect can depend on two numbers — a `{startMs, endMs}` object
 * would be a new identity every render and re-query continuously, which is the
 * shape of bug this project has hit twice already.
 */
export function useSpaceWeather(startMs: number, endMs: number): SpaceWeatherState {
  const [state, setState] = useState<SpaceWeatherState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      void window.terraPulse.spaceWeather
        .query({
          startUtc: new Date(startMs).toISOString(),
          endUtc: new Date(endMs).toISOString(),
        })
        .then(
          (samples) => {
            if (!cancelled) setState({ status: 'ready', samples });
          },
          (error: unknown) => {
            console.error('Failed to read space weather', error);
            if (!cancelled) setState({ status: 'error' });
          },
        );
    };

    load();
    const unsubscribe = window.terraPulse.spaceWeather.onUpdated(load);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [startMs, endMs]);

  return state;
}
