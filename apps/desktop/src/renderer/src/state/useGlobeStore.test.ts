import { beforeEach, describe, expect, it } from 'vitest';
import { useGlobeStore, type LocationSelection } from './useGlobeStore';
import type { FaultRecord } from '../layers/fault-association';

const reset = () => useGlobeStore.setState({ faultProbeActive: false, location: null });

const PARKFIELD = { latitude: 35.9, longitude: -120.43 };
const FAULT: FaultRecord = { z: 0, p: [], n: 'San Andreas (Parkfield)', t: 'Dextral', s: 30.54 };

const probed: LocationSelection = { ...PARKFIELD, kind: 'point' };
const clickedFault: LocationSelection = { ...PARKFIELD, kind: 'fault', fault: FAULT };
const clickedBoundary: LocationSelection = {
  ...PARKFIELD,
  kind: 'boundary',
  pair: 'NA-PA',
  boundaryClass: 'CTF',
};

describe('fault probe mode', () => {
  beforeEach(reset);

  it('starts off, with nothing selected', () => {
    expect(useGlobeStore.getState().faultProbeActive).toBe(false);
    expect(useGlobeStore.getState().location).toBeNull();
  });

  it('toggles on and back off', () => {
    useGlobeStore.getState().toggleFaultProbe();
    expect(useGlobeStore.getState().faultProbeActive).toBe(true);

    useGlobeStore.getState().toggleFaultProbe();
    expect(useGlobeStore.getState().faultProbeActive).toBe(false);
  });

  /**
   * A probed *point* cannot be refreshed once the mode is off — there is no way
   * to click another one — so leaving it up would show a reading for a place the
   * user has stopped asking about.
   */
  it('drops a probed point when the mode is switched off', () => {
    useGlobeStore.getState().toggleFaultProbe();
    useGlobeStore.getState().selectLocation(probed);

    useGlobeStore.getState().toggleFaultProbe();
    expect(useGlobeStore.getState().location).toBeNull();
  });

  /**
   * A clicked fault or boundary is still perfectly meaningful with the mode off
   * — you reached it by clicking the line, not by probing — so closing it would
   * be gratuitous.
   */
  it('keeps a clicked fault when the mode is switched off', () => {
    useGlobeStore.getState().toggleFaultProbe();
    useGlobeStore.getState().selectLocation(clickedFault);

    useGlobeStore.getState().toggleFaultProbe();
    expect(useGlobeStore.getState().location).toEqual(clickedFault);
  });

  it('keeps a clicked boundary when the mode is switched off', () => {
    useGlobeStore.getState().toggleFaultProbe();
    useGlobeStore.getState().selectLocation(clickedBoundary);

    useGlobeStore.getState().toggleFaultProbe();
    expect(useGlobeStore.getState().location).toEqual(clickedBoundary);
  });

  it('does not clear anything merely by switching the mode on', () => {
    useGlobeStore.getState().selectLocation(clickedFault);
    useGlobeStore.getState().toggleFaultProbe();
    expect(useGlobeStore.getState().location).toEqual(clickedFault);
  });
});

describe('location selection', () => {
  beforeEach(reset);

  it('carries the coordinate alongside the feature', () => {
    // The coordinate is where the pointer was, not the feature's centroid —
    // recurrence has to answer for the place the user actually clicked.
    useGlobeStore.getState().selectLocation(clickedFault);
    const location = useGlobeStore.getState().location;
    expect(location?.latitude).toBe(PARKFIELD.latitude);
    expect(location?.longitude).toBe(PARKFIELD.longitude);
    expect(location?.kind).toBe('fault');
  });

  it('replaces one selection with the next rather than accumulating', () => {
    useGlobeStore.getState().selectLocation(clickedFault);
    useGlobeStore.getState().selectLocation(clickedBoundary);
    expect(useGlobeStore.getState().location).toEqual(clickedBoundary);
  });

  it('closes on null', () => {
    useGlobeStore.getState().selectLocation(probed);
    useGlobeStore.getState().selectLocation(null);
    expect(useGlobeStore.getState().location).toBeNull();
  });

  it('leaves the basemap and layer toggles alone', () => {
    // They share a store; a careless `set` would replace rather than merge and
    // silently reset every layer toggle.
    const basemapBefore = useGlobeStore.getState().activeBasemapId;
    const visibilityBefore = useGlobeStore.getState().layerVisibility;

    useGlobeStore.getState().toggleFaultProbe();
    useGlobeStore.getState().selectLocation(probed);

    expect(useGlobeStore.getState().activeBasemapId).toBe(basemapBefore);
    expect(useGlobeStore.getState().layerVisibility).toEqual(visibilityBefore);
  });
});
