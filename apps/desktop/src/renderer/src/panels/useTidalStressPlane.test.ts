import { describe, expect, it } from 'vitest';
import { ACTIVE_FAULTS } from '../layers/fault-data';
import { nearestFault } from '../layers/fault-association';
import { FAULTS_WITH_PLANE } from './useTidalStressPlane';

/**
 * The regression these pin was found by the user, not by a test: "most
 * earthquakes I select show nothing on the tidal row."
 *
 * The cause was searching all 13,696 GEM traces for the nearest one and *then*
 * checking whether it carried a dip and rake. Only 21.7% do, so four times in
 * five the nearest trace could not be resolved onto and the row gave up — even
 * with a usable fault a few kilometres further out. Measured over 650 real
 * M4.5+ events across 30 days: 23.2% answered before, 50.0% after.
 */
describe('the pool the tidal row searches', () => {
  it('holds only faults that can actually be resolved onto', () => {
    for (const fault of FAULTS_WITH_PLANE) {
      expect(fault.d).toBeTypeOf('number');
      expect(fault.r).toBeTypeOf('number');
    }
  });

  it('is the measured 21.7% of the dataset', () => {
    // Pins the vendored coverage. If a re-vendor changes it, the numbers in
    // this file's own comments and in the row's guide are stale and should be
    // re-measured rather than quietly drifting.
    expect(ACTIVE_FAULTS.length).toBeGreaterThan(13_000);
    expect(FAULTS_WITH_PLANE.length).toBeGreaterThan(2_500);
    const share = FAULTS_WITH_PLANE.length / ACTIVE_FAULTS.length;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.25);
  });

  it('is smaller than the full set, or filtering it is pointless', () => {
    expect(FAULTS_WITH_PLANE.length).toBeLessThan(ACTIVE_FAULTS.length);
  });

  it('finds an answerable fault where searching everything gives up', () => {
    // The defect in one assertion. Scan the real dataset for a place where the
    // nearest trace of all carries no plane but a nearby one does — that is
    // precisely the case the old code answered "no dip reported" to, and the
    // new code answers properly.
    let demonstrated = 0;

    for (const candidate of ACTIVE_FAULTS) {
      if (candidate.d !== undefined) continue;
      const longitude = candidate.p[0];
      const latitude = candidate.p[1];
      if (longitude === undefined || latitude === undefined) continue;

      const point = { latitude, longitude };
      const anyFault = nearestFault(point, ACTIVE_FAULTS);
      const answerable = nearestFault(point, FAULTS_WITH_PLANE);

      if (
        anyFault &&
        answerable &&
        anyFault.fault.d === undefined &&
        answerable.distanceKm <= 150
      ) {
        demonstrated += 1;
        if (demonstrated >= 20) break;
      }
    }

    // Not a handful of curiosities — this is the ordinary case, which is why
    // it cost more than half the feature's coverage.
    expect(demonstrated).toBe(20);
  });
});
