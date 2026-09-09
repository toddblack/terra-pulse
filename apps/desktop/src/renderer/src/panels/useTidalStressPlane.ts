import { useMemo } from 'react';
import { ACTIVE_FAULTS } from '../layers/fault-data';
import { faultStrikeDeg, nearestFault, type FaultRecord } from '../layers/fault-association';
import { useEarthquakeStore, selectEventById } from '../state/useEarthquakeStore';
import { useGlobeStore } from '../state/useGlobeStore';
import { MAX_MEANINGFUL_KM } from './NearestFault';
import type { FaultPlane } from './tidal-stress-track';

/**
 * Which fault plane the tidal-stress row should resolve stress onto, given
 * whatever the user currently has selected.
 *
 * ## Why every unusable case is named rather than collapsed to null
 *
 * The row has to say something different in each of them, and this project has
 * a standing habit of drawing absence rather than leaving a blank that reads as
 * a zero. "Nothing is selected" invites a click; "GEM never measured a dip for
 * this trace" is a fact about the dataset and applies to **78.3%** of it; "the
 * nearest mapped fault is 400 km away" is a fact about where you pointed. A
 * single null would present all three as the same silence.
 *
 * ## Where the point comes from, and the precedence rule
 *
 * The same three paths that reach `NearestFaultBody` and `LocationPanel`: a
 * selected earthquake, a clicked fault or boundary, or a probed point. A
 * location wins over an earthquake selection when both are set, because
 * clicking a trace or probing a point is the more specific act — and the row
 * names the fault it settled on in its own caption, so the choice is never
 * something the reader has to infer.
 *
 * A directly clicked fault is used as-is rather than re-derived: `nearestFault`
 * from a point *on* a trace should return that same trace, but "should" is not
 * a guarantee worth resting on when the answer is already in hand.
 *
 * ## Cost
 *
 * `nearestFault` is a brute-force sweep over 157,548 vertices, measured at
 * ~1.1 ms — fine on a selection change, which is the only thing that can move
 * this. Memoised on the coordinate rather than on the selection object so a
 * store write that leaves the point alone does not re-run it.
 */
export type TidalPlaneState =
  | { kind: 'none' }
  | { kind: 'no-plane'; fault: FaultRecord }
  | { kind: 'too-far'; distanceKm: number }
  | { kind: 'ready'; plane: FaultPlane; fault: FaultRecord; distanceKm: number };

/**
 * Only the faults that can actually answer — those carrying both dip and rake.
 *
 * **Searching the full dataset and then checking was a real defect**, found by
 * the user reporting that most selections showed nothing. `nearestFault` returns
 * the single nearest trace; GEM publishes dip and rake for **21.7%** of them, so
 * roughly four times in five that nearest trace could not be resolved onto and
 * the row gave up — *even when a perfectly usable fault sat slightly further
 * away*. Measured against 650 real M4.5+ events over 30 days: the old behaviour
 * answered **23.2%**, filtering the pool first answers **50.0%**.
 *
 * Built once at module scope: it is a filter over 13,696 static records, and
 * re-deriving it per selection would be pure waste.
 */
export const FAULTS_WITH_PLANE = ACTIVE_FAULTS.filter(
  (fault) => fault.d !== undefined && fault.r !== undefined,
);

/**
 * `enabled` is the row's own visibility. Passed in rather than read here so the
 * 157,548-vertex sweep is skipped entirely while the row is switched off — a
 * hook cannot be called conditionally, but the work inside it can be.
 */
export function useTidalStressPlane(enabled: boolean): TidalPlaneState {
  const location = useGlobeStore((state) => state.location);
  const selectedEventId = useEarthquakeStore((state) => state.selectedEventId);
  const selectedEvent = useEarthquakeStore((state) => selectEventById(state, selectedEventId));

  // Narrowed to primitives before the memo, so an unrelated store write that
  // produces a new object identity for the same place cannot re-run the sweep.
  const latitude = location?.latitude ?? selectedEvent?.latitude ?? null;
  const longitude = location?.longitude ?? selectedEvent?.longitude ?? null;
  const clickedFault = location?.kind === 'fault' ? location.fault : null;

  return useMemo<TidalPlaneState>(() => {
    if (!enabled) return { kind: 'none' };
    if (latitude === null || longitude === null) return { kind: 'none' };
    const point = { latitude, longitude };

    // A clicked trace is the cleanest case of the three: distance is zero by
    // construction, so none of the "is this fault even related" hedging that
    // NearestFaultBody carries applies here.
    //
    // **It is also the one case that does NOT search the filtered pool.** When
    // someone points at a specific trace, the honest answer about *that trace*
    // is "GEM reported no dip for it" — silently answering about a different
    // fault nearby would change the subject without saying so. Only the
    // nearest-to-a-point paths search for a fault that can answer.
    const match = clickedFault
      ? { fault: clickedFault, distanceKm: 0 }
      : nearestFault(point, FAULTS_WITH_PLANE);
    if (!match) return { kind: 'none' };

    if (match.distanceKm > MAX_MEANINGFUL_KM) {
      return { kind: 'too-far', distanceKm: match.distanceKm };
    }

    const { fault } = match;
    if (fault.d === undefined || fault.r === undefined) return { kind: 'no-plane', fault };

    // Strike is read from the trace segment nearest the point the reader
    // actually pointed at, never the trace's centroid — the same rule
    // TidalShear.tsx follows, and the reason the resulting sign is not
    // trustworthy. See `tidal-stress-track.ts`.
    const strikeDeg = faultStrikeDeg(fault, point);
    if (strikeDeg === null) return { kind: 'no-plane', fault };

    return {
      kind: 'ready',
      plane: {
        latitudeDeg: latitude,
        longitudeDeg: longitude,
        strikeDeg,
        dipDeg: fault.d,
        rakeDeg: fault.r,
      },
      fault,
      distanceKm: match.distanceKm,
    };
  }, [enabled, latitude, longitude, clickedFault]);
}
