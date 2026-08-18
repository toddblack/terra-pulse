import { describe, expect, it, vi } from 'vitest';
import { flareAtLeast, isDirectImpact } from '@terra-pulse/schema';
import {
  DONKI_DEMO_KEY,
  DonkiRateLimitError,
  fetchSolarFlares,
  parseCmeArrivals,
  parseFlareClass,
  parseFlares,
} from './nasa-donki';

/** DONKI's real flare shape, trimmed. Note the seconds-less timestamps. */
const flare = (overrides: Record<string, unknown> = {}) => ({
  flrID: '2026-08-10T12:34:00-FLR-001',
  catalog: 'M2M_CATALOG',
  instruments: [{ displayName: 'GOES-P: EXIS 1.0-8.0' }],
  beginTime: '2026-08-10T12:34Z',
  peakTime: '2026-08-10T13:16Z',
  endTime: '2026-08-10T13:38Z',
  classType: 'M2.4',
  sourceLocation: 'N14W102',
  activeRegionNum: 13842,
  link: 'https://example.test/flr',
  ...overrides,
});

describe('parseFlareClass', () => {
  it('splits the letter from the magnitude', () => {
    expect(parseFlareClass('M2.4')).toEqual({ flareClass: 'M', magnitude: 2.4 });
    expect(parseFlareClass('X8')).toEqual({ flareClass: 'X', magnitude: 8 });
    expect(parseFlareClass('B2.3')).toEqual({ flareClass: 'B', magnitude: 2.3 });
  });

  it('handles the large X values that do occur', () => {
    // X28 is roughly the largest ever recorded. The magnitude is unbounded above
    // within a class, unlike the letters.
    expect(parseFlareClass('X28.0')).toEqual({ flareClass: 'X', magnitude: 28 });
  });

  it('returns null rather than guessing at anything unparseable', () => {
    expect(parseFlareClass('')).toBeNull();
    expect(parseFlareClass('M')).toBeNull();
    expect(parseFlareClass('Z1.0')).toBeNull();
    expect(parseFlareClass(null)).toBeNull();
    expect(parseFlareClass(42)).toBeNull();
  });
});

describe('flareAtLeast', () => {
  const at = (classType: string) => parseFlares([flare({ classType })])[0]!;

  it('orders across classes, which a string compare gets wrong', () => {
    // "M9.9" sorts after "X1.0" lexically, and is a hundred times weaker.
    expect(flareAtLeast(at('X1.0'), 'M', 1)).toBe(true);
    expect(flareAtLeast(at('M9.9'), 'X', 1)).toBe(false);
  });

  it('compares magnitude within a class', () => {
    expect(flareAtLeast(at('M1.0'), 'M', 1)).toBe(true);
    expect(flareAtLeast(at('M0.9'), 'M', 1)).toBe(false);
    expect(flareAtLeast(at('C9.9'), 'M', 1)).toBe(false);
  });

  it('answers H1s registered trigger — M1.0 or above', () => {
    expect(flareAtLeast(at('M1.0'), 'M')).toBe(true);
    expect(flareAtLeast(at('X2.2'), 'M')).toBe(true);
    expect(flareAtLeast(at('C8.1'), 'M')).toBe(false);
  });
});

describe('parseFlares', () => {
  it('reads a flare and normalises its seconds-less timestamps', () => {
    // DONKI publishes `2026-08-10T12:34Z`. Every other time in this app is a
    // full ISO instant, and a consumer comparing the two formats would be
    // comparing different shapes without noticing.
    const [parsed] = parseFlares([flare()]);
    expect(parsed?.peakTimeUtc).toBe('2026-08-10T13:16:00.000Z');
    expect(parsed?.beginTimeUtc).toBe('2026-08-10T12:34:00.000Z');
    expect(parsed?.flareClass).toBe('M');
    expect(parsed?.magnitude).toBe(2.4);
    expect(parsed?.activeRegionNumber).toBe(13842);
  });

  it('keeps the source location as published, past the limb included', () => {
    // W102 is beyond the visible disc — a real value that a naive coordinate
    // parse would silently accept as a point on the face of the Sun.
    expect(parseFlares([flare()])[0]?.sourceLocation).toBe('N14W102');
  });

  it('drops a record it cannot place or compare', () => {
    // No peak time, no id, or an unreadable class: each makes the record
    // useless on a timeline, so it is dropped rather than half-stored.
    expect(parseFlares([flare({ peakTime: null })])).toHaveLength(0);
    expect(parseFlares([flare({ flrID: null })])).toHaveLength(0);
    expect(parseFlares([flare({ classType: 'unknown' })])).toHaveLength(0);
  });

  it('tolerates missing optional fields', () => {
    const [parsed] = parseFlares([
      flare({ beginTime: null, endTime: null, sourceLocation: null, activeRegionNum: null }),
    ]);
    expect(parsed?.peakTimeUtc).toBeTruthy();
    expect(parsed?.beginTimeUtc).toBeNull();
    expect(parsed?.sourceLocation).toBeNull();
    expect(parsed?.activeRegionNumber).toBeNull();
  });

  it('does not dedupe, because DONKI does not duplicate', () => {
    // Checked on two full years: 127 M/X records with 127 unique ids in 2015,
    // 382 and 382 in 2023. The API returns the current version of each flare,
    // not its revision history — so two records with different ids are two
    // flares, and collapsing them would lose one.
    const two = parseFlares([
      flare({ flrID: 'a', peakTime: '2026-08-10T13:16Z' }),
      flare({ flrID: 'b', peakTime: '2026-08-10T13:16Z' }),
    ]);
    expect(two).toHaveLength(2);
  });

  it('rejects a payload that is not an array', () => {
    expect(() => parseFlares(null)).toThrow();
    expect(() => parseFlares({ error: 'rate limited' })).toThrow();
  });
});

const simulation = (overrides: Record<string, unknown> = {}) => ({
  simulationID: 'WSA-ENLIL/1234',
  modelCompletionTime: '2026-07-01T10:00Z',
  estimatedShockArrivalTime: '2026-07-05T12:00Z',
  kp_90: 5,
  isEarthGB: false,
  isEarthMinorImpact: false,
  link: 'https://example.test/enlil',
  ...overrides,
});

describe('parseCmeArrivals', () => {
  it('reads an arrival and its predicted geoeffectiveness', () => {
    const [arrival] = parseCmeArrivals([simulation()]);
    expect(arrival?.arrivalTimeUtc).toBe('2026-07-05T12:00:00.000Z');
    expect(arrival?.predictedKp).toBe(5);
    expect(arrival?.glancingBlow).toBe(false);
  });

  it('keeps only the runs that reach Earth', () => {
    // Measured over ten weeks: 79 of 325 runs carry an Earth arrival. The rest
    // are CMEs modelled to miss us — several carry arrivals at *other*
    // spacecraft, which is why the Earth-specific field is what gets filtered on.
    const parsed = parseCmeArrivals([
      simulation(),
      simulation({ simulationID: 'misses', estimatedShockArrivalTime: null }),
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.simulationId).toBe('WSA-ENLIL/1234');
  });

  it('flags a glancing blow, which is not the same event as a hit', () => {
    // A graze can carry a predicted Kp of 2 — barely geoeffective. Pooling
    // those with direct hits dilutes a trigger set with events that were never
    // going to do anything.
    const [graze] = parseCmeArrivals([simulation({ isEarthGB: true, kp_90: 2 })]);
    expect(graze?.glancingBlow).toBe(true);
    expect(isDirectImpact(graze!)).toBe(false);

    const [hit] = parseCmeArrivals([simulation()]);
    expect(isDirectImpact(hit!)).toBe(true);
  });

  it('treats a minor impact as not a direct hit either', () => {
    const [minor] = parseCmeArrivals([simulation({ isEarthMinorImpact: true })]);
    expect(isDirectImpact(minor!)).toBe(false);
  });

  it('keeps a null predicted Kp null rather than zero', () => {
    // Zero Kp is a real quiet reading; "the model did not produce one" is not.
    const [arrival] = parseCmeArrivals([simulation({ kp_90: null })]);
    expect(arrival?.predictedKp).toBeNull();
  });

  it('rejects a payload that is not an array', () => {
    expect(() => parseCmeArrivals(null)).toThrow();
  });
});

describe('rate limiting', () => {
  it('throws DonkiRateLimitError, not a plain Error, on HTTP 429', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    });

    await expect(
      fetchSolarFlares(new Date('2026-01-01'), new Date('2026-01-02'), DONKI_DEMO_KEY, fetchImpl),
    ).rejects.toBeInstanceOf(DonkiRateLimitError);
  });
});
