import { useEffect } from 'react';
import { useGlobeStore } from '../state/useGlobeStore';

/**
 * Keeps the store's magnetometer readings current.
 *
 * Pull once for whatever main already has, then subscribe for each refresh —
 * the same shape as `useAurora`, and for the same reason: a push-only
 * subscription would leave the layer blank until the next poll if the renderer
 * mounted just after one.
 */
export function useMagnetometers(): void {
  const setMagnetometerReadings = useGlobeStore((state) => state.setMagnetometerReadings);

  useEffect(() => {
    let cancelled = false;

    void window.terraPulse.magnetometer.latest().then(
      (readings) => {
        // An empty list is a legitimate answer before the first poll lands, and
        // overwriting a populated store with it would blank the layer.
        if (!cancelled && readings.length > 0) setMagnetometerReadings(readings);
      },
      (error: unknown) => {
        console.error('Failed to read magnetometers', error);
      },
    );

    const unsubscribe = window.terraPulse.magnetometer.onUpdated((readings) => {
      setMagnetometerReadings(readings);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [setMagnetometerReadings]);
}
