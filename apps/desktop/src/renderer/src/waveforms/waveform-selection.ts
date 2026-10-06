import type { WaveformStationCatalogue } from '@terra-pulse/schema';
import { pickStationsNear, type DisplayStation, type WaveformPickPoint } from './station-pick';
import type { WaveformRegion } from './waveform-regions';

/**
 * What the waveform tab is showing, resolved from the store.
 *
 * Pure, and shared by the panel and the globe overlay: both need the same
 * stations, and computing them in one place is what keeps the rows and the
 * markers from disagreeing.
 */
export type WaveformSelection =
  | { kind: 'preset'; region: WaveformRegion; stations: DisplayStation[] }
  | {
      kind: 'picked';
      point: WaveformPickPoint | null;
      /** Why there are no stations, when there are none. */
      state: 'awaiting-click' | 'loading' | 'unavailable' | 'ready';
      reason: string | null;
      stations: DisplayStation[];
    };

const NO_STATIONS: DisplayStation[] = [];

export function resolveWaveformSelection(
  regionId: string,
  pickedRegionId: string,
  regions: readonly WaveformRegion[],
  pickPoint: WaveformPickPoint | null,
  catalogue: WaveformStationCatalogue | null,
): WaveformSelection | null {
  if (regionId !== pickedRegionId) {
    const region = regions.find((candidate) => candidate.id === regionId) ?? regions[0];
    if (region === undefined) return null;
    return {
      kind: 'preset',
      region,
      stations: region.channels.map((station) => ({ ...station, distanceKm: null, bearingDeg: null })),
    };
  }

  if (pickPoint === null) {
    return { kind: 'picked', point: null, state: 'awaiting-click', reason: null, stations: NO_STATIONS };
  }
  if (catalogue === null) {
    return { kind: 'picked', point: pickPoint, state: 'loading', reason: null, stations: NO_STATIONS };
  }
  if (catalogue.status === 'unavailable') {
    return {
      kind: 'picked',
      point: pickPoint,
      state: 'unavailable',
      reason: catalogue.reason,
      stations: NO_STATIONS,
    };
  }
  return {
    kind: 'picked',
    point: pickPoint,
    state: 'ready',
    reason: null,
    stations: pickStationsNear(pickPoint, catalogue.stations),
  };
}
