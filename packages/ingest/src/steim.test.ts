import { describe, expect, it } from 'vitest';
import { MiniSeedIntegrityError, SteimDecodeError, decodeSteim1, decodeSteim2, signExtend } from './steim';

/**
 * Hand-assembled Steim frames.
 *
 * Real records only exercise whichever packings the live signal happened to
 * need, and the live ring carries no Steim-1 at all (a 75-second sample across
 * CI/UW/NN/PB/IU came back 100% Steim-2). So every packing is built here from
 * first principles and checked end to end, including the Xn integrity check.
 * Real records are covered in `miniseed.test.ts`.
 */

interface DataWord {
  nibble: number;
  word: number;
}

interface Packing {
  name: string;
  nibble: number;
  dnib: number | null;
  count: number;
  bits: number;
  startBit: number;
}

/** Packs fields most significant first, mirroring the decoder's layout. */
function packWord(fields: number[], packing: Packing): number {
  const mask = packing.bits === 32 ? 0xffffffff : (1 << packing.bits) - 1;
  let word = 0;
  fields.forEach((value, k) => {
    const shift = packing.startBit - (k + 1) * packing.bits;
    word = (word | ((value & mask) << shift)) >>> 0;
  });
  if (packing.dnib !== null) {
    word = (word | (packing.dnib << 30)) >>> 0;
  }
  return word;
}

/**
 * Lays data words into 64-byte frames: frame 0 holds X0 and Xn in words 1-2 and
 * data from word 3; later frames carry data from word 1.
 */
function buildFrames(x0: number, xn: number, words: DataWord[], littleEndian = false): DataView {
  const slots: { frame: number; w: number }[] = [];
  let frame = 0;
  let w = 3;
  for (let i = 0; i < words.length; i += 1) {
    if (w > 15) {
      frame += 1;
      w = 1;
    }
    slots.push({ frame, w });
    w += 1;
  }
  const frameCount = frame + 1;
  const view = new DataView(new ArrayBuffer(frameCount * 64));
  const nibbleWords = new Array<number>(frameCount).fill(0);

  words.forEach((dataWord, i) => {
    const slot = slots[i];
    if (slot === undefined) throw new Error('unreachable');
    view.setUint32(slot.frame * 64 + slot.w * 4, dataWord.word >>> 0, littleEndian);
    nibbleWords[slot.frame] = ((nibbleWords[slot.frame] ?? 0) | (dataWord.nibble << (30 - 2 * slot.w))) >>> 0;
  });
  nibbleWords.forEach((nibbleWord, f) => {
    view.setUint32(f * 64, nibbleWord, littleEndian);
  });
  view.setInt32(4, x0, littleEndian);
  view.setInt32(8, xn, littleEndian);
  return view;
}

/** The reference integration: X0, then each difference after the first. */
function integrate(x0: number, diffs: number[]): Int32Array {
  const samples = new Int32Array(diffs.length);
  samples[0] = x0;
  for (let i = 1; i < diffs.length; i += 1) {
    samples[i] = (samples[i - 1] ?? 0) + (diffs[i] ?? 0);
  }
  return samples;
}

/**
 * Boundary values for a field width, alternating sign so the running sum stays
 * small. Leads with a large value that exists only to be discarded — it sits in
 * the `diffs[0]` position, the difference against the *previous* record.
 */
function boundaryDiffs(bits: number, length: number): number[] {
  const max = bits === 32 ? 2 ** 31 - 1 : 2 ** (bits - 1) - 1;
  const min = -(2 ** (bits - 1));
  const cycle = [max, min, -1, 0, 1];
  return Array.from({ length }, (_, i) => cycle[i % cycle.length] ?? 0);
}

function wordsFor(diffs: number[], packing: Packing): DataWord[] {
  const words: DataWord[] = [];
  for (let i = 0; i < diffs.length; i += packing.count) {
    words.push({ nibble: packing.nibble, word: packWord(diffs.slice(i, i + packing.count), packing) });
  }
  return words;
}

const X0 = 1000;
const STREAM = 'XX_TEST__HHZ';

const STEIM2_PACKINGS: Packing[] = [
  { name: '4 x 8-bit', nibble: 1, dnib: null, count: 4, bits: 8, startBit: 32 },
  { name: '1 x 30-bit', nibble: 2, dnib: 1, count: 1, bits: 30, startBit: 30 },
  { name: '2 x 15-bit', nibble: 2, dnib: 2, count: 2, bits: 15, startBit: 30 },
  { name: '3 x 10-bit', nibble: 2, dnib: 3, count: 3, bits: 10, startBit: 30 },
  { name: '5 x 6-bit', nibble: 3, dnib: 0, count: 5, bits: 6, startBit: 30 },
  { name: '6 x 5-bit', nibble: 3, dnib: 1, count: 6, bits: 5, startBit: 30 },
  // 7 x 4 = 28 bits: the fields stop at bit 27, not 29.
  { name: '7 x 4-bit', nibble: 3, dnib: 2, count: 7, bits: 4, startBit: 28 },
];

const STEIM1_PACKINGS: Packing[] = [
  { name: '4 x 8-bit', nibble: 1, dnib: null, count: 4, bits: 8, startBit: 32 },
  { name: '2 x 16-bit', nibble: 2, dnib: null, count: 2, bits: 16, startBit: 32 },
  { name: '1 x 32-bit', nibble: 3, dnib: null, count: 1, bits: 32, startBit: 32 },
];

describe('signExtend', () => {
  it.each([4, 5, 6, 8, 10, 15, 16, 30, 32])('handles the %i-bit boundaries', (bits) => {
    const max = 2 ** (bits - 1) - 1;
    const minRaw = 2 ** (bits - 1); // the sign bit alone
    const allOnes = 2 ** bits - 1;
    expect(signExtend(max, bits)).toBe(max);
    expect(signExtend(minRaw, bits)).toBe(-(2 ** (bits - 1)));
    expect(signExtend(allOnes, bits)).toBe(-1);
    expect(signExtend(0, bits)).toBe(0);
  });
});

describe('decodeSteim2', () => {
  it.each(STEIM2_PACKINGS)('decodes $name differences and lands on Xn', (packing) => {
    const diffs = boundaryDiffs(packing.bits, packing.count * 3);
    const expected = integrate(X0, diffs);
    const view = buildFrames(X0, expected[expected.length - 1] ?? 0, wordsFor(diffs, packing));

    const samples = decodeSteim2({
      view,
      dataOffset: 0,
      recordLength: view.byteLength,
      numSamples: diffs.length,
      littleEndian: false,
      stream: STREAM,
    });

    expect(Array.from(samples)).toEqual(Array.from(expected));
  });

  it('discards the leading difference, which belongs to the previous record', () => {
    // A leading difference of 100 that the decoder wrongly applied would shift
    // every sample by 100 and fail the Xn check.
    const diffs = [100, 3, -2, 7];
    const expected = integrate(X0, diffs);
    expect(Array.from(expected)).toEqual([1000, 1003, 1001, 1008]);

    const packing = STEIM2_PACKINGS[0];
    if (packing === undefined) throw new Error('unreachable');
    const view = buildFrames(X0, 1008, wordsFor(diffs, packing));
    const samples = decodeSteim2({
      view,
      dataOffset: 0,
      recordLength: view.byteLength,
      numSamples: 4,
      littleEndian: false,
      stream: STREAM,
    });
    expect(Array.from(samples)).toEqual([1000, 1003, 1001, 1008]);
  });

  it('stops at the header sample count and ignores padding in the final word', () => {
    // Four 8-bit fields packed, three samples declared: the fourth is padding
    // and must not be integrated, or Xn would not match.
    const packing = STEIM2_PACKINGS[0];
    if (packing === undefined) throw new Error('unreachable');
    const view = buildFrames(X0, 1005, [{ nibble: 1, word: packWord([9, 2, 3, -99], packing) }]);
    const samples = decodeSteim2({
      view,
      dataOffset: 0,
      recordLength: view.byteLength,
      numSamples: 3,
      littleEndian: false,
      stream: STREAM,
    });
    expect(Array.from(samples)).toEqual([1000, 1002, 1005]);
  });

  it('crosses frame boundaries: frame 0 data starts at word 3, later frames at word 1', () => {
    const packing = STEIM2_PACKINGS[0];
    if (packing === undefined) throw new Error('unreachable');
    // 20 words spans frame 0's 13 data slots and 7 of frame 1's.
    const diffs = Array.from({ length: 80 }, (_, i) => ((i * 37) % 21) - 10);
    const expected = integrate(X0, diffs);
    const view = buildFrames(X0, expected[79] ?? 0, wordsFor(diffs, packing));
    expect(view.byteLength).toBe(128);

    const samples = decodeSteim2({
      view,
      dataOffset: 0,
      recordLength: view.byteLength,
      numSamples: 80,
      littleEndian: false,
      stream: STREAM,
    });
    expect(Array.from(samples)).toEqual(Array.from(expected));
  });

  it('skips non-data words (nibble 00) mid-frame', () => {
    const packing = STEIM2_PACKINGS[0];
    if (packing === undefined) throw new Error('unreachable');
    const view = buildFrames(X0, 1010, [
      { nibble: 1, word: packWord([0, 1, 2, 3], packing) },
      { nibble: 0, word: 0xdeadbeef },
      { nibble: 1, word: packWord([4, 0, 0, 0], packing) },
    ]);
    const samples = decodeSteim2({
      view,
      dataOffset: 0,
      recordLength: view.byteLength,
      numSamples: 5,
      littleEndian: false,
      stream: STREAM,
    });
    // Differences 0 (discarded), 1, 2, 3 from the first word, then 4 from the
    // third — the 0xDEADBEEF between them contributes nothing.
    expect(Array.from(samples)).toEqual([1000, 1001, 1003, 1006, 1010]);
  });

  it('reads little-endian word order', () => {
    const packing = STEIM2_PACKINGS[3];
    if (packing === undefined) throw new Error('unreachable');
    const diffs = boundaryDiffs(packing.bits, 9);
    const expected = integrate(X0, diffs);
    const view = buildFrames(X0, expected[8] ?? 0, wordsFor(diffs, packing), true);
    const samples = decodeSteim2({
      view,
      dataOffset: 0,
      recordLength: view.byteLength,
      numSamples: 9,
      littleEndian: true,
      stream: STREAM,
    });
    expect(Array.from(samples)).toEqual(Array.from(expected));
  });

  it('throws MiniSeedIntegrityError naming stream, expected and reached when Xn disagrees', () => {
    const packing = STEIM2_PACKINGS[0];
    if (packing === undefined) throw new Error('unreachable');
    const diffs = [0, 1, 1, 1];
    // The true last sample is 1003; declare 1004.
    const view = buildFrames(X0, 1004, wordsFor(diffs, packing));
    let caught: unknown;
    try {
      decodeSteim2({
        view,
        dataOffset: 0,
        recordLength: view.byteLength,
        numSamples: 4,
        littleEndian: false,
        stream: STREAM,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MiniSeedIntegrityError);
    const integrity = caught as MiniSeedIntegrityError;
    expect(integrity.stream).toBe(STREAM);
    expect(integrity.expected).toBe(1004);
    expect(integrity.reached).toBe(1003);
  });

  it('throws on reserved dnib combinations rather than guessing', () => {
    const reservedUnderTwo = buildFrames(X0, X0, [{ nibble: 2, word: 0x00000001 }]); // dnib 0
    const reservedUnderThree = buildFrames(X0, X0, [{ nibble: 3, word: 0xc0000001 }]); // dnib 3
    for (const view of [reservedUnderTwo, reservedUnderThree]) {
      expect(() =>
        decodeSteim2({
          view,
          dataOffset: 0,
          recordLength: view.byteLength,
          numSamples: 1,
          littleEndian: false,
          stream: STREAM,
        }),
      ).toThrow(SteimDecodeError);
    }
  });

  it('throws when the header declares more samples than were packed', () => {
    const packing = STEIM2_PACKINGS[0];
    if (packing === undefined) throw new Error('unreachable');
    const view = buildFrames(X0, 1003, wordsFor([0, 1, 1, 1], packing));
    expect(() =>
      decodeSteim2({
        view,
        dataOffset: 0,
        recordLength: view.byteLength,
        numSamples: 10,
        littleEndian: false,
        stream: STREAM,
      }),
    ).toThrow(/only 4 differences/);
  });

  it('returns an empty array for a zero-sample record', () => {
    const view = buildFrames(0, 0, []);
    const samples = decodeSteim2({
      view,
      dataOffset: 0,
      recordLength: view.byteLength,
      numSamples: 0,
      littleEndian: false,
      stream: STREAM,
    });
    expect(samples.length).toBe(0);
  });
});

describe('decodeSteim1', () => {
  it.each(STEIM1_PACKINGS)('decodes $name differences and lands on Xn', (packing) => {
    const diffs = boundaryDiffs(packing.bits, packing.count * 3);
    const expected = integrate(X0, diffs);
    const view = buildFrames(X0, expected[expected.length - 1] ?? 0, wordsFor(diffs, packing));

    const samples = decodeSteim1({
      view,
      dataOffset: 0,
      recordLength: view.byteLength,
      numSamples: diffs.length,
      littleEndian: false,
      stream: STREAM,
    });

    expect(Array.from(samples)).toEqual(Array.from(expected));
  });

  it('reads nibble 10 as two 16-bit fields, not as a Steim-2 dnib', () => {
    // The same word under Steim-2 would read its top bits as a dnib. Under
    // Steim-1 there is no dnib: 0xFFFF0002 is two fields, -1 and 2.
    const view = buildFrames(X0, 1002, [{ nibble: 2, word: 0xffff0002 }]);
    const samples = decodeSteim1({
      view,
      dataOffset: 0,
      recordLength: view.byteLength,
      numSamples: 2,
      littleEndian: false,
      stream: STREAM,
    });
    expect(Array.from(samples)).toEqual([1000, 1002]);
  });
});
