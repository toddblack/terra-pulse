import { beforeEach, describe, expect, it } from 'vitest';
import {
  ARCHIVE_SPANS,
  MAGNITUDE_FLOORS,
  archiveSpanHours,
  minMagnitudeForWindow,
} from '@terra-pulse/schema';
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
    trailingWindow: false,
    preArchiveView: null,
    activeAlert: null,
    antipodeEventId: null,
  });
});

describe('antipode mode', () => {
  it('selects the event too, so the exit control stays reachable', () => {
    // The toggle lives in the inspector, and the inspector only renders for a
    // selected event. Entering the mode without selecting would hide the only
    // button that leaves it.
    useEarthquakeStore.getState().showAntipode('quake-1');

    const state = useEarthquakeStore.getState();
    expect(state.antipodeEventId).toBe('quake-1');
    expect(state.selectedEventId).toBe('quake-1');
  });

  it('flies to the event when entering', () => {
    useEarthquakeStore.getState().showAntipode('quake-1');

    expect(useEarthquakeStore.getState().focusRequest?.eventId).toBe('quake-1');
  });

  it('leaves the selection alone when exiting', () => {
    // Exiting the mode is not the same as dismissing the event — you may well
    // want to keep reading the inspector.
    useEarthquakeStore.getState().showAntipode('quake-1');
    useEarthquakeStore.getState().hideAntipode();

    const state = useEarthquakeStore.getState();
    expect(state.antipodeEventId).toBeNull();
    expect(state.selectedEventId).toBe('quake-1');
  });

  it('clears when the magnitude floor changes', () => {
    // The chord's event can drop out of the view entirely, and a line pointing
    // at a mark that is no longer drawn is worse than no line.
    useEarthquakeStore.getState().showAntipode('quake-1');
    useEarthquakeStore.getState().setMinMagnitude(5.5);

    expect(useEarthquakeStore.getState().antipodeEventId).toBeNull();
  });

  it('clears when the window changes', () => {
    useEarthquakeStore.getState().showAntipode('quake-1');
    useEarthquakeStore.getState().setWindowHours(720);

    expect(useEarthquakeStore.getState().antipodeEventId).toBeNull();
  });

  it('survives selecting a different event', () => {
    // Deliberate: the chord is keyed to its own event id, not to whatever is
    // selected, so clicking around does not silently tear the mode down.
    useEarthquakeStore.getState().showAntipode('quake-1');
    useEarthquakeStore.getState().select('quake-2');

    expect(useEarthquakeStore.getState().antipodeEventId).toBe('quake-1');
  });
});

describe('large-event alerts', () => {
  const quake = {
    id: 'us7000big',
    source: 'usgs',
    magnitude: 6.8,
    magnitudeType: 'mww',
    place: 'Somewhere',
    timeUtc: '2026-07-29T11:55:00.000Z',
    updatedUtc: '2026-07-29T11:58:00.000Z',
    longitude: 140.1,
    latitude: 35.7,
    depthKm: 30,
    status: 'reviewed',
    tsunami: false,
    alertLevel: null,
    significance: 800,
    url: 'https://example.test',
  } as const;

  it('holds one alert at a time, newest wins', () => {
    // A queue of alerts to click through would be worse than the most recent
    // fact; the newer event is the one still unfolding.
    useEarthquakeStore.getState().announceLargeEvent(quake);
    useEarthquakeStore.getState().announceLargeEvent({ ...quake, id: 'newer', magnitude: 7.1 });

    expect(useEarthquakeStore.getState().activeAlert?.id).toBe('newer');
  });

  it('clears on dismiss', () => {
    useEarthquakeStore.getState().announceLargeEvent(quake);
    useEarthquakeStore.getState().dismissAlert();

    expect(useEarthquakeStore.getState().activeAlert).toBeNull();
  });

  it('does not move the camera on its own', () => {
    // The banner is click-to-fly. An alert that flew the camera by itself would
    // yank the view out from under someone mid-investigation, and the
    // focusRequest nonce is meant to be the only thing that moves it.
    const before = useEarthquakeStore.getState().focusRequest;

    useEarthquakeStore.getState().announceLargeEvent(quake);

    expect(useEarthquakeStore.getState().focusRequest).toBe(before);
  });

  it('flies and selects only when the banner is clicked', () => {
    useEarthquakeStore.getState().announceLargeEvent(quake);
    useEarthquakeStore.getState().select(quake.id);

    const state = useEarthquakeStore.getState();
    expect(state.selectedEventId).toBe(quake.id);
    expect(state.focusRequest?.eventId).toBe(quake.id);
  });
});

describe('archive spans toggle', () => {
  const oneYear = archiveSpanHours(ARCHIVE_SPANS[0]!);
  const allYears = archiveSpanHours(ARCHIVE_SPANS.at(-1)!);

  it('returns to the live view it came from', () => {
    // Without this the History buttons are a one-way door — every span stays
    // selected and there is no way back to the live globe.
    useEarthquakeStore.getState().setWindowHours(168); // 7d
    useEarthquakeStore.getState().setMinMagnitude(2.5);

    useEarthquakeStore.getState().toggleArchiveSpan(allYears);
    expect(useEarthquakeStore.getState().windowHours).toBe(allYears);

    useEarthquakeStore.getState().toggleArchiveSpan(allYears);

    expect(useEarthquakeStore.getState().windowHours).toBe(168);
  });

  it('restores the magnitude floor too, not just the window', () => {
    // Entering the archive auto-raises the floor to M5.5. Restoring only the
    // window would drop you back on 7d stuck at M5.5 — not where you were.
    useEarthquakeStore.getState().setWindowHours(168);
    useEarthquakeStore.getState().setMinMagnitude(2.5);

    useEarthquakeStore.getState().toggleArchiveSpan(allYears);
    expect(useEarthquakeStore.getState().minMagnitude).toBe(5.5);

    useEarthquakeStore.getState().toggleArchiveSpan(allYears);

    expect(useEarthquakeStore.getState().minMagnitude).toBe(2.5);
  });

  it('remembers the live view across a hop between archive spans', () => {
    // 7d → 1y → all → off must land on 7d, not on 1y. The memory is captured
    // on the way in and not overwritten while inside.
    useEarthquakeStore.getState().setWindowHours(168);

    useEarthquakeStore.getState().toggleArchiveSpan(oneYear);
    useEarthquakeStore.getState().toggleArchiveSpan(allYears);
    useEarthquakeStore.getState().toggleArchiveSpan(allYears);

    expect(useEarthquakeStore.getState().windowHours).toBe(168);
  });

  it('clears the trailing window on the way out', () => {
    useEarthquakeStore.getState().toggleArchiveSpan(allYears);
    useEarthquakeStore.getState().setTrailingWindow(true);

    useEarthquakeStore.getState().toggleArchiveSpan(allYears);

    expect(useEarthquakeStore.getState().trailingWindow).toBe(false);
  });

  it('drops out of playback, since the playhead is an absolute instant', () => {
    useEarthquakeStore.getState().toggleArchiveSpan(allYears);
    useEarthquakeStore.getState().play();

    useEarthquakeStore.getState().toggleArchiveSpan(allYears);

    expect(useEarthquakeStore.getState().isPlaying).toBe(false);
    expect(useEarthquakeStore.getState().playheadMs).toBeNull();
  });

  it('falls back to the defaults if somehow toggled off with no memory', () => {
    useEarthquakeStore.setState({ windowHours: allYears, preArchiveView: null });

    useEarthquakeStore.getState().toggleArchiveSpan(allYears);

    expect(useEarthquakeStore.getState().windowHours).toBe(DEFAULT_WINDOW_HOURS);
    expect(useEarthquakeStore.getState().minMagnitude).toBe(DEFAULT_MIN_MAGNITUDE);
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
