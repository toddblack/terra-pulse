import { create } from 'zustand';
import {
  minMagnitudeForWindow,
  playbackSpeedForWindow,
  type EarthquakeEvent,
  type MissedEvents,
} from '@terra-pulse/schema';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * A little slack on the queried window, so an event arriving between the query
 * and the next render isn't clipped at the edge.
 */
const QUERY_MARGIN_MS = 60 * 60 * 1000;

/**
 * M4.5 rather than the old M4: it's where global completeness begins, so the
 * default view is the one whose absences mean something. Must be a value in
 * `MAGNITUDE_FLOORS` or the button for it wouldn't exist.
 */
export const DEFAULT_MIN_MAGNITUDE = 4.5;
export const DEFAULT_WINDOW_HOURS = 72;

/**
 * The starting playback speed, in simulated hours per real second.
 *
 * At 6 h/s the default 72-hour window replays in 12 seconds — long enough to
 * follow a sequence, short enough to rerun on a whim.
 *
 * **The set of speeds on offer is no longer fixed.** It comes from
 * `playbackSpeedsForWindow`, because a ladder sized for a 30-day window cannot
 * cross a 130-year span in under 13 hours. See the note in `packages/schema`.
 */
export const DEFAULT_PLAYBACK_SPEED = 6;

interface EarthquakeState {
  /**
   * The single canonical copy of the loaded event set (PROJECT_PLAN §7.5).
   * Every view — globe layer, inspector, future timeline — derives from this
   * rather than keeping its own array.
   */
  events: EarthquakeEvent[];

  /**
   * The window start `events` was queried against — **not** a live clock.
   *
   * Fixed at load time on purpose. The globe builds its entity set from this
   * cutoff, and a cutoff that tracked the clock would give that set a new
   * identity every thirty seconds and rebuild every Cesium entity with it. The
   * *displayed* trailing edge still moves continuously; it does so through
   * `setTimeWindow`, which only flips visibility flags. See
   * `useVisibleEarthquakes`.
   *
   * `null` until the first load, when there is nothing to filter anyway.
   */
  loadedWindowStartMs: number | null;

  status: LoadStatus;
  error: string | null;
  selectedEventId: string | null;
  /** When main last successfully reached USGS — drives the freshness label. */
  lastSyncedAt: string | null;

  /**
   * Display filters.
   *
   * These now drive the *query*, not just an in-memory projection — the loaded
   * set is exactly this window at this floor. Narrowing further (band isolation,
   * the playhead, the trailing window) still happens in memory over that set.
   */
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
   * Shows only a trailing slice of the window before the playhead, instead of
   * everything from the window's start.
   *
   * The time analogue of `isolateBand`, and it exists for the same reason: over
   * 57 years "everything up to here" ends with the whole archive on screen and
   * no way to look at just the 1990s. Off by default — a view that silently
   * hides most of the span should never be one you're in without asking.
   *
   * The trail's length is `previousWindowHours` — one step down the ladder the
   * selector already offers, so it's a decade inside the all-years view and a
   * year inside the decade.
   */
  trailingWindow: boolean;

  /**
   * The live view to come back to when an archive span is switched off.
   *
   * Captured on the way *into* the archive and restored on the way out, so
   * toggling a span off returns you exactly where you were rather than to a
   * default you never chose. `null` while a live tier is active.
   *
   * It carries the floor and the trailing flag as well as the window, because
   * entering the archive changes all three: the floor auto-raises to M5.5 and
   * the trail is offered. Restoring only the window would drop you back on 7d
   * stuck at M5.5, which is not where you were.
   */
  preArchiveView: { windowHours: number; minMagnitude: number; trailingWindow: boolean } | null;

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
   * The one large event currently being announced, or `null`.
   *
   * A single slot rather than a queue: a newer qualifying event replaces the
   * one on screen. The most recent large earthquake is the fact worth having,
   * and a backlog to click through would be worse than that.
   */
  activeAlert: EarthquakeEvent | null;

  /**
   * What arrived while the app was shut, shown once on launch.
   *
   * Separate from `activeAlert` because they are different promises: an alert
   * says "this just happened" and is bounded to the last hour; this is a digest
   * covering however long you were away, and both can legitimately be on screen
   * at once after a long absence.
   */
  missedEvents: MissedEvents | null;

  /**
   * Whether the browsable event list is open.
   *
   * Open by default would put a 20rem panel over the globe on first run before
   * anyone asked for it; the collapsed button carries the count, so the list is
   * discoverable without being imposed.
   */
  eventListOpen: boolean;

  /**
   * The event whose antipode chord is on screen, or `null`.
   *
   * Its own id rather than a boolean over `selectedEventId`, because the two
   * can legitimately diverge — and because a mode this visually loud should
   * never be inferred from something as incidental as what happens to be
   * selected.
   */
  antipodeEventId: string | null;

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
  /** Archive spans behave as toggles: picking the active one returns to live. */
  toggleArchiveSpan: (spanHours: number) => void;
  setIsolateBand: (isolateBand: boolean) => void;
  setTrailingWindow: (trailingWindow: boolean) => void;
  announceLargeEvent: (event: EarthquakeEvent) => void;
  dismissAlert: () => void;
  showMissedEvents: (missed: MissedEvents) => void;
  dismissMissedEvents: () => void;
  setEventListOpen: (open: boolean) => void;
  showAntipode: (eventId: string) => void;
  hideAntipode: () => void;

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

/**
 * Loads exactly the window and floor currently selected.
 *
 * **Queries by span rather than loading everything and narrowing in memory.**
 * The old design fetched a fixed widest range — a stale four days, while the UI
 * offered thirty — and filtered client-side. That was already wrong (selecting
 * 30d showed 4 days and looked like a quiet month) and it cannot survive the
 * archive at all: "load the widest range" over 57 years is 294,648 rows, which
 * is an out-of-memory crash rather than a slow render.
 *
 * The magnitude floor goes to SQL too. It is the difference between 26,746 rows
 * and 294,648 on the same span, and the database can answer it with an index.
 */
async function loadForCurrentView(
  set: (partial: Partial<EarthquakeState>) => void,
  getState: () => EarthquakeState,
  failureMessage: string,
): Promise<void> {
  const { windowHours, minMagnitude } = getState();
  set({ status: 'loading', error: null });

  try {
    // Captured rather than recomputed, so consumers can filter against the same
    // instant this query used instead of against a live clock. See
    // `loadedWindowStartMs`.
    const startMs = windowStartMs(windowHours);

    const events = await window.terraPulse.earthquakes.query({
      startUtc: new Date(startMs - QUERY_MARGIN_MS).toISOString(),
      minMagnitude,
    });
    set({
      events,
      loadedWindowStartMs: startMs,
      status: 'ready',
      lastSyncedAt: new Date().toISOString(),
    });
  } catch (error: unknown) {
    set({
      status: 'error',
      error: error instanceof Error ? error.message : failureMessage,
    });
  }
}

export const useEarthquakeStore = create<EarthquakeState>((set) => ({
  events: [],
  loadedWindowStartMs: null,
  status: 'idle',
  error: null,
  selectedEventId: null,
  lastSyncedAt: null,
  minMagnitude: DEFAULT_MIN_MAGNITUDE,
  windowHours: DEFAULT_WINDOW_HOURS,
  isolateBand: false,
  trailingWindow: false,
  preArchiveView: null,
  activeAlert: null,
  missedEvents: null,
  eventListOpen: false,
  antipodeEventId: null,
  playheadMs: null,
  isPlaying: false,
  playbackSpeed: DEFAULT_PLAYBACK_SPEED,
  focusRequest: null,

  load: async () => {
    await loadForCurrentView(set, useEarthquakeStore.getState, 'Failed to load earthquakes');
  },

  // Re-fetches from USGS in the main process, then replaces the canonical set.
  refresh: async () => {
    set({ status: 'loading', error: null });
    try {
      await window.terraPulse.earthquakes.refresh();
    } catch (error: unknown) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to refresh earthquakes',
      });
      return;
    }
    await loadForCurrentView(set, useEarthquakeStore.getState, 'Failed to refresh earthquakes');
  },

  noteSynced: (syncedAt) => set({ lastSyncedAt: syncedAt }),

  announceLargeEvent: (event) => set({ activeAlert: event }),

  dismissAlert: () => {
    set({ activeAlert: null });
    // Main retains the alert so the renderer can ask for one it missed at
    // launch. Without telling it the alert is dismissed, that pull would hand
    // the same event back every time `ExploreShell` remounts — which happens
    // on every switch back from Analyze. Fire-and-forget: the banner is
    // already gone, and a failed IPC must not leave it on screen.
    void window.terraPulse.earthquakes.dismissAlert().catch((error: unknown) => {
      console.error('Could not clear the retained alert', error);
    });
  },

  showMissedEvents: (missed) => set({ missedEvents: missed }),

  dismissMissedEvents: () => set({ missedEvents: null }),

  setEventListOpen: (eventListOpen) => set({ eventListOpen }),

  // Also selects, so the inspector holding the exit control stays open.
  showAntipode: (eventId) =>
    set((state) => ({
      antipodeEventId: eventId,
      selectedEventId: eventId,
      focusRequest: { eventId, nonce: (state.focusRequest?.nonce ?? 0) + 1 },
    })),

  hideAntipode: () => set({ antipodeEventId: null }),

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
  // Refetches, because the floor is part of the query now. An M5.5 view holds
  // 26,746 rows where M4.5 holds 294,648 on the same span, so lowering the
  // floor genuinely needs rows the store does not have.
  setMinMagnitude: (minMagnitude) => {
    set({ minMagnitude, selectedEventId: null, antipodeEventId: null });
    void useEarthquakeStore.getState().load();
  },

  setIsolateBand: (isolateBand) => set({ isolateBand, selectedEventId: null }),

  setTrailingWindow: (trailingWindow) => set({ trailingWindow, selectedEventId: null }),
  // Also drops out of playback: the playhead is an absolute instant, and
  // resizing the window can leave it outside the range entirely.
  //
  // The magnitude floor is raised to match if the new span wasn't ingested that
  // deep. Silently keeping M1 on a 30-day view would empty the globe, and an
  // empty globe reads as a quiet month rather than as data we never fetched.
  // Never lowered — that would undo a deliberate choice on the way back down.
  setWindowHours: (windowHours) => {
    set((state) => ({
      windowHours,
      minMagnitude: Math.max(state.minMagnitude, minMagnitudeForWindow(windowHours)),
      // The speed ladder is span-dependent for the same reason the floor is: at
      // 6 h/s the 130-year span takes 52.8 hours to play, so a speed carried
      // over from a live tier leaves the playhead apparently frozen. Keeps the
      // current choice when the new window can still use it.
      playbackSpeed: playbackSpeedForWindow(windowHours, state.playbackSpeed),
      selectedEventId: null,
      antipodeEventId: null,
      playheadMs: null,
      isPlaying: false,
    }));
    // After the floor has been raised to match the span, so the query asks for
    // what the span can actually answer.
    void useEarthquakeStore.getState().load();
  },

  /**
   * Archive spans toggle; live tiers do not.
   *
   * The asymmetry is real rather than an inconsistency. A live tier switched
   * "off" has nothing to fall back to — the globe always shows *some* window —
   * whereas the archive is a mode you step into and out of, and without this
   * the History buttons were a one-way door.
   *
   * Switching one on remembers the live view; switching it off restores it.
   * Moving between archive spans keeps the original memory, so 7d → 1y → 10y →
   * off lands back on 7d rather than on 1y.
   */
  toggleArchiveSpan: (spanHours) => {
    const state = useEarthquakeStore.getState();

    if (state.windowHours === spanHours) {
      const restored = state.preArchiveView ?? {
        windowHours: DEFAULT_WINDOW_HOURS,
        minMagnitude: DEFAULT_MIN_MAGNITUDE,
        trailingWindow: false,
      };
      set((current) => ({
        ...restored,
        // This path sets the window directly rather than through
        // `setWindowHours`, so the speed has to be brought back with it — or
        // returning from the archive would leave a years-per-second rate on a
        // 72-hour window and cross it in a blink.
        playbackSpeed: playbackSpeedForWindow(restored.windowHours, current.playbackSpeed),
        preArchiveView: null,
        selectedEventId: null,
        playheadMs: null,
        isPlaying: false,
      }));
      void useEarthquakeStore.getState().load();
      return;
    }

    set((current) => ({
      // Only captured on the way in. Hopping between archive spans must not
      // overwrite the live view with another archive one, or "off" would land
      // on a span instead of leaving the archive.
      preArchiveView:
        current.preArchiveView ??
        ({
          windowHours: current.windowHours,
          minMagnitude: current.minMagnitude,
          trailingWindow: current.trailingWindow,
        } satisfies NonNullable<EarthquakeState['preArchiveView']>),
    }));
    useEarthquakeStore.getState().setWindowHours(spanHours);
  },

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
