import { previousWindowHours } from '@terra-pulse/schema';
import { windowStartMs } from '../state/useEarthquakeStore';

/**
 * How far past "now" the live window's end is pushed.
 *
 * A poll can deliver an event whose timestamp is a little ahead of this
 * machine's clock — clock skew, or a revision landing before we notice the
 * minute turned. Without the margin such an event falls outside the window and
 * is silently hidden at exactly the moment it is most worth seeing. The
 * earthquake layer clamps back to now before measuring 24-hour recency, so the
 * margin doesn't drag the red-stroke boundary along with it.
 */
export const LIVE_END_MARGIN_MS = 60 * 60 * 1000;

export interface DisplayWindow {
  startMs: number;
  endMs: number;
}

/**
 * The span the globe is showing — the single definition of it.
 *
 * Two places need this and they are required to agree: the viewer hands it to
 * every layer's `setTimeWindow`, and `useEarthquakesUpToPlayhead` uses it to
 * decide what the event list and the legend's count contain. If they drift, the
 * app tells the user "7,671 events" over a globe drawing some other number,
 * which is worse than showing no count at all. They were separate expressions
 * that happened to match; now they cannot fail to.
 *
 * Live mode is a window whose end sits slightly in the future rather than a
 * special case, which keeps one code path instead of two.
 */
export function displayWindow(
  windowHours: number,
  playheadMs: number | null,
  trailingWindow: boolean,
  nowMs: number,
  /**
   * Applied to the end in live mode only. Callers that are *counting* pass 0:
   * the margin exists to stop a mark being hidden, and an event dated in the
   * future should not inflate a total.
   */
  endMarginMs = 0,
): DisplayWindow {
  const liveEndMs = playheadMs ?? nowMs;
  const trailHours = trailingWindow ? previousWindowHours(windowHours) : null;

  return {
    // A trailing window moves the *start* with the playhead instead of pinning
    // it to the span's beginning. It goes through `setTimeWindow` rather than
    // narrowing the built event set, because that is the cheap channel —
    // narrowing the set would rebuild every entity on every tick.
    //
    // Measured from `liveEndMs`, not from the margined end: the margin is there
    // to keep one fresh mark visible, and letting it shift the start too would
    // slide the whole span forward by an hour.
    startMs:
      trailHours === null
        ? windowStartMs(windowHours, nowMs)
        : liveEndMs - trailHours * 3_600_000,
    endMs: liveEndMs + (playheadMs === null ? endMarginMs : 0),
  };
}
