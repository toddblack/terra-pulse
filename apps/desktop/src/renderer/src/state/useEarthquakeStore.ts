import { create } from 'zustand';
import type { EarthquakeEvent } from '@terra-pulse/schema';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** How far back the globe shows events. The database keeps more than this. */
const DISPLAY_WINDOW_MS = 72 * 60 * 60 * 1000;

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
}

export const useEarthquakeStore = create<EarthquakeState>((set) => ({
  events: [],
  status: 'idle',
  error: null,
  selectedEventId: null,
  lastSyncedAt: null,
  focusRequest: null,

  load: async () => {
    set({ status: 'loading', error: null });
    try {
      // Explicit window rather than "everything". The database retains events
      // beyond the display window on purpose (PROJECT_PLAN Tier 1 keeps M4.5+
      // long-term), so an unbounded query would silently drift past 72h as
      // polling accumulates rows.
      const events = await window.terraPulse.earthquakes.query({
        startUtc: new Date(Date.now() - DISPLAY_WINDOW_MS).toISOString(),
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
        startUtc: new Date(Date.now() - DISPLAY_WINDOW_MS).toISOString(),
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
