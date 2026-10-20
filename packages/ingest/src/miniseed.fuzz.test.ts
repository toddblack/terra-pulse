import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MiniSeedParseError,
  miniSeed3Crc,
  parseMiniSeedRecord,
  splitMiniSeedRecords,
  type MiniSeedRecord,
} from './miniseed';
import { MS2_FIXTURES } from './miniseed2.fixtures';
import { MS3_FIXTURES } from './miniseed3.fixtures';
import { MiniSeedIntegrityError, SteimDecodeError } from './steim';

/**
 * Property-based fuzzing of the miniSEED parser — the code that reads bytes
 * straight off eight public SeedLink servers and two archives, in the main
 * process.
 *
 * Four questions, each a property:
 *
 * 1. **Does anything but a named error ever come out?** Callers catch per
 *    record, so a stray `RangeError` would not crash — but an error type nobody
 *    named is a code path nobody reasoned about.
 * 2. **Can one record cost a lot?** A damaged count field that makes the main
 *    process allocate gigabytes is an outage, not a dropped record.
 * 3. **Does decoding reproduce what was encoded?** An independent Steim encoder,
 *    written here, is the oracle: every waveform it can pack must come back
 *    sample for sample, at the extremes of every packing.
 * 4. **Does splitting an archive response find every record boundary?**
 *
 * `FUZZ_RUNS` raises the run count for a deep pass (`FUZZ_RUNS=200000`); the
 * default keeps `pnpm test` quick.
 */
const RUNS = Number(process.env['FUZZ_RUNS'] ?? 2000);

/** One record is at most a few kilobytes; nothing about it should take long. */
const MAX_PARSE_MS = 100;

const decode = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'));
const MS2 = Object.values(MS2_FIXTURES).map(decode);
const MS3 = Object.values(MS3_FIXTURES).map(decode);

function isNamedError(error: unknown): boolean {
  return (
    error instanceof MiniSeedParseError ||
    error instanceof MiniSeedIntegrityError ||
    error instanceof SteimDecodeError
  );
}

/** What any record the parser accepts must satisfy, whatever bytes produced it. */
function expectSane(record: MiniSeedRecord, bytes: Uint8Array): void {
  if (record.kind === 'log') return;
  expect(Number.isFinite(record.startTimeMs)).toBe(true);
  expect(Number.isFinite(record.sampleRateHz) && record.sampleRateHz > 0).toBe(true);
  // The densest packing is seven samples per four bytes; more than two per
  // byte means samples were invented from bytes that are not there.
  expect(record.samples.length).toBeLessThanOrEqual(bytes.length * 2);
}

/**
 * Parses, asserting the outcome is a sane record or a named error, quickly.
 * Returns the record, or null for a named rejection.
 */
function parseChecked(bytes: Uint8Array): MiniSeedRecord | null {
  const started = performance.now();
  let record: MiniSeedRecord | null = null;
  try {
    record = parseMiniSeedRecord(bytes);
  } catch (error) {
    if (!isNamedError(error)) throw error;
  }
  const elapsed = performance.now() - started;
  if (elapsed > MAX_PARSE_MS) throw new Error(`parse took ${elapsed.toFixed(0)} ms`);
  if (record !== null) expectSane(record, bytes);
  return record;
}

/** Re-signs a miniSEED 3 record, so mutations reach past the checksum to the code behind it. */
function resign(bytes: Uint8Array): void {
  if (bytes.length < 40) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = 40 + view.getUint8(33) + view.getUint16(34, true) + view.getUint32(36, true);
  if (length <= bytes.length) view.setUint32(28, miniSeed3Crc(bytes.subarray(0, length)), true);
}

const mutation = fc.record({
  // Half aimed at the header and blockettes, where the decisions are made.
  at: fc.oneof(fc.integer({ min: 0, max: 79 }), fc.nat()),
  value: fc.integer({ min: 0, max: 255 }),
});

function mutated(
  source: Uint8Array,
  edits: { at: number; value: number }[],
  cut: number | null,
): Uint8Array {
  const bytes = source.slice(0, cut === null ? source.length : cut % (source.length + 1));
  for (const { at, value } of edits) if (bytes.length > 0) bytes[at % bytes.length] = value;
  return bytes;
}

describe('parseMiniSeedRecord under fuzzing', () => {
  it('random bytes produce a record or a named error', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 1100 }), (bytes) => {
        parseChecked(bytes);
      }),
      { numRuns: RUNS },
    );
  });

  it('mutated real miniSEED 2 records produce a sane record or a named error', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MS2),
        fc.array(mutation, { minLength: 1, maxLength: 8 }),
        fc.option(fc.nat(), { freq: 4 }),
        (source, edits, cut) => {
          parseChecked(mutated(source, edits, cut));
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('mutated, re-signed real miniSEED 3 records produce a sane record or a named error', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MS3),
        fc.array(mutation, { minLength: 1, maxLength: 8 }),
        fc.option(fc.nat(), { freq: 4 }),
        (source, edits, cut) => {
          const bytes = mutated(source, edits, cut);
          resign(bytes);
          parseChecked(bytes);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('a miniSEED 3 sample count of any size is rejected quickly, not allocated', () => {
    // The count is a full 32-bit field. Validly signed, so only the count is wrong.
    fc.assert(
      fc.property(
        fc.constantFrom(...MS3),
        fc.integer({ min: 0, max: 0xffffffff }),
        (source, count) => {
          const bytes = source.slice();
          new DataView(bytes.buffer).setUint32(24, count, true);
          resign(bytes);
          parseChecked(bytes);
        },
      ),
      { numRuns: Math.min(RUNS, 300) },
    );
  });
});

// ---------------------------------------------------------------------------
// The oracle: an independent Steim encoder
// ---------------------------------------------------------------------------

/** One packing: how many differences of what width share a word, and its codes. */
interface Packing {
  count: number;
  bits: number;
  nibble: number;
  /** Steim-2's sub-code in the word's top two bits; null where there is none. */
  dnib: number | null;
  /** Bit just above the highest field (fields run down from here). */
  top: number;
}

// Written from the SEED manual's tables, not from steim.ts, so a shared
// misreading would have to be made twice to pass.
const STEIM1: Packing[] = [
  { count: 4, bits: 8, nibble: 1, dnib: null, top: 32 },
  { count: 2, bits: 16, nibble: 2, dnib: null, top: 32 },
  { count: 1, bits: 32, nibble: 3, dnib: null, top: 32 },
];
const STEIM2: Packing[] = [
  { count: 7, bits: 4, nibble: 3, dnib: 2, top: 28 },
  { count: 6, bits: 5, nibble: 3, dnib: 1, top: 30 },
  { count: 5, bits: 6, nibble: 3, dnib: 0, top: 30 },
  { count: 4, bits: 8, nibble: 1, dnib: null, top: 32 },
  { count: 3, bits: 10, nibble: 2, dnib: 3, top: 30 },
  { count: 2, bits: 15, nibble: 2, dnib: 2, top: 30 },
  { count: 1, bits: 30, nibble: 2, dnib: 1, top: 30 },
];

const fits = (value: number, bits: number) =>
  bits === 32 || (value >= -(2 ** (bits - 1)) && value < 2 ** (bits - 1));

/**
 * Packs `diffs` into Steim frames starting at `dataOffset`. Returns how many
 * differences went in — as many as fit.
 *
 * **Byte order is the record's in miniSEED 2 and always big-endian in 3.** The
 * first version of this oracle wrote big-endian everywhere and "found" the
 * decoder wrong on little-endian 2.x records; libmseed, the reference, reads
 * 2.x Steim in blockette 1000's order exactly as the decoder does.
 */
function packSteim(
  view: DataView,
  dataOffset: number,
  frames: number,
  table: Packing[],
  x0: number,
  diffs: number[],
  samples: Int32Array,
  littleEndian: boolean,
): number {
  let used = 0;
  for (let frame = 0; frame < frames && used < diffs.length; frame += 1) {
    const start = dataOffset + frame * 64;
    let nibbles = 0;
    for (let w = frame === 0 ? 3 : 1; w < 16 && used < diffs.length; w += 1) {
      const remaining = diffs.length - used;
      // Densest packing whose fields all fit; a short final group is padded with zeros.
      const packing = table.find((p) =>
        diffs.slice(used, used + p.count).every((d) => fits(d, p.bits)),
      );
      if (packing === undefined) throw new Error('difference too wide for this encoding');
      let word = packing.dnib === null ? 0 : packing.dnib << 30;
      const mask = packing.bits === 32 ? 0xffffffff : 2 ** packing.bits - 1;
      for (let k = 0; k < packing.count; k += 1) {
        const value = k < remaining ? (diffs[used + k] ?? 0) : 0;
        word |= (value & mask) << (packing.top - (k + 1) * packing.bits);
      }
      view.setUint32(start + w * 4, word >>> 0, littleEndian);
      nibbles |= packing.nibble << (30 - 2 * w);
      used += Math.min(packing.count, remaining);
    }
    view.setUint32(start, nibbles >>> 0, littleEndian);
    if (frame === 0) {
      view.setInt32(start + 4, x0, littleEndian);
      // Xn is written below, once the count is known.
    }
  }
  // Sample 0 is X0; the first packed difference is against the previous record
  // and is ignored, so `used` differences carry `used` samples.
  view.setInt32(dataOffset + 8, samples[used - 1] ?? x0, littleEndian);
  return used;
}

interface Waveform {
  x0: number;
  /** Differences between successive samples, the first against the previous record. */
  diffs: number[];
}

/** Samples from a waveform, wrapping as 32-bit integers exactly as a record's do. */
function integrate({ x0, diffs }: Waveform): Int32Array {
  const samples = new Int32Array(diffs.length);
  samples[0] = x0;
  for (let i = 1; i < diffs.length; i += 1)
    samples[i] = ((samples[i - 1] ?? 0) + (diffs[i] ?? 0)) | 0;
  return samples;
}

/** Differences biased toward each packing's edges, where off-by-one bugs live. */
function difference(maxBits: number): fc.Arbitrary<number> {
  const edges = [4, 5, 6, 8, 10, 15, 16, 30, 32].filter((b) => b <= maxBits);
  return fc.oneof(
    fc.integer({ min: -8, max: 7 }),
    fc
      .constantFrom(...edges)
      .chain((b) =>
        fc.constantFrom(-(2 ** (b - 1)), 2 ** (b - 1) - 1, -(2 ** (b - 1)) + 1, 2 ** (b - 1) - 2),
      ),
    fc.integer({ min: -(2 ** (maxBits - 1)), max: 2 ** (maxBits - 1) - 1 }),
  );
}

function waveform(maxBits: number): fc.Arbitrary<Waveform> {
  return fc.record({
    x0: fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }),
    diffs: fc.array(difference(maxBits), { minLength: 1, maxLength: 1200 }),
  });
}

/** A miniSEED 2 record: blockette 1000 at 48, data at 64, either byte order for the header. */
function buildMs2(
  wave: Waveform,
  encoding: 10 | 11,
  lengthLog2: number,
  littleEndian: boolean,
): { bytes: Uint8Array; samples: Int32Array } {
  const length = 2 ** lengthLog2;
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes.set(Buffer.from('000001D TEST   HHZXX'), 0);
  view.setUint16(20, 2026, littleEndian);
  view.setUint16(22, 293, littleEndian);
  view.setInt16(32, 100, littleEndian);
  view.setInt16(34, 1, littleEndian);
  view.setUint8(39, 1);
  view.setUint16(44, 64, littleEndian);
  view.setUint16(46, 48, littleEndian);
  view.setUint16(48, 1000, littleEndian);
  view.setUint8(52, encoding);
  view.setUint8(53, littleEndian ? 0 : 1);
  view.setUint8(54, lengthLog2);

  const all = integrate(wave);
  const used = packSteim(
    view,
    64,
    (length - 64) / 64,
    encoding === 10 ? STEIM1 : STEIM2,
    wave.x0,
    wave.diffs,
    all,
    littleEndian,
  );
  view.setUint16(30, used, littleEndian);
  return { bytes, samples: all.slice(0, used) };
}

/** A miniSEED 3 record: 40-byte header, source id, Steim payload, valid CRC. */
function buildMs3(
  wave: Waveform,
  encoding: 10 | 11,
  frames: number,
): { bytes: Uint8Array; samples: Int32Array } {
  const id = Buffer.from('FDSN:XX_TEST__H_H_Z');
  const dataOffset = 40 + id.length;
  const bytes = new Uint8Array(dataOffset + frames * 64);
  const view = new DataView(bytes.buffer);
  bytes.set(Buffer.from('MS'), 0);
  bytes[2] = 3;
  view.setUint16(8, 2026, true);
  view.setUint16(10, 293, true);
  bytes[15] = encoding;
  view.setFloat64(16, 100, true);
  bytes[33] = id.length;
  view.setUint32(36, frames * 64, true);
  bytes.set(id, 40);

  const all = integrate(wave);
  const used = packSteim(
    view,
    dataOffset,
    frames,
    encoding === 10 ? STEIM1 : STEIM2,
    wave.x0,
    wave.diffs,
    all,
    false,
  );
  view.setUint32(24, used, true);
  view.setUint32(28, miniSeed3Crc(bytes), true);
  return { bytes, samples: all.slice(0, used) };
}

function expectDecodes(bytes: Uint8Array, samples: Int32Array): void {
  const record = parseMiniSeedRecord(bytes);
  if (record.kind !== 'data') throw new Error('expected a data record');
  expect(Array.from(record.samples)).toEqual(Array.from(samples));
}

describe('Steim decoding against an independent encoder', () => {
  it('the encoder reproduces the real records it is checked against', () => {
    // The oracle has to be right before it can judge anything: re-encode each
    // real record's own decoded samples and decode again.
    for (const source of [...MS2, ...MS3]) {
      const record = parseMiniSeedRecord(source);
      if (record.kind !== 'data') throw new Error('expected data');
      const diffs = [
        0,
        ...Array.from(record.samples)
          .slice(1)
          .map((s, i) => (s - (record.samples[i] ?? 0)) | 0),
      ];
      const encoding = record.encoding === 10 ? 10 : 11;
      const { bytes, samples } = buildMs2(
        { x0: record.samples[0] ?? 0, diffs },
        encoding,
        12,
        false,
      );
      expect(samples.length).toBe(record.samples.length);
      expectDecodes(bytes, record.samples);
    }
  });

  it('Steim-2 in miniSEED 2 decodes exactly what was encoded', () => {
    fc.assert(
      fc.property(
        waveform(30),
        fc.integer({ min: 7, max: 12 }),
        fc.boolean(),
        (wave, lengthLog2, le) => {
          const { bytes, samples } = buildMs2(wave, 11, lengthLog2, le);
          expectDecodes(bytes, samples);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('Steim-1 in miniSEED 2 decodes exactly what was encoded', () => {
    fc.assert(
      fc.property(
        waveform(32),
        fc.integer({ min: 7, max: 12 }),
        fc.boolean(),
        (wave, lengthLog2, le) => {
          const { bytes, samples } = buildMs2(wave, 10, lengthLog2, le);
          expectDecodes(bytes, samples);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('Steim-1 and Steim-2 in miniSEED 3 decode exactly what was encoded', () => {
    fc.assert(
      fc.property(
        waveform(30),
        fc.constantFrom<10 | 11>(10, 11),
        fc.integer({ min: 1, max: 63 }),
        (wave, encoding, frames) => {
          const { bytes, samples } = buildMs3(wave, encoding, frames);
          expectDecodes(bytes, samples);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('splitMiniSeedRecords under fuzzing', () => {
  it('finds every boundary in a run of records of mixed lengths', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(waveform(30), fc.integer({ min: 7, max: 12 }), fc.boolean()), {
          minLength: 1,
          maxLength: 6,
        }),
        (specs) => {
          const records = specs.map(([wave, log2, le]) => buildMs2(wave, 11, log2, le).bytes);
          const joined = new Uint8Array(records.reduce((n, r) => n + r.length, 0));
          let at = 0;
          for (const r of records) {
            joined.set(r, at);
            at += r.length;
          }
          const split = splitMiniSeedRecords(joined);
          expect(split.map((r) => r.length)).toEqual(records.map((r) => r.length));
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('random and mutated input produce whole slices or a named error', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.uint8Array({ maxLength: 3000 }),
          fc
            .tuple(
              fc.constantFrom(...MS2),
              fc.array(mutation, { maxLength: 8 }),
              fc.option(fc.nat(), { freq: 4 }),
            )
            .map(([source, edits, cut]) => mutated(source, edits, cut)),
        ),
        (bytes) => {
          let split: Uint8Array[];
          try {
            split = splitMiniSeedRecords(bytes);
          } catch (error) {
            if (error instanceof MiniSeedParseError) return;
            throw error;
          }
          // Slices tile a prefix of the input, in order, without overlap.
          const total = split.reduce((n, r) => n + r.length, 0);
          expect(total).toBeLessThanOrEqual(bytes.length);
          for (const r of split) expect(r.length).toBeGreaterThanOrEqual(48);
        },
      ),
      { numRuns: RUNS },
    );
  });
});
