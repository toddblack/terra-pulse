import { describe, expect, it } from 'vitest';
import { WAVEFORM_MAX_CHANNELS, haversineKm, type WaveformStation } from '@terra-pulse/schema';
import {
  WAVEFORM_PICK_MIN_SEPARATION_KM,
  azimuthalGapDeg,
  bearingDeg,
  compassPoint,
  formatDistanceKm,
  formatPickCoordinates,
  pickStationsNear,
} from './station-pick';

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

const SEATTLE = { latitude: 47.6, longitude: -122.3 };
const KM_PER_DEGREE_LAT = 111.2;

/** A station `km` due north of Seattle. */
function north(code: string, km: number): WaveformStation {
  return station(code, SEATTLE.latitude + km / KM_PER_DEGREE_LAT, SEATTLE.longitude);
}

/** A station roughly `km` south-east of Seattle. */
function southEast(code: string, km: number): WaveformStation {
  const leg = km / Math.SQRT2;
  const kmPerDegreeLon = KM_PER_DEGREE_LAT * Math.cos((SEATTLE.latitude * Math.PI) / 180);
  return station(code, SEATTLE.latitude - leg / KM_PER_DEGREE_LAT, SEATTLE.longitude + leg / kmPerDegreeLon);
}

describe('pickStationsNear', () => {
  it('returns stations nearest first, with distance and direction from the pick', () => {
    const picked = pickStationsNear(SEATTLE, [north('FAR', 220), north('NEAR', 11), north('MID', 110)]);
    expect(picked.map((s) => s.station)).toEqual(['NEAR', 'MID', 'FAR']);
    expect(picked[0]?.distanceKm).toBeCloseTo(11, 0);
    expect(picked[0]?.bearingDeg).toBeCloseTo(0, 0);
  });

  it('reaches into an empty direction before crowding one side — the Burbank case', () => {
    // Twelve stations strung north, one 120 km south-east. Nearest-first spends
    // every slot on the north and leaves a hole facing the south-east; the
    // surround rule gives that direction its station.
    const crowd = Array.from({ length: 12 }, (_, i) => north(`N${String(i)}`, 10 + i * 30));
    const picked = pickStationsNear(SEATTLE, [...crowd, southEast('SE', 120)]);

    expect(picked).toHaveLength(WAVEFORM_MAX_CHANNELS);
    expect(picked.map((s) => s.station)).toContain('SE');
    expect(compassPoint(picked.find((s) => s.station === 'SE')?.bearingDeg ?? 0)).toBe('SE');
  });

  it('does not fill a direction from beyond the sector radius', () => {
    // At 200 km the south-east station is outside the 150 km radius, so it
    // earns no sector of its own; closer stations to the north win the slots.
    const crowd = [north('A', 10), north('B', 40), north('C', 70), north('D', 100)];
    expect(pickStationsNear(SEATTLE, [...crowd, southEast('FAR_SE', 200)], 4).map((s) => s.station)).toEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
    // ...whereas within it, the direction is filled at the cost of the farthest north.
    expect(
      pickStationsNear(SEATTLE, [...crowd, southEast('NEAR_SE', 120)], 4).map((s) => s.station),
    ).toEqual(['A', 'B', 'C', 'NEAR_SE']);
  });

  it('skips a station that sits on top of one already chosen — two networks on one site', () => {
    // The measured Tokyo case: two stations 0 km apart.
    const picked = pickStationsNear(SEATTLE, [
      station('A', 47.61, -122.3),
      station('A_TWIN', 47.611, -122.3),
      north('B', 50),
    ]);
    expect(picked.map((s) => s.station)).toEqual(['A', 'B']);
  });

  it('keeps every chosen pair at least the minimum separation apart', () => {
    // A dense cluster — the Puget Sound shape — 2 km apart in a line, 300 km
    // long so that ten 25 km-separated picks fit along it.
    const cluster = Array.from({ length: 150 }, (_, i) => north(`S${String(i)}`, i * 2));
    const picked = pickStationsNear(SEATTLE, cluster);

    expect(picked).toHaveLength(WAVEFORM_MAX_CHANNELS);
    for (const a of picked) {
      for (const b of picked) {
        if (a !== b) expect(haversineKm(a, b)).toBeGreaterThanOrEqual(WAVEFORM_PICK_MIN_SEPARATION_KM);
      }
    }
  });

  it('still answers where nothing is within the sector radius, however far that is', () => {
    // Mid-ocean: no direction has a station within 150 km, so the nearest-first
    // pass does all the work — the row distances say how far.
    const picked = pickStationsNear({ latitude: 0, longitude: -150 }, [
      station('HAWAII', 19.7, -155.1),
      station('TAHITI', -17.6, -149.4),
    ]);
    expect(picked.map((s) => s.station)).toEqual(['TAHITI', 'HAWAII']);
    expect(picked[0]?.distanceKm).toBeGreaterThan(1_900);
  });

  it('returns fewer than the cap when fewer exist, and nothing from an empty list', () => {
    expect(pickStationsNear(SEATTLE, [north('ONLY', 11)])).toHaveLength(1);
    expect(pickStationsNear(SEATTLE, [])).toEqual([]);
  });

  it('measures across the antimeridian rather than the long way round', () => {
    const picked = pickStationsNear({ latitude: -17, longitude: 179.9 }, [
      station('WEST', -17, -179.9),
      station('EAST', -17, 175),
    ]);
    expect(picked[0]?.station).toBe('WEST');
    expect(picked[0]?.distanceKm).toBeLessThan(25);
  });

  it('does not mutate the catalogue it was given', () => {
    const catalogue = [north('B', 50), north('A', 11)];
    pickStationsNear(SEATTLE, catalogue);
    expect(catalogue.map((s) => s.station)).toEqual(['B', 'A']);
    expect(catalogue[0]).not.toHaveProperty('distanceKm');
  });
});

describe('bearings', () => {
  it('reads clockwise from north', () => {
    expect(bearingDeg({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 })).toBeCloseTo(0, 6);
    expect(bearingDeg({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 })).toBeCloseTo(90, 6);
    expect(bearingDeg({ latitude: 0, longitude: 0 }, { latitude: -1, longitude: 0 })).toBeCloseTo(180, 6);
    expect(bearingDeg({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: -1 })).toBeCloseTo(270, 6);
  });

  it('names eight compass points, with each sector centred on its point', () => {
    expect(compassPoint(0)).toBe('N');
    expect(compassPoint(22)).toBe('N');
    expect(compassPoint(23)).toBe('NE');
    expect(compassPoint(130)).toBe('SE');
    expect(compassPoint(337)).toBe('NW');
    expect(compassPoint(338)).toBe('N');
  });

  it('measures the widest uncovered arc, wrapping through north', () => {
    expect(azimuthalGapDeg([0, 90, 180, 270].map((bearing) => ({ bearingDeg: bearing })))).toBe(90);
    expect(azimuthalGapDeg([{ bearingDeg: 350 }, { bearingDeg: 10 }])).toBe(340);
    expect(azimuthalGapDeg([{ bearingDeg: 45 }])).toBe(360);
    expect(azimuthalGapDeg([{ bearingDeg: null }, { bearingDeg: 10 }])).toBe(360);
  });
});

describe('formatting', () => {
  it('names a bare pick by its coordinates with hemisphere letters', () => {
    expect(formatPickCoordinates({ latitude: 47.6062, longitude: -122.3321 })).toBe('47.61°N 122.33°W');
    expect(formatPickCoordinates({ latitude: -33.45, longitude: 151.2 })).toBe('33.45°S 151.20°E');
  });

  it('rounds distances and groups thousands', () => {
    expect(formatDistanceKm(41.6)).toBe('42 km');
    expect(formatDistanceKm(1152.7)).toBe('1,153 km');
  });
});
