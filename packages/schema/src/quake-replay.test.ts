import { describe, expect, it } from 'vitest';
import { detectorLimit, replayEligible, type ReplayDetectorReach } from './quake-replay';

describe('replayEligible', () => {
  it("offers any M5+, wherever it is — the user's floor", () => {
    expect(replayEligible({ magnitude: 5 })).toBe(true);
    expect(replayEligible({ magnitude: 9.1 })).toBe(true);
    expect(replayEligible({ magnitude: 4.9 })).toBe(false);
  });
});

describe('detectorLimit', () => {
  const reach: ReplayDetectorReach = {
    radiusKm: 300,
    stations: 12,
    stationsWithData: 10,
    nearestKm: 20,
    minStations: 4,
    maxNearestStationKm: 50,
  };

  it('needs enough stations with data and one close enough to locate from', () => {
    expect(detectorLimit(reach)).toBeNull();
    expect(detectorLimit({ ...reach, stationsWithData: 3 })).toBe('too-few-stations');
    // Plenty of stations, all too far for the associator's search grid — an
    // offshore quake behind a dense coast.
    expect(detectorLimit({ ...reach, nearestKm: 80 })).toBe('too-far');
    expect(detectorLimit({ ...reach, stationsWithData: 0, nearestKm: null })).toBe('too-few-stations');
  });
});
