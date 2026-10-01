import { create } from 'zustand';
import type { WaveformStationCatalogue } from '@terra-pulse/schema';
import { DEFAULT_WAVEFORM_REGION_ID } from './waveform-regions';
import type { WaveformPickPoint } from './station-pick';

/**
 * The tab id for "the stations nearest where I clicked". Sits beside the preset
 * ids in one field, so exactly one source is ever selected; no vendored preset
 * is called this.
 */
export const PICKED_REGION_ID = 'picked';

/**
 * Which stations the waveform mode is showing, and the list a pick draws from.
 *
 * Module-level, so it survives the mode being switched away from and back —
 * a reader who picked the Pacific Northwest should not land on Southern
 * California every time they glance at the globe. The *data* does not survive:
 * the buffer lives in the component and dies with it, because nothing here is
 * a record worth keeping.
 *
 * The pick point survives the same way, and for the same reason. Switching to a
 * preset keeps it, so the "Picked spot" tab still returns to it.
 *
 * Deliberately not persisted to `app_state`, like `useAppModeStore`: a fresh
 * launch opens in Explore anyway, so there is nothing for a stored region to
 * restore into.
 */
interface WaveformState {
  regionId: string;
  setRegionId: (regionId: string) => void;
  /** The last globe click in this mode, or null before the first. */
  pickPoint: WaveformPickPoint | null;
  /** Records a click and switches to the picked set — the click is the request. */
  pickAt: (point: WaveformPickPoint) => void;
  /** Null until main first answers. */
  catalogue: WaveformStationCatalogue | null;
  setCatalogue: (catalogue: WaveformStationCatalogue) => void;
}

export const useWaveformStore = create<WaveformState>((set) => ({
  regionId: DEFAULT_WAVEFORM_REGION_ID,
  setRegionId: (regionId) => {
    set({ regionId });
  },
  pickPoint: null,
  pickAt: (pickPoint) => {
    set({ pickPoint, regionId: PICKED_REGION_ID });
  },
  catalogue: null,
  setCatalogue: (catalogue) => {
    set((state) => {
      const current = state.catalogue;
      if (current?.status === 'ready') {
        // A failed refetch must not throw away a list that is still good: main
        // retries on the next ask, and an hour-old station list beats none.
        if (catalogue.status === 'unavailable') return state;
        // Main's cached copy again — same fetch, new object from the IPC clone.
        // Keeping the old identity is what stops a returning visit re-picking
        // the same stations and restarting a stream that had just connected.
        if (catalogue.fetchedAtMs === current.fetchedAtMs) return state;
      }
      return { catalogue };
    });
  },
}));
