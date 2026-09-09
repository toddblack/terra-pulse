import { useEffect, useMemo, useState } from 'react';
import type { MagnetometerSeries, MagnetometerStation } from '@terra-pulse/schema';
import { useEarthquakeStore, selectEventById } from '../state/useEarthquakeStore';
import { useGlobeStore } from '../state/useGlobeStore';
import { MAGNETOMETER_MAX_WINDOW_HOURS } from './magnetometer-track';

/**
 * Which station the magnetometer row describes, and its trace over the window.
 *
 * ## Nearest to the selection, not a station you pick
 *
 * §5.5 says "selected magnetometer station traces", and this is the cheaper
 * reading of it: the row follows whatever is already selected — an earthquake,
 * a probed point, a clicked fault — and takes the nearest of the ~31 USGS
 * stations, exactly as the tidal row follows the nearest mapped fault. No new
 * pick target, no fourth selection kind in the store.
 *
 * It also answers the better question. "What was the ground field doing near
 * this earthquake?" is what a reader of this app wants; "show me Fredericksburg
 * regardless of what I am looking at" is a monitoring tool, and a different
 * app. Explicit station picking would be a real addition on top of this, not a
 * replacement for it.
 *
 * ## The network is only reached while the row is on
 *
 * `enabled` is the row's visibility. A trace is up to four upstream requests
 * and 43,200 samples, so a switched-off row must cost nothing — the same rule
 * `useTec` follows for its 2.4 MB maps.
 */
export interface NearestStation {
  station: MagnetometerStation;
  distanceKm: number;
}

export type MagnetometerRowState =
  | { kind: 'no-selection' }
  | { kind: 'no-stations' }
  | { kind: 'window-too-long' }
  | { kind: 'loading'; nearest: NearestStation }
  | { kind: 'no-coverage'; nearest: NearestStation }
  | { kind: 'ready'; nearest: NearestStation; series: MagnetometerSeries };

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance, km. */
function haversineKm(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * The nearest station to a point.
 *
 * Exported for its test: with ~31 stations a linear scan is nothing, but the
 * *answer* matters — the network is thin and heavily northern (10 of 31 below
 * 45 degrees), so "nearest" is frequently thousands of kilometres away and the
 * row has to be able to say so.
 */
export function nearestStation(
  point: { latitude: number; longitude: number },
  stations: readonly MagnetometerStation[],
): NearestStation | null {
  let best: NearestStation | null = null;
  for (const station of stations) {
    const distanceKm = haversineKm(
      point.latitude,
      point.longitude,
      station.latitude,
      station.longitude,
    );
    if (!best || distanceKm < best.distanceKm) best = { station, distanceKm };
  }
  return best;
}

export function useMagnetometerRow(
  enabled: boolean,
  startMs: number,
  endMs: number,
): MagnetometerRowState {
  const readings = useGlobeStore((state) => state.magnetometerReadings);
  const location = useGlobeStore((state) => state.location);
  const selectedEventId = useEarthquakeStore((state) => state.selectedEventId);
  const selectedEvent = useEarthquakeStore((state) => selectEventById(state, selectedEventId));

  // Narrowed to primitives before the memo, so a store write that leaves the
  // place alone cannot re-run the scan or, worse, refire the fetch.
  const latitude = location?.latitude ?? selectedEvent?.latitude ?? null;
  const longitude = location?.longitude ?? selectedEvent?.longitude ?? null;

  const nearest = useMemo(() => {
    if (!enabled || latitude === null || longitude === null) return null;
    const stations = readings.map((reading) => reading.station);
    return nearestStation({ latitude, longitude }, stations);
  }, [enabled, latitude, longitude, readings]);

  const tooLong = endMs - startMs > MAGNETOMETER_MAX_WINDOW_HOURS * 3_600_000;

  const code = nearest?.station.code ?? null;
  // Rounded to the minute before becoming a fetch key. The window's edges move
  // continuously in live mode (`useNow` ticks, and the end carries an hour of
  // margin), so keying on the raw millisecond would refetch 43,000 samples
  // every thirty seconds for a trace that has not meaningfully changed.
  const startKey = Math.floor(startMs / 60_000) * 60_000;
  const endKey = Math.floor(endMs / 60_000) * 60_000;
  const requestKey =
    enabled && !tooLong && code !== null ? `${code}|${String(startKey)}|${String(endKey)}` : null;

  /**
   * The last answer, **stored against the request it describes**.
   *
   * Not a bare `series` plus a `loading` flag, for two reasons. It makes a
   * stale reply *unrenderable* rather than merely unlikely — scrubbing fires
   * overlapping requests with no ordering guarantee, and one station's trace
   * under another station's name would look entirely normal, which is the same
   * failure `useAftershockSequence` is keyed by event id to prevent. And it
   * makes "are we loading?" a derived comparison instead of a second piece of
   * state that an effect has to clear, which React's own lint rule rightly
   * rejects.
   */
  const [loaded, setLoaded] = useState<{ key: string; series: MagnetometerSeries | null } | null>(
    null,
  );

  useEffect(() => {
    if (requestKey === null || code === null) return;

    let cancelled = false;
    void window.terraPulse.magnetometer
      .series({
        code,
        startUtc: new Date(startKey).toISOString(),
        endUtc: new Date(endKey).toISOString(),
      })
      .then(
        (result) => {
          if (!cancelled) setLoaded({ key: requestKey, series: result });
        },
        (error: unknown) => {
          console.error('Failed to read the magnetometer series', error);
          // Recorded against the key rather than left pending, or the row would
          // sit on "loading" forever after a transport failure.
          if (!cancelled) setLoaded({ key: requestKey, series: null });
        },
      );

    return () => {
      cancelled = true;
    };
  }, [requestKey, code, startKey, endKey]);

  const current = loaded && loaded.key === requestKey ? loaded : null;
  const series = current?.series ?? null;
  const loading = requestKey !== null && current === null;

  if (!enabled) return { kind: 'no-selection' };
  if (latitude === null || longitude === null) return { kind: 'no-selection' };
  // Before the first poll lands there is no station list at all, which is a
  // different thing from having one and finding nothing near.
  if (!nearest) return { kind: 'no-stations' };
  if (tooLong) return { kind: 'window-too-long' };
  if (loading) return { kind: 'loading', nearest };
  if (!series || series.samples.length === 0) return { kind: 'no-coverage', nearest };
  return { kind: 'ready', nearest, series };
}
