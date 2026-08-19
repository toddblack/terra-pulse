import { create } from 'zustand';

/**
 * Explore vs. Analyze — the app's two modes (non-negotiable #1: Explore
 * never displays significance claims). `App.tsx` renders one shell or the
 * other from this, never both.
 *
 * **Deliberately not persisted.** Every other piece of view state that
 * matters across launches (window bounds, a saved DONKI key) goes through
 * `app_state` in the database. This one doesn't: a fresh launch should always
 * land in Explore, so a reader is never dropped into a results panel with no
 * memory of asking for one.
 */
export type AppMode = 'explore' | 'analyze';

interface AppModeState {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
}

export const useAppModeStore = create<AppModeState>((set) => ({
  mode: 'explore',
  setMode: (mode) => {
    set({ mode });
  },
}));
