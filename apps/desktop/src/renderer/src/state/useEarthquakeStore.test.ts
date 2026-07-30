import { beforeEach, describe, expect, it } from 'vitest';
import { MAGNITUDE_FLOORS, minMagnitudeForWindow } from '@terra-pulse/schema';
import {
  DEFAULT_MIN_MAGNITUDE,
  DEFAULT_PLAYBACK_SPEED,
  DEFAULT_WINDOW_HOURS,
  useEarthquakeStore,
  windowStartMs,
} from './useEarthquakeStore';

beforeEach(() => {
  useEarthquakeStore.setState({
    selectedEventId: null,
    focusRequest: null,
    minMagnitude: DEFAULT_MIN_MAGNITUDE,
    windowHours: DEFAULT_WINDOW_HOURS,
    playheadMs: null,
    isPlaying: false,
    playbackSpeed: DEFAULT_PLAYBACK_SPEED,
  });
});

describe('magnitude floor follows the span', () => {
  it('raises the floor when a span was not ingested that deep', () => {
    // 30 days is only stored from M2.5 up. Keeping M1 would empty the globe,
    // which reads as a quiet month rather than as data never fetched.
    useEarthquakeStore.getState().setMinMagnitude(1);
    useEarthquakeStore.getState().setWindowHours(720);

    expect(useEarthquakeStore.getState().minMagnitude).toBe(
      minMagnitudeForWindow(720),
    );
  });

  it('leaves a stricter floor alone', () => {
    // Never lowered — that would undo a deliberate choice.
    useEarthquakeStore.getState().setMinMagnitude(5.5);
    useEarthquakeStore.getState().setWindowHours(720);

    expect(useEarthquakeStore.getState().minMagnitude).toBe(5.5);
  });

  it('does not lower the floor again on the way back down', () => {
    useEarthquakeStore.getState().setMinMagnitude(1);
    useEarthquakeStore.getState().setWindowHours(720);
    useEarthquakeStore.getState().setWindowHours(24);

    // 24h holds M1, but the user never asked to go back — they'd have to.
    expect(useEarthquakeStore.getState().minMagnitude).toBe(minMagnitudeForWindow(720));
  });

  it('leaves every default view internally consistent', () => {
    expect(DEFAULT_MIN_MAGNITUDE).toBeGreaterThanOrEqual(
      minMagnitudeForWindow(DEFAULT_WINDOW_HOURS),
    );
    expect(MAGNITUDE_FLOORS).toContain(DEFAULT_MIN_MAGNITUDE);
  });
});

describe('windowStartMs', () => {
  it('reaches back by the window length', () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    expect(windowStartMs(24, now)).toBe(Date.parse('2026-07-28T12:00:00Z'));
  });
});

describe('playback', () => {
  it('starts live, not playing', () => {
    const state = useEarthquakeStore.getState();
    expect(state.playheadMs).toBeNull();
    expect(state.isPlaying).toBe(false);
  });

  it('rewinds to the start of the window when played from live', () => {
    // Playing from live would mean playing from the end, which finishes
    // instantly and looks broken.
    useEarthquakeStore.getState().play();

    const state = useEarthquakeStore.getState();
    expect(state.isPlaying).toBe(true);
    expect(state.playheadMs).not.toBeNull();
    expect(state.playheadMs!).toBeLessThan(Date.now());
  });

  it('resumes from where it was paused rather than rewinding', () => {
    const midway = Date.now() - 10 * 60 * 60 * 1000;
    useEarthquakeStore.getState().seek(midway);
    useEarthquakeStore.getState().pause();

    useEarthquakeStore.getState().play();

    expect(useEarthquakeStore.getState().playheadMs).toBe(midway);
  });

  it('stops playing on pause but holds its position', () => {
    useEarthquakeStore.getState().play();
    const held = useEarthquakeStore.getState().playheadMs;

    useEarthquakeStore.getState().pause();

    expect(useEarthquakeStore.getState().isPlaying).toBe(false);
    expect(useEarthquakeStore.getState().playheadMs).toBe(held);
  });

  it('returns to live and stops playing on goLive', () => {
    useEarthquakeStore.getState().play();
    useEarthquakeStore.getState().goLive();

    const state = useEarthquakeStore.getState();
    expect(state.playheadMs).toBeNull();
    expect(state.isPlaying).toBe(false);
  });

  it('seeks without starting or stopping playback', () => {
    useEarthquakeStore.getState().play();
    const target = Date.now() - 5 * 60 * 60 * 1000;

    useEarthquakeStore.getState().seek(target);

    expect(useEarthquakeStore.getState().playheadMs).toBe(target);
    expect(useEarthquakeStore.getState().isPlaying).toBe(true);
  });

  it('clears the selection when starting playback', () => {
    // At the start of a replay the selected event hasn't happened yet, so a
    // panel describing it would be describing the future.
    useEarthquakeStore.getState().select('quake-1');
    useEarthquakeStore.getState().play();

    expect(useEarthquakeStore.getState().selectedEventId).toBeNull();
  });

  it('clears the selection when scrubbing', () => {
    useEarthquakeStore.getState().select('quake-1');
    useEarthquakeStore.getState().seek(Date.now() - 3600_000);

    expect(useEarthquakeStore.getState().selectedEventId).toBeNull();
  });

  it('drops out of playback when the window length changes', () => {
    // The playhead is an absolute instant, so resizing the window can leave it
    // outside the range entirely.
    useEarthquakeStore.getState().play();
    useEarthquakeStore.getState().setWindowHours(24);

    const state = useEarthquakeStore.getState();
    expect(state.playheadMs).toBeNull();
    expect(state.isPlaying).toBe(false);
  });

  it('keeps the playhead when only the magnitude floor changes', () => {
    // Magnitude doesn't move the timeline, so a replay in progress survives it.
    const target = Date.now() - 8 * 60 * 60 * 1000;
    useEarthquakeStore.getState().seek(target);
    useEarthquakeStore.getState().setMinMagnitude(5);

    expect(useEarthquakeStore.getState().playheadMs).toBe(target);
  });

  it('changes speed without disturbing the playhead', () => {
    const target = Date.now() - 8 * 60 * 60 * 1000;
    useEarthquakeStore.getState().seek(target);
    useEarthquakeStore.getState().setPlaybackSpeed(24);

    expect(useEarthquakeStore.getState().playbackSpeed).toBe(24);
    expect(useEarthquakeStore.getState().playheadMs).toBe(target);
  });
});

describe('display filters clear the selection', () => {
  it('clears the selected event when the magnitude floor changes', () => {
    useEarthquakeStore.getState().select('quake-1');
    expect(useEarthquakeStore.getState().selectedEventId).toBe('quake-1');

    useEarthquakeStore.getState().setMinMagnitude(5.5);

    expect(useEarthquakeStore.getState().selectedEventId).toBeNull();
    expect(useEarthquakeStore.getState().minMagnitude).toBe(5.5);
  });

  it('clears the selected event when the time window changes', () => {
    useEarthquakeStore.getState().select('quake-1');
    useEarthquakeStore.getState().setWindowHours(24);

    expect(useEarthquakeStore.getState().selectedEventId).toBeNull();
    expect(useEarthquakeStore.getState().windowHours).toBe(24);
  });

  it('clears unconditionally, even for a selection still in range', () => {
    // Deliberate. Clearing only when the selected event drops out of range
    // would be smarter but unpredictable — the same action would sometimes
    // close the panel and sometimes not, which reads as a glitch.
    useEarthquakeStore.getState().select('big-quake');
    useEarthquakeStore.getState().setMinMagnitude(2);

    expect(useEarthquakeStore.getState().selectedEventId).toBeNull();
  });

  it('does not request a camera move when clearing', () => {
    // The whole point is to close a stale panel. If clearing parked a focus
    // request, changing the filter would fly the globe somewhere — which is
    // the bug this pairs with, not a second copy of it.
    useEarthquakeStore.getState().select('quake-1');
    const before = useEarthquakeStore.getState().focusRequest;

    useEarthquakeStore.getState().setMinMagnitude(3);

    expect(useEarthquakeStore.getState().focusRequest).toBe(before);
  });
});

describe('select', () => {
  it('records the selection and requests focus', () => {
    useEarthquakeStore.getState().select('quake-1');

    const state = useEarthquakeStore.getState();
    expect(state.selectedEventId).toBe('quake-1');
    expect(state.focusRequest?.eventId).toBe('quake-1');
  });

  it('bumps the nonce so re-picking the same event still flies there', () => {
    useEarthquakeStore.getState().select('quake-1');
    const first = useEarthquakeStore.getState().focusRequest?.nonce ?? 0;

    useEarthquakeStore.getState().select('quake-1');

    expect(useEarthquakeStore.getState().focusRequest?.nonce).toBeGreaterThan(first);
  });

  it('leaves the camera where it is when deselecting', () => {
    // Yanking the view around on a dismiss would be worse than leaving it
    // where the user last put it.
    useEarthquakeStore.getState().select('quake-1');
    const parked = useEarthquakeStore.getState().focusRequest;

    useEarthquakeStore.getState().select(null);

    expect(useEarthquakeStore.getState().selectedEventId).toBeNull();
    expect(useEarthquakeStore.getState().focusRequest).toBe(parked);
  });
});
