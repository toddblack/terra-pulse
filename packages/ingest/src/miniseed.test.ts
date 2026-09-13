import { describe, expect, it } from 'vitest';
import { MiniSeedParseError, parseMiniSeedRecord, sampleRateFrom } from './miniseed';
import { MiniSeedIntegrityError } from './steim';

/**
 * Real 512-byte records, captured 2026-09-10 UTC from the EarthScope ring
 * (`rtserve.iris.washington.edu:18000`, SeedLink 3.1).
 *
 * The expected values below were derived by a separate throwaway script
 * reading the raw bytes, not by the parser under test, so these assertions are
 * not the parser agreeing with itself. X0/Xn are the record's own integration
 * constants — the parser landing on Xn is the proof the Steim-2 decode is right.
 *
 * Two have blank location codes and one (`IU AFI 10`) does not, which is the
 * mix the ring actually carries: blank on 95-100% of regional stations, real
 * codes on nearly all of the global network.
 */
const REAL_RECORDS = {
  CI_ADO_HHZ:
    'ODI0Mjg3RCBBRE8gICAgSEhaQ0kH6gD9BikCAAe/AOEAZAABACAAAgAAAAAAQAAwA+gAOAsBCQAD6QAAZF1GBwKqqqoAAApDAAAIRYFoAL3ybNoDv02CbYGb/6m9s3x0+CVF0tsB+mHKgH8EgQqAzr8IgMqBKH9959sHQ4BY/3EqqqqqvviAf4EOgZXAHLSv0FG5JL/2fGu/wQKH5lrlyM//8wa+837jgKICmP+YcZ3Y3LxcgGh81b3R//OAE4FBKqqqqoJNg2q/a/1Z5jngWoFvAP1///0t8Wn2G4HphZKA630+vv7+ar3IgF6CDQGugHJ+Z76oApCCM/8GvkF8cSqqqqq+qICEgWuEEoByfTb2oGtrgTYDr7/TfWe+q3t/v68Fy4ICf3O/v/0NvgUBuoF9ACSAcIMSgGB72r88ATsqqqqqvpf/eNy5PUOCVwF2vqB9Ub/f+/S/SwWEgWoAXb+f/qe+eHwygSWFEIEygcS+R3iTv7gDqIEfgliAZX0PKqqqqr9qgrbGugRmv/D9ML66AXSB9AQAgZB767sh/aqCJQJGgSiBfr8vgEeBUYEOv4V9m+duv6XT1Gu+v89+viqqqqq+fv7SgR4ChYEpgE2+R30dgRGDCtUmCwC++X5D8xcUh4BVgDK96fvWgFUEJYJYgNG983wPv6YEJYE6fz0=',
  NN_BMHS_HHZ:
    'MDAwMDAxRCBCTUhTICAgSEhaTk4H6gD9Big5AA9bAOcAZAABAAAAAgAAAAAAQAAwA+gAOAsBCQAD6QAAAB4AAAKqqqoAAC4VAAAt0YGHfpTgRfUNv1//fYFAfbS/pALtvv5/AdGx8jO/loM+/Jk8kt4gNrGB6IAKvZiBvYEgfNYqqqqqv5YDpr9L/YOBlv48vqWDWIAN/PuANYLAvzx/qYHrfd6/agJxgJAAWb5BAEWBEX5VgGF/bL6gAFWByX+4Kqqqqr3PAZmAZ/6tgaN/z+aCmB/9S7EvxP6JSujAq+y/0wJ8vpT8yoERgg/GIMzSvyp/rYEVfj39Jl6h9sGs8CaqqqrCPYzF+LduDb7m/s6BXf7ZvumCZNHaO/iBlf9/vpkBSsZw34ruH0ZggWQBeL5WgM/fPHI02J3KJ4IW/ssqqqqqvooC480O69bLeqo0gXr/dL7IfxeAZ4N246s95uXdIaeAMvyfgMuD/b25gI+B9/20gBUBX77N/lqB+wE8Kqqqqr4C/4iAwYIEv8X9cP7OrYOAUfzkv18BbYHV/pi+NQN3v+f+zYF7fY2/IQQrgN370b+Xg4i+z//gghr9FCqqqqq94IKNgoH+4b3ZAHLGGhyBgLh/Tb7gAmqAtf0hgQeB2r5yfnKBiADCvv2DAr8ve+uCDgE2vfyAJ4Io/pk=',
  IU_AFI_BHZ:
    'MDc4MDM2RCBBRkkgIDEwQkhaSVUH6gD9Big3ACTlAM4AKAABACAAAgAAAAAAQAAwA+gAOAsBCQAD6QAAZCZGBwKqqqoAAAi7AAAC5YAe+R+C5oDDvcoEW77k/WeAsgKwvoL614VffiK6GAnegRF2HILdgI+9kQNx+pFnFX//+R8qqqqqvdINO4SX7bm/Z4feu2oFUYVffH+3V/mJkB6KZKpxfcmSifvCtyr6noVvjEe3hIAvhUh0coMghAe5uQX2KqqqqoAD/LGEn3Z6vo0H17qfh+eGVm6wvO8JTYDr/n69+gHxgjj69r1hBRKDsPyDu9uAjoLwA7S+zvtLgkX9jCqqqqq9p4lyvqL5OYHHBleBSHOrv8SMXL5x+6i+1X83hRz/nbrTggKChIB2gUD/DLzHgJ+Bcf1LgsMC8LrqhPIqqqqqhGx5mr7ef76AdoOu7AmNaoC2fa2Ae4Rnvpp7zIHngbe9xQMngMv6BIESg6u/M/xCgSIHcry2eudAAAkyKqqqqoHG+P27/wRXhot9A7pohfiCaXfjv12C54GFBZW8afzHgzn7z4EXgJm+/wTXvhkBUIKC+6q83YL/hDr8wyqqqqq+Z4LRvr6AR784AMuEW3yZvMsCRoBbfCaBS4Pdvx8C5b8m/RKAegFJgR58rb60ATGB7ANUvs/9vr/8/Kc=',
} as const;

const EXPECTED = [
  {
    key: 'CI_ADO_HHZ' as const,
    channel: { network: 'CI', station: 'ADO', location: '', channel: 'HHZ' },
    channelId: 'CI_ADO__HHZ',
    // 2026-09-10T06:41:02.1983Z plus blockette 1001's 93 microseconds.
    startTimeMs: 1789022462198.393,
    sampleRateHz: 100,
    numSamples: 225,
    x0: 2627,
    xn: 2117,
  },
  {
    key: 'NN_BMHS_HHZ' as const,
    channel: { network: 'NN', station: 'BMHS', location: '', channel: 'HHZ' },
    channelId: 'NN_BMHS__HHZ',
    startTimeMs: 1789022457393.13,
    sampleRateHz: 100,
    numSamples: 231,
    x0: 11797,
    xn: 11729,
  },
  {
    key: 'IU_AFI_BHZ' as const,
    channel: { network: 'IU', station: 'AFI', location: '10', channel: 'BHZ' },
    channelId: 'IU_AFI_10_BHZ',
    startTimeMs: 1789022455944.538,
    sampleRateHz: 40,
    numSamples: 206,
    x0: 2235,
    xn: 741,
  },
];

function realRecord(key: keyof typeof REAL_RECORDS): Uint8Array {
  return new Uint8Array(Buffer.from(REAL_RECORDS[key], 'base64'));
}

describe('parseMiniSeedRecord on real ring records', () => {
  it.each(EXPECTED)('decodes $channelId exactly', (expected) => {
    const record = parseMiniSeedRecord(realRecord(expected.key));
    if (record.kind !== 'data') throw new Error(`expected data, got ${record.kind}`);

    expect(record.channel).toEqual(expected.channel);
    expect(record.channelId).toBe(expected.channelId);
    expect(record.quality).toBe('D');
    expect(record.encoding).toBe(11);
    expect(record.sampleRateHz).toBe(expected.sampleRateHz);
    expect(record.startTimeMs).toBeCloseTo(expected.startTimeMs, 3);
    expect(record.samples.length).toBe(expected.numSamples);
    expect(record.samples[0]).toBe(expected.x0);
    expect(record.samples[expected.numSamples - 1]).toBe(expected.xn);
  });

  it('a single flipped data byte fails the integrity check instead of decoding quietly', () => {
    // Proves the Xn check is load-bearing rather than decorative. Take the first
    // data word in frame 1 and flip its bit 0. Every Steim packing right-aligns
    // its last field at bit 0 (and bit 0 is never a sign bit), so whichever
    // packing the live signal used, that field moves by exactly one, every
    // later sample shifts by one, and the decode misses Xn by one.
    //
    // Not "find a 4 x 8-bit word": this 100 Hz record uses none in frame 1 —
    // its differences are large enough to need the wider Steim-2 packings.
    const bytes = realRecord('CI_ADO_HHZ');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frameStart = 64 + 64;
    const nibbleWord = view.getUint32(frameStart, false);
    let flipped = false;
    for (let w = 1; w < 16 && !flipped; w += 1) {
      if (((nibbleWord >>> (30 - 2 * w)) & 0b11) !== 0) {
        const lowByte = frameStart + w * 4 + 3;
        bytes[lowByte] = (bytes[lowByte] ?? 0) ^ 0x01;
        flipped = true;
      }
    }
    expect(flipped).toBe(true);

    let caught: unknown;
    try {
      parseMiniSeedRecord(bytes);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MiniSeedIntegrityError);
    const integrity = caught as MiniSeedIntegrityError;
    expect(integrity.expected).toBe(2117);
    expect(Math.abs(integrity.reached - integrity.expected)).toBe(1);
  });
});

/** A synthetic 512-byte record with blockette 1000 at 48 and 1001 at 56. */
interface RecordSpec {
  littleEndian?: boolean;
  encoding?: number;
  samples?: number[];
  wordOrderByte?: number;
  includeB1000?: boolean;
  microseconds?: number | null;
  rateFactor?: number;
  rateMultiplier?: number;
  year?: number;
  dayOfYear?: number;
  hour?: number;
  minute?: number;
  second?: number;
  tenThousandths?: number;
}

function ascii(bytes: Uint8Array, at: number, width: number, text: string): void {
  for (let i = 0; i < width; i += 1) {
    bytes[at + i] = (text.charCodeAt(i) || 0x20) & 0xff;
  }
}

function buildRecord(spec: RecordSpec = {}): Uint8Array {
  const le = spec.littleEndian ?? false;
  const encoding = spec.encoding ?? 3;
  const samples = spec.samples ?? [10, -20, 30];
  const includeB1000 = spec.includeB1000 ?? true;
  const microseconds = spec.microseconds === undefined ? 0 : spec.microseconds;

  const bytes = new Uint8Array(512);
  const view = new DataView(bytes.buffer);
  ascii(bytes, 0, 6, '000001');
  bytes[6] = 'D'.charCodeAt(0);
  bytes[7] = 0x20;
  ascii(bytes, 8, 5, 'TEST');
  ascii(bytes, 13, 2, '');
  ascii(bytes, 15, 3, 'HHZ');
  ascii(bytes, 18, 2, 'XX');

  view.setUint16(20, spec.year ?? 2026, le);
  view.setUint16(22, spec.dayOfYear ?? 253, le);
  view.setUint8(24, spec.hour ?? 6);
  view.setUint8(25, spec.minute ?? 41);
  view.setUint8(26, spec.second ?? 2);
  view.setUint16(28, spec.tenThousandths ?? 1983, le);
  view.setUint16(30, samples.length, le);
  view.setInt16(32, spec.rateFactor ?? 100, le);
  view.setInt16(34, spec.rateMultiplier ?? 1, le);

  const blockettes = (includeB1000 ? 1 : 0) + (microseconds !== null ? 1 : 0);
  view.setUint8(39, blockettes);
  view.setUint16(44, 64, le);

  if (includeB1000) {
    view.setUint16(46, 48, le);
    view.setUint16(48, 1000, le);
    view.setUint16(50, microseconds !== null ? 56 : 0, le);
    view.setUint8(52, encoding);
    view.setUint8(53, spec.wordOrderByte ?? (le ? 0 : 1));
    view.setUint8(54, 9); // 2^9 = 512
  } else if (microseconds !== null) {
    view.setUint16(46, 56, le);
  }
  if (microseconds !== null) {
    view.setUint16(56, 1001, le);
    view.setUint16(58, 0, le);
    view.setInt8(61, microseconds);
  }

  samples.forEach((sample, i) => {
    if (encoding === 1) view.setInt16(64 + i * 2, sample, le);
    else view.setInt32(64 + i * 4, sample, le);
  });
  return bytes;
}

describe('parseMiniSeedRecord on synthetic records', () => {
  it('reads a big-endian INT32 record', () => {
    const record = parseMiniSeedRecord(buildRecord({ samples: [10, -20, 30] }));
    if (record.kind !== 'data') throw new Error('expected data');
    expect(Array.from(record.samples)).toEqual([10, -20, 30]);
    expect(record.channelId).toBe('XX_TEST__HHZ');
    // Day 253 of 2026 is 10 September; 1983 ten-thousandths is 198.3 ms.
    expect(record.startTimeMs).toBeCloseTo(Date.parse('2026-09-10T06:41:02.198Z') + 0.3, 6);
  });

  it('reads the byte-swapped record identically', () => {
    const big = parseMiniSeedRecord(buildRecord({ littleEndian: false, samples: [7, -8, 2 ** 30] }));
    const little = parseMiniSeedRecord(buildRecord({ littleEndian: true, samples: [7, -8, 2 ** 30] }));
    if (big.kind !== 'data' || little.kind !== 'data') throw new Error('expected data');
    expect(Array.from(little.samples)).toEqual(Array.from(big.samples));
    expect(little.startTimeMs).toBe(big.startTimeMs);
    expect(little.sampleRateHz).toBe(big.sampleRateHz);
  });

  it('sign-extends INT16 samples', () => {
    const record = parseMiniSeedRecord(buildRecord({ encoding: 1, samples: [-1, -32768, 32767] }));
    if (record.kind !== 'data') throw new Error('expected data');
    expect(Array.from(record.samples)).toEqual([-1, -32768, 32767]);
  });

  it('throws when the start-time heuristic and blockette 1000 disagree on byte order', () => {
    // Big-endian header, blockette 1000 claiming little-endian. Never silently
    // prefer one: a disagreement means the heuristic matched noise.
    expect(() => parseMiniSeedRecord(buildRecord({ littleEndian: false, wordOrderByte: 0 }))).toThrow(
      /disagrees with blockette 1000/,
    );
  });

  it('returns a log record for encoding 0 rather than throwing', () => {
    // RingServer sends INFO/log records down the data connection. Throwing on
    // one would take a healthy stream down.
    const record = parseMiniSeedRecord(buildRecord({ encoding: 0 }));
    expect(record.kind).toBe('log');
    expect(record.channelId).toBe('XX_TEST__HHZ');
  });

  it('throws when blockette 1000 is absent instead of assuming an encoding', () => {
    expect(() => parseMiniSeedRecord(buildRecord({ includeB1000: false }))).toThrow(/blockette 1000/);
  });

  it('rejects an unsupported encoding by number', () => {
    expect(() => parseMiniSeedRecord(buildRecord({ encoding: 30 }))).toThrow(
      /unsupported data encoding 30/,
    );
  });

  it('rejects a start time implausible in both byte orders', () => {
    expect(() => parseMiniSeedRecord(buildRecord({ year: 1, dayOfYear: 0 }))).toThrow(
      MiniSeedParseError,
    );
  });

  it('rejects a record with no usable sample rate', () => {
    expect(() => parseMiniSeedRecord(buildRecord({ rateFactor: 0 }))).toThrow(/sample rate/);
  });

  it('rejects a buffer shorter than the fixed header', () => {
    expect(() => parseMiniSeedRecord(new Uint8Array(40))).toThrow(/48-byte fixed header/);
  });

  it('adds blockette 1001 microseconds, including negative ones', () => {
    const base = parseMiniSeedRecord(buildRecord({ microseconds: null }));
    const plus = parseMiniSeedRecord(buildRecord({ microseconds: 93 }));
    const minus = parseMiniSeedRecord(buildRecord({ microseconds: -40 }));
    if (base.kind !== 'data' || plus.kind !== 'data' || minus.kind !== 'data') {
      throw new Error('expected data');
    }
    // Precision 3 (half a microsecond), not tighter: an epoch-ms double near
    // 1.8e12 carries only ~0.24 µs of resolution, so 0.093 ms comes back as
    // 0.0930176. Sub-microsecond timing is not representable in this field.
    expect(plus.startTimeMs - base.startTimeMs).toBeCloseTo(0.093, 3);
    expect(minus.startTimeMs - base.startTimeMs).toBeCloseTo(-0.04, 3);
  });

  it('rolls a leap second into the next minute rather than rejecting it', () => {
    const record = parseMiniSeedRecord(
      buildRecord({ hour: 23, minute: 59, second: 60, tenThousandths: 0, dayOfYear: 365 }),
    );
    if (record.kind !== 'data') throw new Error('expected data');
    expect(new Date(record.startTimeMs).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('places a period-encoded rate through the header', () => {
    // factor -10, multiplier 1: one sample every ten seconds.
    const record = parseMiniSeedRecord(buildRecord({ rateFactor: -10, rateMultiplier: 1 }));
    if (record.kind !== 'data') throw new Error('expected data');
    expect(record.sampleRateHz).toBeCloseTo(0.1, 12);
  });
});

describe('sampleRateFrom', () => {
  it('covers all four sign branches', () => {
    expect(sampleRateFrom(100, 1)).toBe(100);
    expect(sampleRateFrom(20, -2)).toBe(10);
    expect(sampleRateFrom(-10, 1)).toBeCloseTo(0.1, 12);
    expect(sampleRateFrom(-10, -10)).toBeCloseTo(0.01, 12);
  });

  it('returns 0 when either term is zero, which the parser treats as fatal', () => {
    expect(sampleRateFrom(0, 1)).toBe(0);
    expect(sampleRateFrom(40, 0)).toBe(0);
  });
});
