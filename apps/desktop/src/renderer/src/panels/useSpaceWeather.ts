import { useEffect, useMemo, useState } from 'react';
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

/**
 * The solar wind in the hour containing an instant, or null.
 *
 * The **containing hour only** — deliberately not "the most recent reading
 * before this instant". Carrying a value forward across a gap would draw a
 * magnetopause from conditions that were measured hours or years earlier and
 * present it as current, which is the one thing the coverage work exists to
 * prevent. Null is an ordinary answer here: the wind is 32-42% present across
 * 1985-1994 and absent entirely before 1963.
 */
export function useSolarWindAt(
  atMs: number,
): { windSpeed: number | null; density: number | null; bzGsm: number | null } | null {
  const hourStartMs = Math.floor(atMs / 3_600_000) * 3_600_000;
  const state = useSpaceWeather(hourStartMs, hourStartMs + 3_600_000);

  // Memoised on the query result, not on `atMs`: a fresh object every render
  // would re-run the layer push effect continuously, which is the identity trap
  // this codebase has hit more than once.
  return useMemo(() => {
    if (state.status !== 'ready') return null;
    const sample = state.samples.at(-1);
    if (!sample) return null;
    return { windSpeed: sample.windSpeed, density: sample.density, bzGsm: sample.bzGsm };
  }, [state]);
}
