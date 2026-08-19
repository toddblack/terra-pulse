import { create } from 'zustand';
import type { AnalysisResult, HypothesisId } from '@terra-pulse/schema';

/**
 * The **only** place an `AnalysisResult` lives in the renderer.
 *
 * That is the load-bearing property, not an implementation detail: Explore
 * code has no store, hook, or panel with a reference to this data, which is
 * one of the four structural layers keeping a p-value from ever reaching
 * Explore mode (non-negotiable #1) — see this directory's
 * `explore-purity.test.ts` for the layer that checks the other three.
 */
interface AnalysisState {
  result: AnalysisResult | null;
  running: boolean;
  error: string | null;
  run: (hypothesisId: HypothesisId) => Promise<void>;
}

export const useAnalysisStore = create<AnalysisState>((set) => ({
  result: null,
  running: false,
  error: null,
  run: async (hypothesisId) => {
    set({ running: true, error: null });
    try {
      const outcome = await window.terraPulse.analysis.run(hypothesisId);
      if (outcome.ok) {
        set({ result: outcome.result, running: false });
      } else {
        set({ error: `${outcome.reason}: ${outcome.detail}`, running: false });
      }
    } catch (error: unknown) {
      set({ error: error instanceof Error ? error.message : String(error), running: false });
    }
  },
}));
