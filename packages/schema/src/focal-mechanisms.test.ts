import { describe, expect, it } from 'vitest';
import {
  MECHANISM_JOIN_RADIUS_KM,
  MECHANISM_JOIN_WINDOW_MS,
  MECHANISM_STABLE_MIN_MAGNITUDE,
  GCMT_START_YEAR,
  matchMechanisms,
  momentMagnitude,
  type FocalMechanism,
} from './focal-mechanisms';

function mechanism(overrides: Partial<FocalMechanism> & Pick<FocalMechanism, 'id' | 'timeUtc'>): FocalMechanism {
  return {
    latitude: 0,
    longitude: 0,
    depthKm: 10,
    magnitude: 6,
    scalarMomentDyneCm: 1e25,
    nodalPlane1: { strike: 10, dip: 20, rake: 30 },
    nodalPlane2: { strike: 100, dip: 70, rake: 80 },
    centroidLatitude: 0,
    centroidLongitude: 0,
    centroidDepthKm: 10,
    referenceCatalog: 'PDE',
    ...overrides,
  };
}

describe('momentMagnitude', () => {
  it('uses the dyne-cm form of Kanamori’s relation', () => {
    // Tohoku 2011: 5.312e29 dyne-cm is Mw 9.08. The N-m constant (9.1 rather
    // than 16.1) would give 7.88 — still a believable magnitude, which is why
    // the unit is pinned rather than left to a comment.
    expect(momentMagnitude(5.312e29)).toBeCloseTo(9.08, 2);
    // 1e26 dyne-cm is exactly Mw 6.6.
    expect(momentMagnitude(1e26)).toBeCloseTo(6.6, 2);
  });
});

describe('registered constants', () => {
  it('pins the floor H6 registers, which is not the shared M5.0+', () => {
    // Orientation coverage of the target set swings 2.0x across the record at
    // M5.0+ and is near-flat at M5.5+. Lowering this silently would reintroduce
    // a time-varying completeness into the target set.
    expect(MECHANISM_STABLE_MIN_MAGNITUDE).toBe(5.5);
  });

  it('starts at 1976, where Global CMT does', () => {
    // The shared catalogue reaches 1970 and the deep tier 1900, but no
    // orientation exists before this.
    expect(GCMT_START_YEAR).toBe(1976);
  });
});

describe('matchMechanisms', () => {
  it('attaches the mechanism at the same instant and place', () => {
    const events = [{ timeUtc: '2011-03-11T05:46:23.000Z', latitude: 38.32, longitude: 142.37 }];
    const mechanisms = [
      mechanism({ id: 'M201103110546A', timeUtc: '2011-03-11T05:46:23.000Z', latitude: 38.32, longitude: 142.37 }),
    ];

    const { matched, unmatched } = matchMechanisms(events, mechanisms);
    expect(unmatched).toHaveLength(0);
    expect(matched[0]!.mechanism.id).toBe('M201103110546A');
    expect(matched[0]!.distanceKm).toBeCloseTo(0, 3);
    expect(matched[0]!.timeOffsetSeconds).toBe(0);
  });

  it('takes the nearest in space, not the first in time', () => {
    // Aftershock sequences put several M5.5+ events inside one minute, so
    // "first inside the window" is not reliably the right mechanism.
    const events = [{ timeUtc: '2011-03-11T05:46:23.000Z', latitude: 38.32, longitude: 142.37 }];
    const mechanisms = [
      mechanism({ id: 'earlier-but-far', timeUtc: '2011-03-11T05:45:40.000Z', latitude: 38.9, longitude: 142.9 }),
      mechanism({ id: 'later-but-near', timeUtc: '2011-03-11T05:46:31.000Z', latitude: 38.33, longitude: 142.38 }),
    ];

    const { matched } = matchMechanisms(events, mechanisms);
    expect(matched[0]!.mechanism.id).toBe('later-but-near');
  });

  it('reports an event with nothing inside the bounds as unmatched', () => {
    // The common case, not an edge case: orientation coverage of M5.5+ runs
    // 84-95%, so one event in ten or twenty has no mechanism at all.
    const events = [{ timeUtc: '2011-03-11T05:46:23.000Z', latitude: 38.32, longitude: 142.37 }];
    const mechanisms = [
      mechanism({ id: 'too-far', timeUtc: '2011-03-11T05:46:23.000Z', latitude: 20, longitude: 142.37 }),
    ];

    const { matched, unmatched } = matchMechanisms(events, mechanisms);
    expect(matched).toHaveLength(0);
    expect(unmatched).toHaveLength(1);
  });

  it('rejects a mechanism just outside the time window', () => {
    const events = [{ timeUtc: '2020-01-01T00:00:00.000Z', latitude: 0, longitude: 0 }];
    const justInside = mechanism({ id: 'inside', timeUtc: '2020-01-01T00:00:59.000Z' });
    const justOutside = mechanism({ id: 'outside', timeUtc: '2020-01-01T00:01:01.000Z' });

    expect(matchMechanisms(events, [justInside]).matched).toHaveLength(1);
    expect(matchMechanisms(events, [justOutside]).unmatched).toHaveLength(1);
  });

  it('sweeps forward once rather than scanning per event', () => {
    // Correctness check on the two-pointer sweep: every event must find its own
    // mechanism even though the left edge only ever advances.
    const events = Array.from({ length: 200 }, (_, index) => ({
      timeUtc: new Date(Date.UTC(2020, 0, 1) + index * 3_600_000).toISOString(),
      latitude: 10,
      longitude: 20,
    }));
    const mechanisms = events.map((event, index) =>
      mechanism({ id: `m${String(index)}`, timeUtc: event.timeUtc, latitude: 10, longitude: 20 }),
    );

    const { matched, unmatched } = matchMechanisms(events, mechanisms);
    expect(unmatched).toHaveLength(0);
    expect(matched.map((m) => m.mechanism.id)).toEqual(mechanisms.map((m) => m.id));
  });

  it('refuses unsorted input rather than returning a partial join', () => {
    // The sweep is only linear because both sides are ordered. Out of order it
    // would return a plausible subset with no error at all, which is the worst
    // available outcome for a join feeding a registered analysis.
    const events = [
      { timeUtc: '2020-01-02T00:00:00.000Z', latitude: 0, longitude: 0 },
      { timeUtc: '2020-01-01T00:00:00.000Z', latitude: 0, longitude: 0 },
    ];
    expect(() => matchMechanisms(events, [])).toThrow(/sorted by timeUtc ascending/);
  });

  it('refuses an unparseable timestamp', () => {
    const events = [{ timeUtc: 'not a date', latitude: 0, longitude: 0 }];
    expect(() => matchMechanisms(events, [])).toThrow(/unparseable timeUtc/);
  });

  it('honours caller-supplied bounds', () => {
    const events = [{ timeUtc: '2020-01-01T00:00:00.000Z', latitude: 0, longitude: 0 }];
    const far = mechanism({ id: 'far', timeUtc: '2020-01-01T00:00:00.000Z', latitude: 2, longitude: 0 });

    // ~222 km away: outside the default radius, inside a widened one.
    expect(matchMechanisms(events, [far]).matched).toHaveLength(0);
    expect(matchMechanisms(events, [far], MECHANISM_JOIN_WINDOW_MS, 300).matched).toHaveLength(1);
  });

  it('gives a contested mechanism to its nearest claimant', () => {
    // The real shape, from C032378C on the live catalogue: a mainshock sits
    // 0.2 km from its own mechanism, and a smaller event seconds later — which
    // CMT never inverted, because the mainshock swamps it — was taking that
    // same mechanism from 89.7 km away.
    const events = [
      { timeUtc: '1978-03-23T23:15:00.000Z', latitude: 44.9, longitude: 149.0 },
      { timeUtc: '1978-03-23T23:15:57.000Z', latitude: 44.1, longitude: 148.0 },
    ];
    const mechanisms = [
      mechanism({ id: 'C032378C', timeUtc: '1978-03-23T23:15:00.000Z', latitude: 44.9, longitude: 149.0 }),
    ];

    const { matched, unmatched } = matchMechanisms(events, mechanisms);
    expect(matched).toHaveLength(1);
    expect(matched[0]!.event.timeUtc).toBe('1978-03-23T23:15:00.000Z');
    // The far claimant is returned unmatched rather than given someone else's
    // fault orientation.
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]!.timeUtc).toBe('1978-03-23T23:15:57.000Z');
  });

  it('never hands one mechanism to two events', () => {
    const events = Array.from({ length: 5 }, (_, index) => ({
      timeUtc: new Date(Date.UTC(2020, 0, 1, 0, 0, index * 10)).toISOString(),
      latitude: 10 + index * 0.05,
      longitude: 20,
    }));
    const mechanisms = [
      mechanism({ id: 'only-one', timeUtc: '2020-01-01T00:00:20.000Z', latitude: 10.1, longitude: 20 }),
    ];

    const { matched, unmatched } = matchMechanisms(events, mechanisms);
    expect(matched).toHaveLength(1);
    expect(unmatched).toHaveLength(4);
  });

  it('keeps matches in chronological order after resolving contests', () => {
    // The engine's target set has to come out identically on every run, so the
    // contest resolution must not reorder what survives it.
    const events = [
      { timeUtc: '2020-01-01T00:00:00.000Z', latitude: 0, longitude: 0 },
      { timeUtc: '2020-01-01T00:00:30.000Z', latitude: 5, longitude: 0 },
      { timeUtc: '2020-01-01T00:01:30.000Z', latitude: 10, longitude: 0 },
    ];
    const mechanisms = [
      mechanism({ id: 'first', timeUtc: '2020-01-01T00:00:00.000Z', latitude: 0, longitude: 0 }),
      mechanism({ id: 'third', timeUtc: '2020-01-01T00:01:30.000Z', latitude: 10, longitude: 0 }),
    ];

    const { matched } = matchMechanisms(events, mechanisms);
    expect(matched.map((m) => m.mechanism.id)).toEqual(['first', 'third']);
  });

  it('pins the join bounds to the measured match population', () => {
    // Chosen from the distribution rather than picked: p99 offsets across
    // 53,000 real matches are 7.9 s and 40 km.
    expect(MECHANISM_JOIN_WINDOW_MS).toBe(60_000);
    expect(MECHANISM_JOIN_RADIUS_KM).toBe(100);
  });
});
