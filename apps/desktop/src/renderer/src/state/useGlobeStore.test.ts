import { beforeEach, describe, expect, it } from 'vitest';
import { HISTORICAL_DATA_SECTION_ID, useGlobeStore, type LocationSelection } from './useGlobeStore';
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

describe('inspector section expansion', () => {
  beforeEach(() => {
    useGlobeStore.setState({ expandedSections: {} });
  });

  it('starts with every section collapsed', () => {
    // The default that keeps the panel clear of the time scrubber, and the
    // default that means no section's IPC runs until it is asked for.
    expect(useGlobeStore.getState().expandedSections).toEqual({});
  });

  it('opens an untouched section on the first toggle', () => {
    // Absent has to read as collapsed. Comparing against `false` instead of
    // negating would make the first click on every section a no-op.
    useGlobeStore.getState().toggleSection('sequence');
    expect(useGlobeStore.getState().expandedSections['sequence']).toBe(true);
  });

  it('closes again on the second toggle', () => {
    useGlobeStore.getState().toggleSection('sequence');
    useGlobeStore.getState().toggleSection('sequence');
    expect(useGlobeStore.getState().expandedSections['sequence']).toBe(false);
  });

  it('keeps sections independent', () => {
    // Not a true accordion: these answer different questions and comparing two
    // at once is a reasonable thing to want.
    useGlobeStore.getState().toggleSection('sequence');
    useGlobeStore.getState().toggleSection('recurrence');

    const { expandedSections } = useGlobeStore.getState();
    expect(expandedSections['sequence']).toBe(true);
    expect(expandedSections['recurrence']).toBe(true);
  });

  it('survives changing the selection, because it lives in the store', () => {
    // The whole point of holding this here rather than in the panel: clicking
    // through the event list must not re-collapse what you opened.
    useGlobeStore.getState().toggleSection('recurrence');
    useGlobeStore.getState().selectLocation(probed);
    useGlobeStore.getState().selectLocation(null);

    expect(useGlobeStore.getState().expandedSections['recurrence']).toBe(true);
  });

  it('leaves the layer toggles alone', () => {
    // Shared store — a careless `set` here would replace rather than merge.
    const visibilityBefore = useGlobeStore.getState().layerVisibility;
    useGlobeStore.getState().toggleSection('fault');
    expect(useGlobeStore.getState().layerVisibility).toEqual(visibilityBefore);
  });
});

describe('the historical data section, which starts open', () => {
  // Reset to the shape the module actually initialises with — present and
  // true, not absent — rather than relying on load order against the other
  // describe block above, which resets to `{}` in its own `beforeEach`.
  beforeEach(() => {
    useGlobeStore.setState({ expandedSections: { [HISTORICAL_DATA_SECTION_ID]: true } });
  });

  it('reads open without ever being toggled', () => {
    expect(useGlobeStore.getState().expandedSections[HISTORICAL_DATA_SECTION_ID]).toBe(true);
  });

  it('closes on the first toggle, not the second', () => {
    // The bug this guards against: `toggleSection` negates the *raw* stored
    // value. If the key had been absent and only `CollapsibleSection`
    // defaulted it to open via a prop, this first toggle would negate
    // `undefined` to `true` — already-open staying open — and it would take
    // a second click to actually close it. Being present-and-true from the
    // start is what keeps the existing negation logic correct unmodified.
    useGlobeStore.getState().toggleSection(HISTORICAL_DATA_SECTION_ID);
    expect(useGlobeStore.getState().expandedSections[HISTORICAL_DATA_SECTION_ID]).toBe(false);
  });

  it('reopens on the second toggle', () => {
    useGlobeStore.getState().toggleSection(HISTORICAL_DATA_SECTION_ID);
    useGlobeStore.getState().toggleSection(HISTORICAL_DATA_SECTION_ID);
    expect(useGlobeStore.getState().expandedSections[HISTORICAL_DATA_SECTION_ID]).toBe(true);
  });
});
