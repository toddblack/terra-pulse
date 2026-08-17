import { useEffect } from 'react';
import { TEC_CADENCE_MS } from '@terra-pulse/schema';
import { useGlobeStore } from '../state/useGlobeStore';
import { isOverlayVisible, OVERLAY_REGISTRATIONS } from '../layers/registry';
import { TEC_LAYER_ID } from '../layers/tec-layer';

/**
 * Keeps the store's TEC map current — **only while the layer is on**.
 *
 * Every other space-weather feed is pushed from main on a timer. This one is
 * pulled, and gated on visibility, because a GloTEC map is **2.4 MB** against
 * 65 KB for an auroral grid. Polling it regardless of whether anyone is looking
 * would spend ~14 MB an hour on a layer that is off by default.
 *
 * The consequence is deliberate: enabling the layer costs one fetch and a short
 * wait before anything appears, and disabling it stops the traffic entirely. The
 * last map is kept rather than cleared, so re-enabling draws immediately while a
 * fresher one is on its way.
 */
export function useTec(): void {
  const setTecGrid = useGlobeStore((state) => state.setTecGrid);
  const layerVisibility = useGlobeStore((state) => state.layerVisibility);

  const registration = OVERLAY_REGISTRATIONS.find((entry) => entry.id === TEC_LAYER_ID);
  const active = registration !== undefined && isOverlayVisible(registration, layerVisibility);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;

    const load = () => {
      void window.terraPulse.tec.latest().then(
        (grid) => {
          // Null only when main has never managed a fetch. Keeping whatever is
          // already in the store beats blanking a layer that was fine.
          if (!cancelled && grid) setTecGrid(grid);
        },
        (error: unknown) => {
          console.error('Failed to read TEC', error);
        },
      );
    };

    load();
    // Matched to the publication cadence. Main caches for the same interval, so
    // a tick that lands early costs nothing.
    const timer = setInterval(load, TEC_CADENCE_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, setTecGrid]);
}
