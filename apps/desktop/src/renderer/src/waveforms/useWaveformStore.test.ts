import { beforeEach, describe, expect, it } from 'vitest';
import { useWaveformStore } from './useWaveformStore';

describe('hovered station', () => {
  beforeEach(() => {
    useWaveformStore.setState({ hoveredStation: null });
  });

  it('clears when the hovered row is left', () => {
    const { hoverStation, unhoverStation } = useWaveformStore.getState();
    hoverStation('CI_PASC');
    unhoverStation('CI_PASC');
    expect(useWaveformStore.getState().hoveredStation).toBeNull();
  });

  it("keeps the next row's hover when the previous row's leave lands second", () => {
    // Moving between adjacent rows can deliver enter-B before leave-A. An
    // unconditional clear would leave nothing highlighted under the pointer.
    const { hoverStation, unhoverStation } = useWaveformStore.getState();
    hoverStation('CI_PASC');
    hoverStation('CI_GSC');
    unhoverStation('CI_PASC');
    expect(useWaveformStore.getState().hoveredStation).toBe('CI_GSC');
  });
});
