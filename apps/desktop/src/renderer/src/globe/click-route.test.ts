import { describe, expect, it } from 'vitest';
import { routeGlobeClick, type ResolvedClick } from './click-route';

const QUAKE: ResolvedClick = { eventId: 'us7000abcd', hasFeature: false, hasSolarEvent: false };
const FAULT: ResolvedClick = { eventId: null, hasFeature: true, hasSolarEvent: false };
const FLARE: ResolvedClick = { eventId: null, hasFeature: false, hasSolarEvent: true };
/** A magnetometer or planet: hoverable, but nothing to open. */
const HOVER_ONLY: ResolvedClick = { eventId: null, hasFeature: false, hasSolarEvent: false };

/** The dock on its timeline tab. */
const EXPLORE = { faultProbeActive: false, waveformsPicking: false };
/** The dock on its waveform tab, open or minimised. */
const WAVEFORMS = { faultProbeActive: false, waveformsPicking: true };

describe('routeGlobeClick', () => {
  it('opens an earthquake with the waveform tab up — the reason the mode went away', () => {
    expect(routeGlobeClick(QUAKE, WAVEFORMS)).toEqual({ kind: 'select', eventId: 'us7000abcd' });
  });

  it('picks stations on bare globe only while the dock is on its waveform tab', () => {
    expect(routeGlobeClick(null, WAVEFORMS)).toEqual({ kind: 'deselect', pickStations: true });
    expect(routeGlobeClick(null, EXPLORE)).toEqual({ kind: 'deselect', pickStations: false });
  });

  it('treats a mark with nothing to open as bare globe', () => {
    // A click on a magnetometer has only ever deselected; with waveforms up it
    // also picks, rather than becoming the one dead spot on the globe.
    expect(routeGlobeClick(HOVER_ONLY, WAVEFORMS)).toEqual({ kind: 'deselect', pickStations: true });
  });

  it('opens solar markers as in Explore, whatever the dock shows', () => {
    for (const modes of [EXPLORE, WAVEFORMS]) {
      expect(routeGlobeClick(FLARE, modes)).toEqual({ kind: 'solar-event' });
    }
  });

  it('opens a fault panel, and also picks there while on the waveform tab', () => {
    // Around Burbank nearly every pixel is a fault trace; without this, picking
    // stations there barely worked.
    expect(routeGlobeClick(FAULT, EXPLORE)).toEqual({ kind: 'location', pickStations: false });
    expect(routeGlobeClick(FAULT, WAVEFORMS)).toEqual({ kind: 'location', pickStations: true });
  });

  it('lets the fault probe win over everything until it is switched off', () => {
    const probing = { faultProbeActive: true, waveformsPicking: true };
    for (const resolved of [null, QUAKE, FAULT, FLARE]) {
      expect(routeGlobeClick(resolved, probing)).toEqual({ kind: 'probe' });
    }
  });
});
