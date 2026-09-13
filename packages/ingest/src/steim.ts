/**
 * Steim-1 and Steim-2 decompression.
 *
 * Steim is a difference-and-pack scheme: samples are stored as differences from
 * their predecessor, and as many differences as will fit are packed into each
 * 32-bit word. That is why a 512-byte record holds a variable number of samples
 * — measured on the live ring, between 225 and 720 — and why a *quiet* station
 * has *higher* latency than a noisy one: small differences pack more densely, so
 * a record takes longer to fill, and records ship only when full.
 *
 * **The decode is self-checking, and that is the point of this module.** Every
 * record carries both its first sample (X0) and its last (Xn). A correct decode
 * therefore has to land exactly on Xn. Every plausible way to get this wrong —
 * a wrong nibble table, the wrong dnib split, sign extension off by a bit, one
 * frame too many, forgetting to discard the leading difference — produces a
 * smooth, entirely believable seismogram that is simply not what the instrument
 * recorded. Checking against Xn converts that whole class of bug into a loud
 * named failure. Same posture as `parseAuroraGrid` pinning its cell count.
 */

/**
 * Thrown when a record decodes to something other than what it declares.
 *
 * Names the stream, the expected last sample and the one reached, because the
 * difference between them is diagnostic: a small offset is usually a dropped or
 * doubled difference, while a wildly wrong value is usually a bad unpacking.
 */
export class MiniSeedIntegrityError extends Error {
  constructor(
    readonly stream: string,
    readonly expected: number,
    readonly reached: number,
  ) {
    super(
      `miniSEED integrity check failed for ${stream}: record declares last sample ${String(
        expected,
      )} but decoded to ${String(reached)}`,
    );
    this.name = 'MiniSeedIntegrityError';
  }
}

/** Thrown for a record this module cannot decode at all. */
export class SteimDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SteimDecodeError';
  }
}

/**
 * Sign-extends the low `bits` of `value` to a full 32-bit signed integer.
 *
 * The shift pair is the whole trick: shifting left pushes the value's sign bit
 * into bit 31, and JavaScript's `>>` is arithmetic, so shifting back drags it
 * down through the high bits. Using `>>>` here instead would silently turn every
 * negative difference into a large positive one — which decodes into a waveform
 * with a plausible shape and an impossible offset.
 */
export function signExtend(value: number, bits: number): number {
  return (value << (32 - bits)) >> (32 - bits);
}

const FRAME_BYTES = 64;
const WORDS_PER_FRAME = 16;

export interface SteimDecodeOptions {
  /** A view over the whole miniSEED record. */
  view: DataView;
  /** Byte offset of the first Steim frame — the fixed header's data offset. */
  dataOffset: number;
  /** Total record length in bytes, from blockette 1000's `recordLength`. */
  recordLength: number;
  /** Sample count from the fixed header. Decoding stops here. */
  numSamples: number;
  /** Little-endian word order. False for every record observed on the ring. */
  littleEndian: boolean;
  /** `NET_STA_LOC_CHA`, used only in error messages. */
  stream: string;
}

/**
 * Pulls `count` fields of `bits` width out of one word, most significant first.
 *
 * `startBit` is the bit position just above the highest field, which is not
 * always 30: seven 4-bit differences occupy only 28 bits, leaving bits 29 and 28
 * unused. Passing 30 there would read every value shifted by two places and
 * still return plausible small numbers.
 */
function extractFields(
  word: number,
  count: number,
  bits: number,
  startBit: number,
  out: Int32Array,
  at: number,
  limit: number,
): number {
  const mask = bits === 32 ? 0xffffffff : (1 << bits) - 1;
  let written = 0;
  for (let k = 0; k < count && at + written < limit; k += 1) {
    const shift = startBit - (k + 1) * bits;
    out[at + written] = signExtend((word >>> shift) & mask, bits);
    written += 1;
  }
  // Fields past the caller's limit are padding in the final word group. They are
  // skipped rather than counted, so the walk stops on the header's sample count.
  return written;
}

/**
 * Unpacks one 32-bit word into differences, appending at `at` and never past
 * `limit`. Returns how many were appended.
 *
 * Steim-1 and Steim-2 differ only here, which is why the frame walk is shared:
 * the framing, the integration constants and the integrity check are identical.
 */
type Unpacker = (
  word: number,
  nibble: number,
  out: Int32Array,
  at: number,
  limit: number,
  stream: string,
) => number;

/**
 * Steim-1: the nibble alone selects the packing, with no sub-code.
 *
 * - `01` four 8-bit differences
 * - `10` two 16-bit differences
 * - `11` one 32-bit difference
 *
 * **No record on the live ring uses Steim-1** — a 75-second sample across
 * CI/UW/NN/PB/IU came back 100% Steim-2. It is implemented because the encoding
 * is legal, appears in archived data, and rejecting it would be a silent gap;
 * its tests are built from hand-assembled frames for that reason.
 */
const unpackSteim1: Unpacker = (word, nibble, out, at, limit, stream) => {
  switch (nibble) {
    case 1:
      return extractFields(word, 4, 8, 32, out, at, limit);
    case 2:
      return extractFields(word, 2, 16, 32, out, at, limit);
    case 3:
      return extractFields(word, 1, 32, 32, out, at, limit);
    default:
      throw new SteimDecodeError(`${stream}: unreachable Steim-1 nibble ${String(nibble)}`);
  }
};

/**
 * Steim-2: nibble `01` is four 8-bit differences as in Steim-1, but nibbles
 * `10` and `11` carry a two-bit sub-code — the "dnib" — in the word's own top
 * bits, selecting between packings of different width.
 *
 * The reserved combinations throw rather than being skipped. A reserved dnib
 * means the record is not what it claims to be, and guessing at it produces
 * exactly the plausible-but-wrong waveform this module exists to prevent.
 */
const unpackSteim2: Unpacker = (word, nibble, out, at, limit, stream) => {
  if (nibble === 1) {
    return extractFields(word, 4, 8, 32, out, at, limit);
  }

  const dnib = (word >>> 30) & 0b11;
  if (nibble === 2) {
    switch (dnib) {
      case 1:
        return extractFields(word, 1, 30, 30, out, at, limit);
      case 2:
        return extractFields(word, 2, 15, 30, out, at, limit);
      case 3:
        return extractFields(word, 3, 10, 30, out, at, limit);
      default:
        throw new SteimDecodeError(`${stream}: reserved Steim-2 dnib 0 under nibble 2`);
    }
  }

  switch (dnib) {
    case 0:
      return extractFields(word, 5, 6, 30, out, at, limit);
    case 1:
      return extractFields(word, 6, 5, 30, out, at, limit);
    case 2:
      // 7 x 4 = 28 bits, so the fields stop at bit 27 and bits 29-28 are unused.
      return extractFields(word, 7, 4, 28, out, at, limit);
    default:
      throw new SteimDecodeError(`${stream}: reserved Steim-2 dnib 3 under nibble 3`);
  }
};

/**
 * Walks the frames of one record, unpacking differences and integrating them.
 *
 * Frame 0 is special: its word 1 is X0 (the first sample) and word 2 is Xn (the
 * last), so data begins at word 3. Every later frame carries data from word 1.
 * Word 0 of every frame is the nibble word — sixteen 2-bit codes, one per word
 * of that frame, the first of which describes the nibble word itself and is
 * therefore always `00`.
 */
function decodeSteim(options: SteimDecodeOptions, unpack: Unpacker): Int32Array {
  const { view, dataOffset, recordLength, numSamples, littleEndian, stream } = options;

  if (numSamples < 0) {
    throw new SteimDecodeError(`${stream}: negative sample count ${String(numSamples)}`);
  }
  if (numSamples === 0) {
    return new Int32Array(0);
  }
  if (dataOffset < 0 || dataOffset >= recordLength) {
    throw new SteimDecodeError(
      `${stream}: data offset ${String(dataOffset)} outside record of ${String(recordLength)} bytes`,
    );
  }
  if (recordLength > view.byteLength) {
    throw new SteimDecodeError(
      `${stream}: record declares ${String(recordLength)} bytes but only ${String(
        view.byteLength,
      )} are present`,
    );
  }

  const frameCount = Math.floor((recordLength - dataOffset) / FRAME_BYTES);
  if (frameCount < 1) {
    throw new SteimDecodeError(`${stream}: record has no complete Steim frame`);
  }

  // One difference per sample. The first is the difference against the previous
  // record's last sample, so it is consumed and discarded — see the integration
  // below. Anything the encoder packed past this is padding in the final word
  // group and must be ignored, which is why the limit is the header's count.
  const diffs = new Int32Array(numSamples);
  let count = 0;
  let x0 = 0;
  let xn = 0;

  for (let frame = 0; frame < frameCount && count < numSamples; frame += 1) {
    const frameStart = dataOffset + frame * FRAME_BYTES;
    const nibbleWord = view.getUint32(frameStart, littleEndian);

    if (frame === 0) {
      x0 = view.getInt32(frameStart + 4, littleEndian);
      xn = view.getInt32(frameStart + 8, littleEndian);
    }
    const firstDataWord = frame === 0 ? 3 : 1;

    for (let w = firstDataWord; w < WORDS_PER_FRAME && count < numSamples; w += 1) {
      // Nibbles run most significant first: word w's code sits at bits
      // (30 - 2w)..(31 - 2w).
      const nibble = (nibbleWord >>> (30 - 2 * w)) & 0b11;
      if (nibble === 0) {
        continue;
      }
      const word = view.getUint32(frameStart + w * 4, littleEndian);
      count += unpack(word, nibble, diffs, count, numSamples, stream);
    }
  }

  if (count < numSamples) {
    throw new SteimDecodeError(
      `${stream}: record declares ${String(numSamples)} samples but only ${String(
        count,
      )} differences were packed`,
    );
  }

  const samples = new Int32Array(numSamples);
  samples[0] = x0;
  for (let i = 1; i < numSamples; i += 1) {
    // `diffs[0]` is deliberately never read: it is the difference against the
    // previous record, not against X0.
    samples[i] = (samples[i - 1] ?? 0) + (diffs[i] ?? 0);
  }

  const reached = samples[numSamples - 1] ?? 0;
  if (reached !== xn) {
    throw new MiniSeedIntegrityError(stream, xn, reached);
  }

  return samples;
}

export function decodeSteim1(options: SteimDecodeOptions): Int32Array {
  return decodeSteim(options, unpackSteim1);
}

export function decodeSteim2(options: SteimDecodeOptions): Int32Array {
  return decodeSteim(options, unpackSteim2);
}
