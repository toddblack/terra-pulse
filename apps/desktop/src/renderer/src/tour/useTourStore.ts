import { create } from 'zustand';
import { useEarthquakeStore } from '../state/useEarthquakeStore';
import type { TourStep } from './tour-steps';

/**
 * The tour in progress, if any. Empty `steps` means no tour.
 *
 * Finishing and skipping are the same act as far as anyone outside is
 * concerned: either one records this version's tour as seen, so it never
 * comes back on its own. Skipping is not a failure state to be retried later —
 * the reader said no.
 */
interface TourState {
  steps: readonly TourStep[];
  index: number;
  /** Which way the reader last moved: a step whose target is missing is skipped in this direction. */
  direction: 1 | -1;
  /** The quake the tour selected for the inspector step, so it can put that back. */
  selectedByTour: string | null;

  start: (steps: readonly TourStep[]) => void;
  next: () => void;
  back: () => void;
  /** Finish or skip; records the tour as seen. */
  end: () => void;
  noteSelection: (eventId: string) => void;
}

export const useTourStore = create<TourState>((set, get) => ({
  steps: [],
  index: 0,
  direction: 1,
  selectedByTour: null,

  start: (steps) => set({ steps, index: 0, direction: 1, selectedByTour: null }),

  next: () => {
    const { index, steps, end } = get();
    if (index + 1 >= steps.length) {
      end();
      return;
    }
    set({ index: index + 1, direction: 1 });
  },

  // Back from the first step stays put rather than ending the tour: ending is
  // what Skip is for, and a reader pressing ← twice should not lose it.
  back: () => set((state) => ({ index: Math.max(0, state.index - 1), direction: -1 })),

  end: () => {
    const { selectedByTour } = get();
    // Only undo our own selection. If the reader clicked something else
    // meanwhile, that is theirs.
    const earthquakes = useEarthquakeStore.getState();
    if (selectedByTour !== null && earthquakes.selectedEventId === selectedByTour) earthquakes.select(null);
    set({ steps: [], index: 0, direction: 1, selectedByTour: null });
    window.terraPulse.tour.markSeen().catch((error: unknown) => {
      console.error('Could not record the tour as seen', error);
    });
  },

  noteSelection: (selectedByTour) => set({ selectedByTour }),
}));
