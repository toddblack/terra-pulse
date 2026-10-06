import { useMemo } from 'react';
import { WAVEFORM_REGIONS } from './waveform-regions';
import { PICKED_REGION_ID, useWaveformStore } from './useWaveformStore';
import { resolveWaveformSelection, type WaveformSelection } from './waveform-selection';

/**
 * The stations on screen, from the store.
 *
 * Memoised on the three store fields it reads. That bounds the work, but it is
 * **not** what keeps the stream up: the station list landing ~3 s after mount
 * re-runs this and hands out new arrays for unchanged stations. The stream's
 * channel list is keyed on the channel ids instead — see `useWaveformBackground`.
 */
export function useWaveformSelection(): WaveformSelection | null {
  const regionId = useWaveformStore((state) => state.regionId);
  const pickPoint = useWaveformStore((state) => state.pickPoint);
  const catalogue = useWaveformStore((state) => state.catalogue);
  return useMemo(
    () => resolveWaveformSelection(regionId, PICKED_REGION_ID, WAVEFORM_REGIONS, pickPoint, catalogue),
    [regionId, pickPoint, catalogue],
  );
}
