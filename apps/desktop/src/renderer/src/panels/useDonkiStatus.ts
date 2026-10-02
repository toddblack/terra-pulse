import { useEffect } from 'react';
import { useGlobeStore } from '../state/useGlobeStore';

/**
 * Keeps the store's DONKI status current.
 *
 * Same shape as `useAurora`: pull once for whatever main already has, then
 * subscribe for each update. Centralised here because `LayerPanel` once read
 * this too, to gate the solar layers on a NASA key; that gate went with the
 * key when DONKI moved to a keyless endpoint (2026-09-30).
 */
export function useDonkiStatus(): void {
  const setDonkiProgress = useGlobeStore((state) => state.setDonkiProgress);

  useEffect(() => {
    let cancelled = false;

    void window.terraPulse.solarEvents.status().then(
      (initial) => {
        if (!cancelled) setDonkiProgress(initial);
      },
      (error: unknown) => {
        console.error('Failed to read DONKI status', error);
      },
    );

    const unsubscribe = window.terraPulse.solarEvents.onProgress(setDonkiProgress);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [setDonkiProgress]);
}
