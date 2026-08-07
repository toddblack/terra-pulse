import { describe, expect, it } from 'vitest';
import {
  PLATE_BOUNDARIES,
  boundaryBreakdown,
  nearestPlateBoundary,
  plateBoundaryLabel,
  plateClassLabel,
  type PlateBoundarySegment,
} from './plate-association';

/** A boundary running north-south along a meridian. */
function meridian(b: string, c: string, lon: number, from = -5, to = 5): PlateBoundarySegment {
  return { b, c, g: 'convergent', p: [lon, from, lon, to] };
}

describe('plateBoundaryLabel', () => {
  it.each([
    ['PA\\OK', 'Pacific–Okhotsk'],
    ['NZ\\SA', 'Nazca–South America'],
    ['NA/PA', 'North America–Pacific'],
    ['AF-AN', 'Africa–Antarctica'],
    ['KE-AU', 'Kermadec–Australia'],
  ])('renders %s as %s', (pair, expected) => {
    expect(plateBoundaryLabel(pair)).toBe(expected);
  });

  /**
   * PB2002's `/` and `\` encode which plate subducts. Decoding it wrongly would
   * be a confident false claim about the tectonics, so the label states the pair
   * and leaves polarity to the class.
   */
  it('does not assert subduction polarity', () => {
    expect(plateBoundaryLabel('PA\\OK')).toBe(plateBoundaryLabel('PA/OK'));
  });

  it('falls back to the raw code for an unknown plate', () => {
    // A future PB2002 revision should degrade to something lookup-able, not
    // to the word "Unknown".
    expect(plateBoundaryLabel('ZZ-PA')).toBe('ZZ–Pacific');
  });

  it('passes through anything that is not a plate pair', () => {
    expect(plateBoundaryLabel('nonsense')).toBe('nonsense');
  });

  it('names every plate code present in the real dataset', () => {
    // Guards the table against the dataset: a code with no name would surface
    // as two bare letters in the panel.
    const codes = new Set<string>();
    for (const segment of PLATE_BOUNDARIES) {
      const match = /^([A-Z]{2})[\\/-]([A-Z]{2})$/.exec(segment.b);
      if (match) {
        codes.add(match[1] as string);
        codes.add(match[2] as string);
      }
    }
    expect(codes.size).toBeGreaterThan(40);
    for (const code of codes) {
      expect(plateBoundaryLabel(`${code}-PA`)).not.toMatch(new RegExp(`^${code}–`));
    }
  });
});

describe('plateClassLabel', () => {
  it('spells out the PB2002 classes', () => {
    expect(plateClassLabel('SUB')).toBe('subduction zone');
    expect(plateClassLabel('OSR')).toBe('spreading ridge');
    expect(plateClassLabel('CTF')).toBe('continental transform');
  });

  it('passes an unknown class through', () => {
    expect(plateClassLabel('XYZ')).toBe('XYZ');
  });
});

describe('nearestPlateBoundary', () => {
  it('returns null for an empty dataset', () => {
    expect(nearestPlateBoundary({ latitude: 0, longitude: 0 }, [])).toBeNull();
  });

  it('finds the closer of two boundaries', () => {
    const near = meridian('PA\\OK', 'SUB', 0.5);
    const far = meridian('AF-AN', 'OSR', 8);
    const match = nearestPlateBoundary({ latitude: 0, longitude: 0 }, [far, near]);
    expect(match?.segment.b).toBe('PA\\OK');
  });

  it('measures roughly 111 km per degree', () => {
    const match = nearestPlateBoundary({ latitude: 0, longitude: 0 }, [meridian('A-B', 'SUB', 1)]);
    expect(match?.distanceKm).toBeCloseTo(111.3, 0);
  });

  /** Same guard the fault association needs: the Kuril and Tongan arcs. */
  it('handles a boundary across the antimeridian', () => {
    const across = meridian('PA\\OK', 'SUB', -179.9, 45, 55);
    const far = meridian('AF-AN', 'OSR', 100, 45, 55);
    const match = nearestPlateBoundary({ latitude: 50, longitude: 179.9 }, [far, across]);
    expect(match?.segment.b).toBe('PA\\OK');
    expect(match?.distanceKm).toBeLessThan(20);
  });

  it('works against the real dataset', () => {
    // Tokyo sits near a triple junction; whatever comes back must at least be a
    // real, close boundary rather than something on the far side of the world.
    const match = nearestPlateBoundary({ latitude: 35.68, longitude: 139.77 });
    expect(match).not.toBeNull();
    expect(match?.distanceKm).toBeLessThan(300);
  });
});

describe('boundaryBreakdown', () => {
  const boundaries = [meridian('PA\\OK', 'SUB', 0), meridian('OK-AM', 'CCB', 10)];

  it('is empty for no events', () => {
    expect(boundaryBreakdown([], boundaries)).toEqual([]);
  });

  it('counts events against the boundary each is nearest to', () => {
    const result = boundaryBreakdown(
      [
        { latitude: 0, longitude: 0.1 },
        { latitude: 1, longitude: 0.2 },
        { latitude: 0, longitude: 9.9 },
      ],
      boundaries,
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ pair: 'PA\\OK', count: 2, label: 'Pacific–Okhotsk' });
    expect(result[1]).toMatchObject({ pair: 'OK-AM', count: 1 });
  });

  it('ranks the dominant boundary first', () => {
    // The Tokyo case: the region's events are dominated by one boundary even
    // though several are nearby, and that dominance is the finding.
    const events = [
      ...Array.from({ length: 5 }, () => ({ latitude: 0, longitude: 0.1 })),
      { latitude: 0, longitude: 9.9 },
    ];
    expect(boundaryBreakdown(events, boundaries)[0]?.pair).toBe('PA\\OK');
  });

  it('orders ties stably rather than arbitrarily', () => {
    // Equal counts must not swap places between renders — the panel would
    // reshuffle on every poll.
    const events = [
      { latitude: 0, longitude: 0.1 },
      { latitude: 0, longitude: 9.9 },
    ];
    const first = boundaryBreakdown(events, boundaries).map((s) => s.pair);
    const second = boundaryBreakdown([...events].reverse(), boundaries).map((s) => s.pair);
    expect(second).toEqual(first);
  });

  it('carries the boundary class through for context', () => {
    const result = boundaryBreakdown([{ latitude: 0, longitude: 0.1 }], boundaries);
    expect(result[0]?.classLabel).toBe('subduction zone');
  });
});
