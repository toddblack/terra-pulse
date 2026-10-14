import { useEffect, useRef } from 'react';
import { useEarthquakeStore, viewStartMs } from '../state/useEarthquakeStore';

/**
 * How often the playhead is written to the store, in ms.
 *
 * Not every animation frame. The playhead drives a React render and a pass over
 * every earthquake entity, and at 60 Hz that's work nobody can perceive: a
 * 72-hour window is thousands of simulated hours wide, so 20 Hz already moves
 * the scrubber in sub-pixel steps. This is the difference between smooth
 * playback and a globe that stutters while it plays.
 */
const TICK_INTERVAL_MS = 50;

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Advances the playhead while playback is running.
 *
 * Uses `requestAnimationFrame` rather than `setInterval` so the loop stops when
 * the window is hidden — a paused-in-background tab shouldn't burn cycles
 * replaying a globe nobody is looking at — and so elapsed time is measured from
 * real timestamps instead of assuming the interval fired on schedule.
 */
export function usePlayback(): void {
  const isPlaying = useEarthquakeStore((state) => state.isPlaying);
  const playbackSpeed = useEarthquakeStore((state) => state.playbackSpeed);
  const windowHours = useEarthquakeStore((state) => state.windowHours);

  // Read through refs inside the loop: depending on them would tear down and
  // restart the animation on every tick, since the playhead changes constantly.
  const seek = useEarthquakeStore((state) => state.seek);
  const goLive = useEarthquakeStore((state) => state.goLive);
  const pause = useEarthquakeStore((state) => state.pause);
  const speedRef = useRef(playbackSpeed);
  const windowRef = useRef(windowHours);

  useEffect(() => {
    speedRef.current = playbackSpeed;
    windowRef.current = windowHours;
  }, [playbackSpeed, windowHours]);

  useEffect(() => {
    if (!isPlaying) return;

    let frame = 0;
    let lastTickAt = performance.now();

    const step = (frameTime: number) => {
      frame = requestAnimationFrame(step);

      const elapsed = frameTime - lastTickAt;
      if (elapsed < TICK_INTERVAL_MS) return;
      lastTickAt = frameTime;

      const { playheadMs, dateRange } = useEarthquakeStore.getState();
      const start = viewStartMs(windowRef.current, dateRange);
      const advanceMs = (elapsed / 1000) * speedRef.current * MS_PER_HOUR;
      const next = (playheadMs ?? start) + advanceMs;

      // A date range ends where it ends, not at the present. Stop there with
      // the whole range on screen — `goLive` would leave the range entirely,
      // which is not what reaching the end of a replay should do.
      if (dateRange !== null) {
        if (next >= dateRange.endMs) {
          seek(dateRange.endMs);
          pause();
          return;
        }
        seek(next);
        return;
      }

      // Reaching the present is the natural end of a replay. Handing control
      // back to live mode means the globe keeps updating from the poll rather
      // than freezing at a playhead that's now in the past.
      if (next >= Date.now()) {
        goLive();
        return;
      }

      seek(next);
    };

    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [isPlaying, seek, goLive, pause]);
}
