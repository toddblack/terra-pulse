import { useEffect } from 'react';
import { useGlobeStore } from '../state/useGlobeStore';

/**
 * Keeps the store's auroral grid current.
 *
 * Pull once for whatever main already has, then subscribe for each new poll —
 * the same shape as the earthquake feed, and for the same reason: a push-only
 * subscription would leave the layer blank until the next five-minute tick if
 * the renderer mounted just after one.
 */
export function useAurora(): void {
  const setAuroraGrid = useGlobeStore((state) => state.setAuroraGrid);

  useEffect(() => {
    let cancelled = false;

    void window.terraPulse.aurora.latest().then(
      (grid) => {
        // Guarded because a poll may land while this request is in flight, and
        // it would be the newer of the two.
        if (!cancelled && grid) setAuroraGrid(grid);
      },
      (error: unknown) => {
        console.error('Failed to read the aurora grid', error);
      },
    );

    const unsubscribe = window.terraPulse.aurora.onUpdated((grid) => {
      setAuroraGrid(grid);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [setAuroraGrid]);
}
