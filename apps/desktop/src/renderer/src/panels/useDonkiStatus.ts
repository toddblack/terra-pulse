import { useEffect } from 'react';
import { useGlobeStore } from '../state/useGlobeStore';

/**
 * Keeps the store's DONKI status current.
 *
 * Same shape as `useAurora`: pull once for whatever main already has, then
 * subscribe for each update. Centralised here rather than fetched inside
 * `DonkiArchive` alone because `LayerPanel` needs `hasApiKey` too, to gate
 * turning on the solar-flares/CME-arrivals layers.
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
