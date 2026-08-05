import { describe, expect, it } from 'vitest';
import {
  formatSlipRate,
  formatSlipType,
  nearestFault,
  type FaultRecord,
} from './fault-association';

/** A fault along a meridian, from (lon, latFrom) to (lon, latTo). */
function meridianFault(lon: number, latFrom: number, latTo: number, extra: Partial<FaultRecord> = {}): FaultRecord {
  return { z: 0, p: [lon, latFrom, lon, latTo], ...extra };
}

describe('nearestFault', () => {
  it('returns null for an empty dataset', () => {
    expect(nearestFault({ latitude: 0, longitude: 0 }, [])).toBeNull();
  });

  it('finds the closer of two faults', () => {
    const near = meridianFault(0.1, -1, 1, { n: 'near' });
    const far = meridianFault(5, -1, 1, { n: 'far' });

    const match = nearestFault({ latitude: 0, longitude: 0 }, [far, near]);
    expect(match?.fault.n).toBe('near');
  });

  it('measures distance to the trace, roughly 111 km per degree', () => {
    const fault = meridianFault(1, -5, 5);
    const match = nearestFault({ latitude: 0, longitude: 0 }, [fault]);
    expect(match?.distanceKm).toBeCloseTo(111.3, 0);
  });

  it('measures to the nearest point on a segment, not to its endpoints', () => {
    // A point beside the middle of a long trace is 1 degree away, even though
    // both endpoints are far up and down the line.
    const fault = meridianFault(1, -20, 20);
    const match = nearestFault({ latitude: 0, longitude: 0 }, [fault]);
    expect(match?.distanceKm).toBeCloseTo(111.3, 0);
  });

  it('clamps to the segment ends rather than its infinite line', () => {
    // The point is off the *end* of the trace, so the nearest point is the
    // endpoint. Projecting onto the infinite line would report 0 km.
    const fault = meridianFault(0, 10, 20);
    const match = nearestFault({ latitude: 0, longitude: 0 }, [fault]);
    expect(match?.distanceKm).toBeCloseTo(10 * 111.32, -1);
  });

  it('accounts for longitude converging at high latitude', () => {
    // One degree of longitude is ~111 km at the equator and ~48 km at 64°N.
    const equator = nearestFault({ latitude: 0, longitude: 0 }, [meridianFault(1, -5, 5)]);
    const arctic = nearestFault({ latitude: 64, longitude: 0 }, [meridianFault(1, 60, 68)]);
    expect(equator?.distanceKm).toBeGreaterThan(110);
    expect(arctic?.distanceKm).toBeLessThan(55);
  });

  /**
   * Without normalising the longitude difference, a point at 179.9°E and a
   * fault at 179.9°W compute as 359.8° apart — about 40,000 km. Every event on
   * the Kuril, Aleutian and Tongan trenches would then match some fault on the
   * far side of the planet.
   */
  it('handles a fault across the antimeridian', () => {
    const acrossTheLine = meridianFault(-179.9, 45, 55, { n: 'across' });
    const genuinelyFar = meridianFault(100, 45, 55, { n: 'far' });

    const match = nearestFault({ latitude: 50, longitude: 179.9 }, [genuinelyFar, acrossTheLine]);
    expect(match?.fault.n).toBe('across');
    // 0.2° of longitude at 50°N is ~14 km, not 40,000.
    expect(match?.distanceKm).toBeLessThan(20);
  });

  it('handles the query point itself sitting across the line', () => {
    const fault = meridianFault(179.9, 45, 55, { n: 'east' });
    const match = nearestFault({ latitude: 50, longitude: -179.9 }, [fault]);
    expect(match?.fault.n).toBe('east');
    expect(match?.distanceKm).toBeLessThan(20);
  });

  it('reports a distance of about zero on the trace itself', () => {
    const match = nearestFault({ latitude: 0, longitude: 0 }, [meridianFault(0, -5, 5)]);
    expect(match?.distanceKm).toBeLessThan(0.001);
  });

  it('survives a single-vertex trace without dividing by zero', () => {
    // Degenerate geometry shouldn't poison the whole query for every other
    // fault in the dataset.
    const degenerate: FaultRecord = { z: 2, p: [10, 10] };
    const real = meridianFault(0.5, -1, 1, { n: 'real' });

    const match = nearestFault({ latitude: 0, longitude: 0 }, [degenerate, real]);
    expect(match?.fault.n).toBe('real');
    expect(Number.isFinite(match?.distanceKm ?? Number.NaN)).toBe(true);
  });

  it('walks every segment of a multi-segment trace', () => {
    // The nearest approach is in the third segment, so a version that only
    // checked the first would miss it.
    const zigzag: FaultRecord = { z: 0, p: [5, 5, 4, 4, 3, 3, 0.2, 0.2], n: 'zigzag' };
    const match = nearestFault({ latitude: 0, longitude: 0 }, [zigzag]);
    expect(match?.distanceKm).toBeLessThan(50);
  });

  it('still returns the nearest fault when it is very far away', () => {
    // Mid-ocean points are ~1,000 km from anything mapped. The function reports
    // the distance rather than deciding for the caller that it is too far —
    // that judgement belongs to the panel, which words it differently by band.
    const match = nearestFault({ latitude: -20, longitude: -140 }, [meridianFault(0, -5, 5)]);
    expect(match).not.toBeNull();
    expect(match?.distanceKm).toBeGreaterThan(1000);
  });
});

describe('formatSlipType', () => {
  it('humanises GEM codes', () => {
    expect(formatSlipType('Subduction_Thrust')).toBe('subduction thrust');
    expect(formatSlipType('Spreading_Ridge')).toBe('spreading ridge');
    expect(formatSlipType('Dextral')).toBe('dextral');
  });

  it('returns null for the 2.3% with no slip type', () => {
    expect(formatSlipType(undefined)).toBeNull();
    expect(formatSlipType('')).toBeNull();
  });
});

describe('formatSlipRate', () => {
  it('shows the preferred rate with its bounds', () => {
    // The San Andreas at Parkfield, as GEM records it.
    const fault: FaultRecord = { z: 0, p: [], s: 30.54, sl: 23.16, sh: 43.26 };
    expect(formatSlipRate(fault)).toBe('30.54 mm/yr (23.16–43.26)');
  });

  it('shows a bare rate when GEM gives no bounds', () => {
    expect(formatSlipRate({ z: 0, p: [], s: 8.16 })).toBe('8.16 mm/yr');
  });

  it('returns null for the ~26% with no measured rate', () => {
    expect(formatSlipRate({ z: 0, p: [] })).toBeNull();
  });

  it('does not mistake a zero slip rate for a missing one', () => {
    // GEM records genuine zeroes; `if (!fault.s)` would drop them.
    expect(formatSlipRate({ z: 0, p: [], s: 0 })).toBe('0 mm/yr');
  });
});
