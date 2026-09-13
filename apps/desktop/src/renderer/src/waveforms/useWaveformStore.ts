import { create } from 'zustand';
import { DEFAULT_WAVEFORM_REGION_ID } from './waveform-regions';

/**
 * Which region the waveform mode is showing.
 *
 * Module-level, so it survives the mode being switched away from and back —
 * a reader who picked the Pacific Northwest should not land on Southern
 * California every time they glance at the globe. The *data* does not survive:
 * the buffer lives in the component and dies with it, because nothing here is
 * a record worth keeping.
 *
 * Deliberately not persisted to `app_state`, like `useAppModeStore`: a fresh
 * launch opens in Explore anyway, so there is nothing for a stored region to
 * restore into.
 */
interface WaveformState {
  regionId: string;
  setRegionId: (regionId: string) => void;
}

export const useWaveformStore = create<WaveformState>((set) => ({
  regionId: DEFAULT_WAVEFORM_REGION_ID,
  setRegionId: (regionId) => {
    set({ regionId });
  },
}));
