import { create } from 'zustand';

/**
 * The app's two modes (non-negotiable #1: Explore never displays significance
 * claims). `App.tsx` renders exactly one shell from this, never two.
 *
 * There were three until live waveforms moved into Explore's bottom dock: as a
 * mode of its own, entering it unmounted Explore, so the earthquakes stayed
 * drawn while nothing about them could be hovered or inspected. See
 * `panels/dock-state.ts`.
 *
 * **Deliberately not persisted.** Every other piece of view state that
 * matters across launches (window bounds) goes through `app_state` in the
 * database. This one doesn't: a fresh launch should always land in Explore, so
 * a reader is never dropped into a results panel with no memory of asking for
 * one.
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
