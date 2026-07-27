import { create } from 'zustand';
import type { EarthquakeEvent } from '@terra-pulse/schema';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

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

  /**
   * A pending "fly the camera here" request. Carries a nonce so clicking the
   * same event twice still re-triggers — without it the second click would be
   * a no-op state write and the camera wouldn't move.
   */
  focusRequest: { eventId: string; nonce: number } | null;

  load: () => Promise<void>;
  refresh: () => Promise<void>;
  select: (id: string | null) => void;
  requestFocus: (eventId: string) => void;
}

export const useEarthquakeStore = create<EarthquakeState>((set) => ({
  events: [],
  status: 'idle',
  error: null,
  selectedEventId: null,
  focusRequest: null,

  load: async () => {
    set({ status: 'loading', error: null });
    try {
      const events = await window.terraPulse.earthquakes.query({});
      set({ events, status: 'ready' });
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
      const events = await window.terraPulse.earthquakes.refresh();
      set({ events, status: 'ready' });
    } catch (error: unknown) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to refresh earthquakes',
      });
    }
  },

  select: (id) => set({ selectedEventId: id }),

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
