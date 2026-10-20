import { create } from 'zustand';
import type { GraphicsStatus } from '@terra-pulse/schema';

/**
 * The globe could not draw: what happened, and what main decided to do.
 *
 * `restarting` covers the moment between reporting and main's answer as well,
 * because main answers by quitting — the reply may never arrive.
 */
export type GlobeFailureState = 'restarting' | 'failed';

interface GlobeFailureStore {
  failure: { state: GlobeFailureState; detail: string } | null;
  /** How this session draws. Null until main answers; the About panel waits for it. */
  graphics: GraphicsStatus | null;
  loadGraphics: () => void;
  /**
   * Reports a graphics failure once. Later reports are the same failure seen
   * again — a lost context is followed by render errors — so they are ignored.
   */
  report: (detail: string) => void;
  /** The About panel's way back. Not `use…`: it is an action, not a hook. */
  returnToHardware: () => void;
}

export const useGlobeFailureStore = create<GlobeFailureStore>((set, get) => ({
  failure: null,
  graphics: null,
  loadGraphics: () => {
    window.terraPulse.graphics.status().then(
      (graphics) => {
        set({ graphics });
      },
      (cause: unknown) => {
        console.error('Could not read the graphics mode', cause);
      },
    );
  },
  report: (detail) => {
    if (get().failure !== null) return;
    set({ failure: { state: 'restarting', detail } });
    window.terraPulse.graphics.globeFailed(detail).then(
      (action) => {
        if (action === 'stay') set({ failure: { state: 'failed', detail } });
      },
      (cause: unknown) => {
        console.error('Could not report the globe failure', cause);
        set({ failure: { state: 'failed', detail } });
      },
    );
  },
  returnToHardware: () => {
    window.terraPulse.graphics.useHardware().catch((cause: unknown) => {
      console.error('Could not switch back to the graphics card', cause);
    });
  },
}));
