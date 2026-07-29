import { create } from 'zustand';
import type { EarthquakeEvent } from '@terra-pulse/schema';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * The widest range main ingests. Every UI selection is a subset of this, so
 * changing the range filters in memory rather than refetching.
 */
const INGEST_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

export const DEFAULT_MIN_MAGNITUDE = 4;
export const DEFAULT_WINDOW_HOURS = 72;

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
}

export const useEarthquakeStore = create<EarthquakeState>((set) => ({
  events: [],
  status: 'idle',
  error: null,
  selectedEventId: null,
  lastSyncedAt: null,
  minMagnitude: DEFAULT_MIN_MAGNITUDE,
  windowHours: DEFAULT_WINDOW_HOURS,
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
  setWindowHours: (windowHours) => set({ windowHours, selectedEventId: null }),

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
