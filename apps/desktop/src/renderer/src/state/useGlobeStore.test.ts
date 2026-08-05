import { beforeEach, describe, expect, it } from 'vitest';
import { useGlobeStore } from './useGlobeStore';

const reset = () =>
  useGlobeStore.setState({ faultProbeActive: false, probePoint: null });

describe('fault probe mode', () => {
  beforeEach(reset);

  it('starts off, with nothing probed', () => {
    expect(useGlobeStore.getState().faultProbeActive).toBe(false);
    expect(useGlobeStore.getState().probePoint).toBeNull();
  });

  it('toggles on and back off', () => {
    useGlobeStore.getState().toggleFaultProbe();
    expect(useGlobeStore.getState().faultProbeActive).toBe(true);

    useGlobeStore.getState().toggleFaultProbe();
    expect(useGlobeStore.getState().faultProbeActive).toBe(false);
  });

  it('records a probed point', () => {
    useGlobeStore.getState().toggleFaultProbe();
    useGlobeStore.getState().setProbePoint({ latitude: 35.9, longitude: -120.43 });

    expect(useGlobeStore.getState().probePoint).toEqual({
      latitude: 35.9,
      longitude: -120.43,
    });
  });

  /**
   * Leaving the mode has to drop the reading with it. A probe result left on
   * screen after the mode is off cannot be refreshed or dismissed — the panel
   * that owns it is collapsed — and it describes a place the user has stopped
   * asking about.
   */
  it('drops the probed point when the mode is switched off', () => {
    useGlobeStore.getState().toggleFaultProbe();
    useGlobeStore.getState().setProbePoint({ latitude: 35.9, longitude: -120.43 });

    useGlobeStore.getState().toggleFaultProbe();
    expect(useGlobeStore.getState().faultProbeActive).toBe(false);
    expect(useGlobeStore.getState().probePoint).toBeNull();
  });

  it('does not clear a point merely by switching the mode on', () => {
    // Turning on is not a reason to discard anything — there is nothing there
    // yet on the first entry, and this keeps the clearing rule to one direction.
    useGlobeStore.setState({ probePoint: { latitude: 1, longitude: 2 } });
    useGlobeStore.getState().toggleFaultProbe();

    expect(useGlobeStore.getState().probePoint).toEqual({ latitude: 1, longitude: 2 });
  });

  it('leaves the basemap and layer toggles alone', () => {
    // The probe shares a store with them; a careless `set` would replace rather
    // than merge and silently reset every layer toggle.
    const basemapBefore = useGlobeStore.getState().activeBasemapId;
    const visibilityBefore = useGlobeStore.getState().layerVisibility;

    useGlobeStore.getState().toggleFaultProbe();
    useGlobeStore.getState().setProbePoint({ latitude: 0, longitude: 0 });

    expect(useGlobeStore.getState().activeBasemapId).toBe(basemapBefore);
    expect(useGlobeStore.getState().layerVisibility).toEqual(visibilityBefore);
  });
});
