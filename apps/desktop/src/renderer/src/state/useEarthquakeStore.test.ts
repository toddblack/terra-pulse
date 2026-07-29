import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_MAGNITUDE,
  DEFAULT_WINDOW_HOURS,
  useEarthquakeStore,
} from './useEarthquakeStore';

beforeEach(() => {
  useEarthquakeStore.setState({
    selectedEventId: null,
    focusRequest: null,
    minMagnitude: DEFAULT_MIN_MAGNITUDE,
    windowHours: DEFAULT_WINDOW_HOURS,
  });
});

describe('display filters clear the selection', () => {
  it('clears the selected event when the magnitude floor changes', () => {
    useEarthquakeStore.getState().select('quake-1');
    expect(useEarthquakeStore.getState().selectedEventId).toBe('quake-1');

    useEarthquakeStore.getState().setMinMagnitude(5);

    expect(useEarthquakeStore.getState().selectedEventId).toBeNull();
    expect(useEarthquakeStore.getState().minMagnitude).toBe(5);
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
