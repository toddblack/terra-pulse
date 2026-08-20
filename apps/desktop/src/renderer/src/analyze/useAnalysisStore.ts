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
interface HypothesisRunState {
  result: AnalysisResult | null;
  running: boolean;
  error: string | null;
}

const EMPTY_RUN_STATE: HypothesisRunState = { result: null, running: false, error: null };

/**
 * Keyed by hypothesis rather than a single slot, so the tab strip in
 * `AnalyzeShell` can behave like real tabs: switching away from a
 * hypothesis does not clear its last result, and switching back to it
 * restores exactly what was there. Written out explicitly (not built from
 * an array) so that widening `HypothesisId` — the next candidate is H1b —
 * fails to compile here until this record grows too, the same forcing
 * function `HYPOTHESIS_COPY` in `AnalyzeShell.tsx` already relies on.
 */
const INITIAL_STATE: Record<HypothesisId, HypothesisRunState> = {
  H4c: EMPTY_RUN_STATE,
  H3b: EMPTY_RUN_STATE,
  H2b: EMPTY_RUN_STATE,
  H1b: EMPTY_RUN_STATE,
  H5: EMPTY_RUN_STATE,
};

interface AnalysisState {
  byHypothesis: Record<HypothesisId, HypothesisRunState>;
  run: (hypothesisId: HypothesisId) => Promise<void>;
}

/**
 * A run for one hypothesis never touches another's slot, and switching the
 * selected tab never cancels or blocks on anything here — there is no
 * cancel endpoint on the engine side, and a run left going in the
 * background is expected to land in its own tab whenever it resolves. Every
 * update goes through the functional form of `set` so that two hypotheses
 * running concurrently (start H4c, switch tabs, start H3b before H4c
 * finishes) each read the latest state rather than racing on a stale
 * closure and clobbering each other's slot.
 */
export const useAnalysisStore = create<AnalysisState>((set) => ({
  byHypothesis: INITIAL_STATE,
  run: async (hypothesisId) => {
    set((state) => ({
      byHypothesis: {
        ...state.byHypothesis,
        [hypothesisId]: { ...state.byHypothesis[hypothesisId], running: true, error: null },
      },
    }));
    try {
      const outcome = await window.terraPulse.analysis.run(hypothesisId);
      set((state) => ({
        byHypothesis: {
          ...state.byHypothesis,
          [hypothesisId]: outcome.ok
            ? { result: outcome.result, running: false, error: null }
            : {
                ...state.byHypothesis[hypothesisId],
                error: `${outcome.reason}: ${outcome.detail}`,
                running: false,
              },
        },
      }));
    } catch (error: unknown) {
      set((state) => ({
        byHypothesis: {
          ...state.byHypothesis,
          [hypothesisId]: {
            ...state.byHypothesis[hypothesisId],
            error: error instanceof Error ? error.message : String(error),
            running: false,
          },
        },
      }));
    }
  },
}));
