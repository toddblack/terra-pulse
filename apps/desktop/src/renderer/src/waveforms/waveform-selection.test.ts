import { describe, expect, it } from 'vitest';
import type { WaveformStation, WaveformStationCatalogue } from '@terra-pulse/schema';
import { resolveWaveformSelection } from './waveform-selection';
import type { WaveformRegion } from './waveform-regions';

const PICKED = 'picked';

function station(code: string, latitude: number, longitude: number): WaveformStation {
  return {
    network: 'XX',
    station: code,
    location: '',
    channel: 'HHZ',
    latitude,
    longitude,
    site: code,
    sampleRateHz: 100,
  };
}

const SOCAL: WaveformRegion = {
  id: 'socal',
  label: 'Southern California',
  network: 'CI',
  channel: 'HHZ',
  note: 'Caltech/USGS.',
  channels: [station('ADO', 34.5, -117.4)],
};
const PNW: WaveformRegion = { ...SOCAL, id: 'pnw', label: 'Pacific Northwest', channels: [station('RATT', 47.6, -122.3)] };
const REGIONS = [SOCAL, PNW];

const READY: WaveformStationCatalogue = {
  status: 'ready',
  fetchedAtMs: 1,
  stations: [station('NEAR', 47.7, -122.3), station('FAR', 34, -118)],
};
const SEATTLE = { latitude: 47.6, longitude: -122.3, label: null };

describe('resolveWaveformSelection', () => {
  it('shows a preset as it was vendored, with no distances — it has no pick to be distant from', () => {
    const selection = resolveWaveformSelection('pnw', PICKED, REGIONS, SEATTLE, READY);
    expect(selection?.kind).toBe('preset');
    expect(selection?.stations).toEqual([
      { ...station('RATT', 47.6, -122.3), distanceKm: null, bearingDeg: null },
    ]);
  });

  it('falls back to the first preset for an id it does not know', () => {
    const selection = resolveWaveformSelection('gone', PICKED, REGIONS, null, null);
    expect(selection?.kind === 'preset' && selection.region.id).toBe('socal');
  });

  it('asks for a click before there is one, rather than streaming nothing silently', () => {
    const selection = resolveWaveformSelection(PICKED, PICKED, REGIONS, null, READY);
    expect(selection).toMatchObject({ kind: 'picked', state: 'awaiting-click', stations: [] });
  });

  it('says it is loading when the click lands before the station list', () => {
    const selection = resolveWaveformSelection(PICKED, PICKED, REGIONS, SEATTLE, null);
    expect(selection).toMatchObject({ kind: 'picked', state: 'loading', stations: [] });
  });

  it("carries main's reason when the list is unavailable, so a failure is not read as an empty region", () => {
    const selection = resolveWaveformSelection(PICKED, PICKED, REGIONS, SEATTLE, {
      status: 'unavailable',
      reason: 'the ring is down',
    });
    expect(selection).toMatchObject({ state: 'unavailable', reason: 'the ring is down', stations: [] });
  });

  it('picks from the live list, nearest first, with distances', () => {
    const selection = resolveWaveformSelection(PICKED, PICKED, REGIONS, SEATTLE, READY);
    expect(selection?.kind === 'picked' && selection.state).toBe('ready');
    expect(selection?.stations.map((s) => s.station)).toEqual(['NEAR', 'FAR']);
    expect(selection?.stations[0]?.distanceKm).toBeCloseTo(11.1, 0);
  });
});
