import { useEffect, useState } from 'react';
import type { HypothesisSummary } from '@terra-pulse/schema';

/**
 * Which hypotheses the running engine actually implements, fetched live
 * rather than assumed — this is also what lets the selector grow to a third
 * hypothesis with no renderer change, only a new engine-side registry entry.
 * Re-fetches whenever the engine's own status changes (e.g. it just finished
 * starting), since there's nothing to list before that.
 */
export function useEngineHypotheses(): HypothesisSummary[] {
  const [hypotheses, setHypotheses] = useState<HypothesisSummary[]>([]);

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      window.terraPulse.analysis
        .hypotheses()
        .then((list) => {
          if (!cancelled) setHypotheses(list);
        })
        .catch((error: unknown) => {
          console.error('Could not read the hypothesis list', error);
        });
    };

    load();
    const unsubscribe = window.terraPulse.analysis.onEngineStatus(load);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return hypotheses;
}
