import { useEffect, useState } from 'react';

/**
 * The current time as a value that actually changes, rather than a clock read
 * during render.
 *
 * Several things here need "now": the live end of the display window, the
 * scrubber's track endpoint, the freshness label. Calling `Date.now()` inline
 * looks simpler and is wrong twice over — it makes render impure, and because
 * nothing re-renders when a clock ticks, the value silently goes stale until
 * some unrelated state change happens to refresh it. Both call sites had
 * accumulated a fake dependency to force recomputation, which is the symptom.
 *
 * The default cadence is deliberately coarse. Nothing on screen resolves finer
 * than a minute, so ticking faster would re-render the app for no visible gain.
 */
export function useNow(intervalMs = 30_000): number {
  // Lazy initializer, so the clock is read once on mount rather than on every
  // render.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs]);

  return now;
}
