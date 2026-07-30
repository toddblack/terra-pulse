import { create } from 'zustand';
import { minMagnitudeForWindow, type EarthquakeEvent } from '@terra-pulse/schema';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * The widest range main ingests. Every UI selection is a subset of this, so
 * changing the range filters in memory rather than refetching.
 */
const INGEST_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

/**
 * M4.5 rather than the old M4: it's where global completeness begins, so the
 * default view is the one whose absences mean something. Must be a value in
 * `MAGNITUDE_FLOORS` or the button for it wouldn't exist.
 */
export const DEFAULT_MIN_MAGNITUDE = 4.5;
export const DEFAULT_WINDOW_HOURS = 72;

/**
 * Playback speed options, in simulated hours per real second.
 *
 * At 6 h/s a 72-hour window replays in 12 seconds, which is long enough to
 * follow a sequence and short enough to rerun on a whim. 24 h/s is for skimming
 * four days; 1 h/s is for watching a single aftershock sequence unfold.
 */
export const PLAYBACK_SPEEDS_HOURS_PER_SECOND = [1, 6, 24] as const;
export const DEFAULT_PLAYBACK_SPEED = 6;

interface EarthquakeState {
  /**
   * The single canonical copy of the loaded event set (PROJECT_PLAN §7.5).
   * Every view — globe layer, inspector, future timeline — derives from this
   * rather than keeping its own array.
   */
  events: EarthquakeEvent[];
  status: LoadStatus;
  error: string | null;
  selectedEventId: string | null;
  /** When main last successfully reached USGS — drives the freshness label. */
  lastSyncedAt: string | null;

  /** Display filters. Applied in memory over `events`, never refetched. */
  minMagnitude: number;
  windowHours: number;

  /**
   * Caps the view at the next magnitude floor, turning it into a band.
   *
   * Off by default, because a view that silently hides the largest earthquakes
   * should never be something you're in without having asked. On, `M1+` becomes
   * `M1-2.5` — the small-event texture where swarms and induced seismicity
   * live, which is otherwise visually dominated by the events above it.
   */
  isolateBand: boolean;

  /**
   * Where the playhead sits, as epoch ms — or `null` for **live**.
   *
   * Live is the normal state and means "show everything up to right now". A
   * number means the user is scrubbing or replaying, and the globe shows only
   * events at or before that instant.
   *
   * Stored as an absolute timestamp rather than a fraction of the window so
   * that changing the window length can't silently teleport the playhead to a
   * different moment.
   */
  playheadMs: number | null;
  isPlaying: boolean;
  /** Simulated hours advanced per real second. */
  playbackSpeed: number;

  /**
   * A pending "fly the camera here" request. Carries a nonce so clicking the
   * same event twice still re-triggers — without it the second click would be
   * a no-op state write and the camera wouldn't move.
   */
  focusRequest: { eventId: string; nonce: number } | null;

  load: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Records a poll that found nothing new: freshness moves, events don't. */
  noteSynced: (syncedAt: string) => void;
  select: (id: string | null) => void;
  requestFocus: (eventId: string) => void;
  setMinMagnitude: (minMagnitude: number) => void;
  setWindowHours: (windowHours: number) => void;
  setIsolateBand: (isolateBand: boolean) => void;

  /** Starts playback from the window's beginning, or resumes where paused. */
  play: () => void;
  pause: () => void;
  /** Moves the playhead without changing whether it's running. */
  seek: (playheadMs: number) => void;
  /** Returns to live: playback off, everything up to now shown. */
  goLive: () => void;
  setPlaybackSpeed: (playbackSpeed: number) => void;
}

/** Oldest instant the current window covers. */
export function windowStartMs(windowHours: number, now: number = Date.now()): number {
  return now - windowHours * 60 * 60 * 1000;
}

export const useEarthquakeStore = create<EarthquakeState>((set) => ({
  events: [],
  status: 'idle',
  error: null,
  selectedEventId: null,
  lastSyncedAt: null,
  minMagnitude: DEFAULT_MIN_MAGNITUDE,
  windowHours: DEFAULT_WINDOW_HOURS,
  isolateBand: false,
  playheadMs: null,
  isPlaying: false,
  playbackSpeed: DEFAULT_PLAYBACK_SPEED,
  focusRequest: null,

  load: async () => {
    set({ status: 'loading', error: null });
    try {
      // Loads the *widest* range the UI can ask for, not the current
      // selection — narrowing happens in memory (PROJECT_PLAN §7.5: one
      // canonical copy, all views derived). An unbounded query would instead
      // drift ever wider as polling accumulates rows.
      const events = await window.terraPulse.earthquakes.query({
        startUtc: new Date(Date.now() - INGEST_WINDOW_MS).toISOString(),
      });
      set({ events, status: 'ready', lastSyncedAt: new Date().toISOString() });
    } catch (error: unknown) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to load earthquakes',
      });
    }
  },

  // Re-fetches from USGS in the main process, then replaces the canonical set.
  refresh: async () => {
    set({ status: 'loading', error: null });
    try {
      await window.terraPulse.earthquakes.refresh();
      const events = await window.terraPulse.earthquakes.query({
        startUtc: new Date(Date.now() - INGEST_WINDOW_MS).toISOString(),
      });
      set({ events, status: 'ready', lastSyncedAt: new Date().toISOString() });
    } catch (error: unknown) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to refresh earthquakes',
      });
    }
  },

  noteSynced: (syncedAt) => set({ lastSyncedAt: syncedAt }),

  // Changing a display filter clears the selection.
  //
  // Without this the inspector kept describing an event that had just been
  // filtered off the globe — its marker gone, its panel still open, and no way
  // to see what it was referring to. Clearing unconditionally rather than only
  // when the selected event drops out of range: "changing the filter resets
  // the selection" is a rule you can predict, whereas clearing sometimes and
  // not others is the kind of behaviour that reads as a glitch.
  //
  // Note this sets `selectedEventId` directly rather than calling `select`,
  // because `select` also parks a focus request. There is nothing to fly to.
  setMinMagnitude: (minMagnitude) => set({ minMagnitude, selectedEventId: null }),

  setIsolateBand: (isolateBand) => set({ isolateBand, selectedEventId: null }),
  // Also drops out of playback: the playhead is an absolute instant, and
  // resizing the window can leave it outside the range entirely.
  //
  // The magnitude floor is raised to match if the new span wasn't ingested that
  // deep. Silently keeping M1 on a 30-day view would empty the globe, and an
  // empty globe reads as a quiet month rather than as data we never fetched.
  // Never lowered — that would undo a deliberate choice on the way back down.
  setWindowHours: (windowHours) =>
    set((state) => ({
      windowHours,
      minMagnitude: Math.max(state.minMagnitude, minMagnitudeForWindow(windowHours)),
      selectedEventId: null,
      playheadMs: null,
      isPlaying: false,
    })),

  play: () =>
    set((state) => ({
      isPlaying: true,
      // Starting from live would mean "play from the end", which finishes
      // instantly. Rewind to the top of the window instead.
      playheadMs: state.playheadMs ?? windowStartMs(state.windowHours),
      // A panel describing an event that hasn't "happened" yet at the playhead
      // would be describing the future.
      selectedEventId: null,
    })),

  pause: () => set({ isPlaying: false }),

  seek: (playheadMs) => set({ playheadMs, selectedEventId: null }),

  goLive: () => set({ playheadMs: null, isPlaying: false }),

  setPlaybackSpeed: (playbackSpeed) => set({ playbackSpeed }),

  // Selecting an event also centres the camera on it. Deselecting does not
  // move the camera — yanking the view around on a dismiss would be worse
  // than leaving it where the user last put it.
  select: (id) =>
    set((state) => ({
      selectedEventId: id,
      focusRequest:
        id === null
          ? state.focusRequest
          : { eventId: id, nonce: (state.focusRequest?.nonce ?? 0) + 1 },
    })),

  requestFocus: (eventId) =>
    set((state) => ({
      focusRequest: { eventId, nonce: (state.focusRequest?.nonce ?? 0) + 1 },
    })),
}));

/** Derived lookup — avoids every consumer re-scanning the array itself. */
export function selectEventById(
  state: EarthquakeState,
  id: string | null,
): EarthquakeEvent | null {
  if (id === null) return null;
  return state.events.find((event) => event.id === id) ?? null;
}
