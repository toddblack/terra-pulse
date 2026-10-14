import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARCHIVE_SPANS, archiveSpanHours, longestCoverageHours } from '@terra-pulse/schema';
import {
  DEFAULT_MIN_MAGNITUDE,
  DEFAULT_PLAYBACK_SPEED,
  DEFAULT_WINDOW_HOURS,
  pollCanReach,
  useEarthquakeStore,
  viewStartMs,
} from './useEarthquakeStore';

/**
 * A date range picked on the calendar.
 *
 * Its own file because it needs the query stubbed for every test — entering or
 * leaving a range reloads — where the main store suite mostly does not.
 */

const HOUR = 3_600_000;
const MARCH_2011 = { startMs: Date.UTC(2011, 2, 1), endMs: Date.UTC(2011, 3, 1) };
const THE_1990S = { startMs: Date.UTC(1990, 0, 1), endMs: Date.UTC(2000, 0, 1) };

let queries: { startUtc?: string; endUtc?: string; minMagnitude?: number }[] = [];

beforeEach(() => {
  queries = [];
  vi.stubGlobal('window', {
    terraPulse: {
      earthquakes: {
        query: (query: { startUtc?: string; endUtc?: string; minMagnitude?: number }) => {
          queries.push(query);
          return Promise.resolve([]);
        },
      },
    },
  });

  useEarthquakeStore.setState({
    selectedEventId: null,
    antipodeEventId: null,
    minMagnitude: DEFAULT_MIN_MAGNITUDE,
    windowHours: DEFAULT_WINDOW_HOURS,
    dateRange: null,
    playheadMs: null,
    isPlaying: false,
    playbackSpeed: DEFAULT_PLAYBACK_SPEED,
    trailingWindow: false,
    preArchiveView: null,
    loadedWindowStartMs: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('entering a date range', () => {
  it('queries exactly the days picked, bounded at both ends', async () => {
    useEarthquakeStore.getState().setDateRange(MARCH_2011);
    await Promise.resolve();

    const query = queries[queries.length - 1];
    expect(query?.startUtc).toBe('2011-03-01T00:00:00.000Z');
    // Without an end bound this is "everything since March 2011" — fifteen
    // years at M4.5+, tens of thousands of rows for a one-month view.
    expect(query?.endUtc).toBe('2011-03-31T23:59:59.999Z');
  });

  it('does not reach back before the first day', async () => {
    // The live views ask for an hour of slack. Here that would draw events
    // from 28 February in a range that starts on 1 March.
    useEarthquakeStore.getState().setDateRange(MARCH_2011);
    await Promise.resolve();

    expect(Date.parse(queries[queries.length - 1]?.startUtc ?? '')).toBe(MARCH_2011.startMs);
    expect(useEarthquakeStore.getState().loadedWindowStartMs).toBe(MARCH_2011.startMs);
  });

  it('makes the view as long as the range', () => {
    useEarthquakeStore.getState().setDateRange(MARCH_2011);
    expect(useEarthquakeStore.getState().windowHours).toBe(31 * 24);
  });

  it('parks the playhead at the end of the range, never on live', () => {
    // `null` means "now" to every layer and legend in the app. A range in 2011
    // with a null playhead would draw 2011's earthquakes under today's field,
    // today's tide and a chip reading "Live".
    useEarthquakeStore.getState().setDateRange(MARCH_2011);
    expect(useEarthquakeStore.getState().playheadMs).toBe(MARCH_2011.endMs);
  });

  it('raises the floor to what the range can be drawn at', () => {
    useEarthquakeStore.setState({ minMagnitude: 1 });
    useEarthquakeStore.getState().setDateRange(MARCH_2011);
    expect(useEarthquakeStore.getState().minMagnitude).toBe(4.5);

    useEarthquakeStore.getState().setDateRange(THE_1990S);
    expect(useEarthquakeStore.getState().minMagnitude).toBe(5.5);
  });

  it('leaves a stricter floor alone', () => {
    useEarthquakeStore.setState({ minMagnitude: 7 });
    useEarthquakeStore.getState().setDateRange(MARCH_2011);
    expect(useEarthquakeStore.getState().minMagnitude).toBe(7);
  });

  it('clears the selection, like every other change of view', () => {
    useEarthquakeStore.setState({ selectedEventId: 'quake-1', antipodeEventId: 'quake-1' });
    useEarthquakeStore.getState().setDateRange(MARCH_2011);

    expect(useEarthquakeStore.getState().selectedEventId).toBeNull();
    expect(useEarthquakeStore.getState().antipodeEventId).toBeNull();
  });

  it('picks a playback speed that crosses the range in a sensible time', () => {
    // At the default 6 h/s a decade takes four hours to play.
    useEarthquakeStore.getState().setDateRange(THE_1990S);
    const { playbackSpeed, windowHours } = useEarthquakeStore.getState();
    expect(windowHours / playbackSpeed).toBeLessThanOrEqual(900);
  });
});

describe('leaving a date range', () => {
  it('returns to the live view it was entered from', () => {
    useEarthquakeStore.setState({ windowHours: 168, minMagnitude: 2.5 });
    useEarthquakeStore.getState().setDateRange(MARCH_2011);
    useEarthquakeStore.getState().clearDateRange();

    const state = useEarthquakeStore.getState();
    expect(state.dateRange).toBeNull();
    expect(state.windowHours).toBe(168);
    expect(state.minMagnitude).toBe(2.5);
    expect(state.playheadMs).toBeNull();
  });

  it('remembers the live view across a change of dates', () => {
    // Adjusting one end is another `setDateRange`. It must not overwrite the
    // memory with the range being adjusted, or clearing would land on 2011.
    useEarthquakeStore.setState({ windowHours: 168 });
    useEarthquakeStore.getState().setDateRange(MARCH_2011);
    useEarthquakeStore.getState().setDateRange(THE_1990S);
    useEarthquakeStore.getState().clearDateRange();

    expect(useEarthquakeStore.getState().windowHours).toBe(168);
  });

  it('is left by Live, since no part of a past range is live', () => {
    useEarthquakeStore.setState({ windowHours: 168 });
    useEarthquakeStore.getState().setDateRange(MARCH_2011);
    useEarthquakeStore.getState().goLive();

    const state = useEarthquakeStore.getState();
    expect(state.dateRange).toBeNull();
    expect(state.windowHours).toBe(168);
    expect(state.playheadMs).toBeNull();
  });

  it('is left by picking a window or an archive span', () => {
    useEarthquakeStore.getState().setDateRange(MARCH_2011);
    useEarthquakeStore.getState().setWindowHours(24);
    expect(useEarthquakeStore.getState().dateRange).toBeNull();
    expect(useEarthquakeStore.getState().playheadMs).toBeNull();

    const decade = archiveSpanHours(ARCHIVE_SPANS[1] ?? { years: 10, minMagnitude: 5.5, label: '' });
    useEarthquakeStore.getState().setDateRange(MARCH_2011);
    useEarthquakeStore.getState().toggleArchiveSpan(decade);
    expect(useEarthquakeStore.getState().dateRange).toBeNull();
    expect(useEarthquakeStore.getState().windowHours).toBe(decade);
  });

  it('does not mistake a range for the archive span of the same length', () => {
    // A range exactly one archive-year long has that span's `windowHours`.
    // Pressing 1y must switch to the span, not read it as already active and
    // toggle the whole archive off.
    const yearSpan = archiveSpanHours(ARCHIVE_SPANS[0] ?? { years: 1, minMagnitude: 4.5, label: '' });
    const sameLength = { startMs: Date.UTC(2011, 0, 1), endMs: Date.UTC(2011, 0, 1) + yearSpan * HOUR };
    useEarthquakeStore.setState({ windowHours: 168 });
    useEarthquakeStore.getState().setDateRange(sameLength);
    useEarthquakeStore.getState().toggleArchiveSpan(yearSpan);

    const state = useEarthquakeStore.getState();
    expect(state.dateRange).toBeNull();
    expect(state.windowHours).toBe(yearSpan);
  });

  it('does nothing when there is no range to leave', () => {
    useEarthquakeStore.setState({ windowHours: 168, playheadMs: 123 });
    useEarthquakeStore.getState().clearDateRange();
    expect(useEarthquakeStore.getState().playheadMs).toBe(123);
    expect(queries).toHaveLength(0);
  });
});

describe('the playhead inside a date range', () => {
  beforeEach(() => {
    useEarthquakeStore.getState().setDateRange(MARCH_2011);
  });

  it('plays from the start when it is sitting at the end', () => {
    // The end is where a range rests, as `null` is for a live view. Playing
    // from there would finish on the first tick.
    useEarthquakeStore.getState().play();
    expect(useEarthquakeStore.getState().playheadMs).toBe(MARCH_2011.startMs);
    expect(useEarthquakeStore.getState().isPlaying).toBe(true);
  });

  it('resumes from where it was paused', () => {
    const midMonth = Date.UTC(2011, 2, 11, 5, 46);
    useEarthquakeStore.getState().seek(midMonth);
    useEarthquakeStore.getState().play();
    expect(useEarthquakeStore.getState().playheadMs).toBe(midMonth);
  });

  it('cannot be scrubbed outside the range', () => {
    useEarthquakeStore.getState().seek(MARCH_2011.startMs - HOUR);
    expect(useEarthquakeStore.getState().playheadMs).toBe(MARCH_2011.startMs);

    useEarthquakeStore.getState().seek(MARCH_2011.endMs + HOUR);
    expect(useEarthquakeStore.getState().playheadMs).toBe(MARCH_2011.endMs);
  });

  it('is kept when only the magnitude floor changes', () => {
    const midMonth = Date.UTC(2011, 2, 11);
    useEarthquakeStore.getState().seek(midMonth);
    useEarthquakeStore.getState().setMinMagnitude(6);

    expect(useEarthquakeStore.getState().playheadMs).toBe(midMonth);
    expect(useEarthquakeStore.getState().dateRange).toEqual(MARCH_2011);
  });
});

describe('viewStartMs', () => {
  it('is the range start when there is a range', () => {
    expect(viewStartMs(31 * 24, MARCH_2011, Date.UTC(2026, 9, 13))).toBe(MARCH_2011.startMs);
  });

  it('reaches back from now otherwise', () => {
    const now = Date.UTC(2026, 9, 13);
    expect(viewStartMs(72, null, now)).toBe(now - 72 * HOUR);
  });
});

describe('pollCanReach', () => {
  const now = Date.UTC(2026, 9, 13, 12);

  it('is always true for a view that ends now', () => {
    expect(pollCanReach(null, now)).toBe(true);
  });

  it('is false for a range that ended before the rolling cache began', () => {
    // Reloading here hands the globe an identical array with a new identity,
    // and the earthquake layer rebuilds on identity: the 30-second-rebuild
    // bug again, on a poll's rhythm instead of a timer's.
    expect(pollCanReach(MARCH_2011, now)).toBe(false);
  });

  it('is true for a range recent enough to be revised', () => {
    const lastWeek = { startMs: now - 10 * 24 * HOUR, endMs: now - 3 * 24 * HOUR };
    expect(pollCanReach(lastWeek, now)).toBe(true);
  });

  it('turns over exactly where the rolling cache ends', () => {
    const edge = now - longestCoverageHours() * HOUR;
    expect(pollCanReach({ startMs: edge - HOUR, endMs: edge }, now)).toBe(true);
    expect(pollCanReach({ startMs: edge - 2 * HOUR, endMs: edge - 1 }, now)).toBe(false);
  });
});
