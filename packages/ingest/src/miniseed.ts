/**
 * miniSEED 2.4 record parsing.
 *
 * One record is a 48-byte fixed header, a chain of optional "blockettes", and a
 * payload whose encoding the blockettes describe. Everything here is pure: the
 * transport that produces these bytes lives in `seedlink.ts`.
 *
 * Measured against the live EarthScope ring 2026-09-09: every record was
 * 512 bytes, big-endian, Steim-2, with blockettes 1000 and 1001 present and a
 * data offset of 64 (so seven Steim frames). None of that is assumed below —
 * all of it is read from the record — but it is the shape to expect.
 */

import type { WaveformChannel } from '@terra-pulse/schema';
import { channelIdOf } from '@terra-pulse/schema';
import { decodeSteim1, decodeSteim2 } from './steim';

export class MiniSeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MiniSeedParseError';
  }
}

/**
 * A decoded data record.
 *
 * `quality` is the record's data-type code (`D`, `R`, `Q`, `M`). It is carried
 * rather than filtered on — see `SEEDLINK_SELECTOR_NOTE` for why the selector
 * deliberately does not constrain it.
 */
export interface MiniSeedDataRecord {
  kind: 'data';
  channel: WaveformChannel;
  channelId: string;
  quality: string;
  encoding: number;
  startTimeMs: number;
  sampleRateHz: number;
  samples: Int32Array;
}

/**
 * A log or INFO record, which RingServer sends down the same connection as
 * data.
 *
 * **This is not an error and must not be thrown on.** Treating an INFO reply as
 * a malformed record would tear down a perfectly healthy stream.
 */
export interface MiniSeedLogRecord {
  kind: 'log';
  channel: WaveformChannel;
  channelId: string;
}

export type MiniSeedRecord = MiniSeedDataRecord | MiniSeedLogRecord;

const FIXED_HEADER_BYTES = 48;

/** ASCII/text payload. RingServer uses this for log and INFO records. */
const ENCODING_ASCII = 0;
const ENCODING_INT16 = 1;
const ENCODING_INT32 = 3;
const ENCODING_STEIM1 = 10;
const ENCODING_STEIM2 = 11;

/**
 * Resolves the sample rate from the header's factor/multiplier pair.
 *
 * **All four branches occur in the wild**, which is why this is a table rather
 * than a multiplication. Negative values encode periods rather than rates: a
 * factor of -10 with a multiplier of 1 is one sample every ten seconds, not
 * minus ten hertz.
 */
export function sampleRateFrom(factor: number, multiplier: number): number {
  if (factor > 0 && multiplier > 0) return factor * multiplier;
  if (factor > 0 && multiplier < 0) return -factor / multiplier;
  if (factor < 0 && multiplier > 0) return -multiplier / factor;
  if (factor < 0 && multiplier < 0) return 1 / (factor * multiplier);
  // Either term zero: the record does not state a rate. Callers need one to
  // place samples in time, so this is fatal rather than defaulted.
  return 0;
}

/**
 * Reads the BTIME structure at `offset` as epoch milliseconds.
 *
 * Seconds may legitimately be 60 on a leap second; `Date.UTC` absorbs that by
 * rolling over, which is the right behaviour — the alternative is rejecting a
 * valid record twice a decade.
 */
function readBtimeMs(view: DataView, offset: number, littleEndian: boolean): number {
  const year = view.getUint16(offset, littleEndian);
  const dayOfYear = view.getUint16(offset + 2, littleEndian);
  const hour = view.getUint8(offset + 4);
  const minute = view.getUint8(offset + 5);
  const second = view.getUint8(offset + 6);
  // offset + 7 is unused padding.
  const tenThousandths = view.getUint16(offset + 8, littleEndian);

  return (
    Date.UTC(year, 0, 1, hour, minute, second) +
    (dayOfYear - 1) * 86_400_000 +
    tenThousandths / 10
  );
}

/**
 * Decides the record's byte order.
 *
 * **This is genuinely circular in the format and has to be broken by a
 * heuristic.** miniSEED 2 puts the authoritative word order in blockette 1000,
 * but you need the byte order already to read the offset at byte 46 that tells
 * you where blockette 1000 is. So: read the year and day-of-year both ways and
 * take whichever is a plausible date, then cross-check against blockette 1000
 * once it is reachable and throw if the two disagree.
 *
 * Never silently prefer one. A disagreement means the heuristic matched noise,
 * and continuing would produce a record with a believable timestamp and
 * scrambled samples.
 */
function guessLittleEndian(view: DataView): boolean {
  const yearBe = view.getUint16(20, false);
  const dayBe = view.getUint16(22, false);
  if (yearBe >= 1900 && yearBe <= 2100 && dayBe >= 1 && dayBe <= 366) {
    return false;
  }
  const yearLe = view.getUint16(20, true);
  const dayLe = view.getUint16(22, true);
  if (yearLe >= 1900 && yearLe <= 2100 && dayLe >= 1 && dayLe <= 366) {
    return true;
  }
  throw new MiniSeedParseError(
    `record start time is implausible in both byte orders (big-endian ${String(
      yearBe,
    )}/${String(dayBe)}, little-endian ${String(yearLe)}/${String(dayLe)})`,
  );
}

interface Blockette1000 {
  encoding: number;
  littleEndian: boolean;
  recordLength: number;
}

/**
 * Walks the blockette chain, returning what blockettes 1000 and 1001 carry.
 *
 * Blockette 1000 is **required**: it holds the encoding, the word order and the
 * record length. Its absence is an error rather than a cue to assume defaults,
 * because every default that could be chosen here is wrong for some real record.
 *
 * Blockette 1001 is optional and contributes sub-100-microsecond start-time
 * precision. Without it start times quantise to 0.1 ms, which is harmless for
 * display; with it, they are exact.
 */
function walkBlockettes(
  view: DataView,
  littleEndian: boolean,
  blocketteCount: number,
  firstOffset: number,
  recordBytes: number,
): { b1000: Blockette1000 | null; microseconds: number } {
  let b1000: Blockette1000 | null = null;
  let microseconds = 0;
  let offset = firstOffset;

  for (let i = 0; i < blocketteCount; i += 1) {
    if (offset <= 0 || offset + 4 > recordBytes) break;
    const type = view.getUint16(offset, littleEndian);
    const next = view.getUint16(offset + 2, littleEndian);

    if (type === 1000 && offset + 8 <= recordBytes) {
      const lengthLog2 = view.getUint8(offset + 6);
      b1000 = {
        encoding: view.getUint8(offset + 4),
        littleEndian: view.getUint8(offset + 5) === 0,
        recordLength: 2 ** lengthLog2,
      };
    } else if (type === 1001 && offset + 8 <= recordBytes) {
      microseconds = view.getInt8(offset + 5);
    }

    if (next <= offset) break; // A non-advancing chain would loop forever.
    offset = next;
  }

  return { b1000, microseconds };
}

/** Reads a space-padded ASCII field. */
function readText(bytes: Uint8Array, start: number, end: number): string {
  let text = '';
  for (let i = start; i < end; i += 1) {
    text += String.fromCharCode(bytes[i] ?? 0);
  }
  return text.trim();
}

/**
 * Parses one miniSEED record.
 *
 * Throws `MiniSeedParseError` for a record that cannot be understood and
 * `MiniSeedIntegrityError` (from `steim.ts`) for one that decodes to something
 * other than it declares. **Both are per-record conditions** — the caller drops
 * the record and keeps the connection, because one odd channel must not take
 * down a session carrying seven healthy ones.
 */
export function parseMiniSeedRecord(bytes: Uint8Array): MiniSeedRecord {
  if (bytes.byteLength < FIXED_HEADER_BYTES) {
    throw new MiniSeedParseError(
      `record is ${String(bytes.byteLength)} bytes, shorter than the 48-byte fixed header`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const littleEndian = guessLittleEndian(view);

  const quality = String.fromCharCode(bytes[6] ?? 0);
  const channel: WaveformChannel = {
    station: readText(bytes, 8, 13),
    location: readText(bytes, 13, 15),
    channel: readText(bytes, 15, 18),
    network: readText(bytes, 18, 20),
  };
  const channelId = channelIdOf(channel);

  const numSamples = view.getUint16(30, littleEndian);
  const rateFactor = view.getInt16(32, littleEndian);
  const rateMultiplier = view.getInt16(34, littleEndian);
  const blocketteCount = view.getUint8(39);
  const dataOffset = view.getUint16(44, littleEndian);
  const firstBlockette = view.getUint16(46, littleEndian);

  const { b1000, microseconds } = walkBlockettes(
    view,
    littleEndian,
    blocketteCount,
    firstBlockette,
    bytes.byteLength,
  );

  if (b1000 === null) {
    throw new MiniSeedParseError(`${channelId}: blockette 1000 is absent, so the encoding is unknown`);
  }
  if (b1000.littleEndian !== littleEndian) {
    throw new MiniSeedParseError(
      `${channelId}: byte order from the start-time heuristic (${
        littleEndian ? 'little' : 'big'
      }-endian) disagrees with blockette 1000 (${b1000.littleEndian ? 'little' : 'big'}-endian)`,
    );
  }

  if (b1000.encoding === ENCODING_ASCII) {
    return { kind: 'log', channel, channelId };
  }

  const sampleRateHz = sampleRateFrom(rateFactor, rateMultiplier);
  if (!(sampleRateHz > 0)) {
    throw new MiniSeedParseError(
      `${channelId}: sample rate is unusable (factor ${String(rateFactor)}, multiplier ${String(
        rateMultiplier,
      )})`,
    );
  }

  const recordLength = Math.min(b1000.recordLength, bytes.byteLength);
  const startTimeMs = readBtimeMs(view, 20, littleEndian) + microseconds / 1000;

  const samples = decodeSamples({
    view,
    bytes,
    encoding: b1000.encoding,
    dataOffset,
    recordLength,
    numSamples,
    littleEndian,
    stream: channelId,
  });

  return {
    kind: 'data',
    channel,
    channelId,
    quality,
    encoding: b1000.encoding,
    startTimeMs,
    sampleRateHz,
    samples,
  };
}

function decodeSamples(options: {
  view: DataView;
  bytes: Uint8Array;
  encoding: number;
  dataOffset: number;
  recordLength: number;
  numSamples: number;
  littleEndian: boolean;
  stream: string;
}): Int32Array {
  const { view, encoding, dataOffset, recordLength, numSamples, littleEndian, stream } = options;

  switch (encoding) {
    case ENCODING_STEIM1:
      return decodeSteim1({ view, dataOffset, recordLength, numSamples, littleEndian, stream });
    case ENCODING_STEIM2:
      return decodeSteim2({ view, dataOffset, recordLength, numSamples, littleEndian, stream });
    case ENCODING_INT16: {
      const samples = new Int32Array(numSamples);
      for (let i = 0; i < numSamples; i += 1) {
        samples[i] = view.getInt16(dataOffset + i * 2, littleEndian);
      }
      return samples;
    }
    case ENCODING_INT32: {
      const samples = new Int32Array(numSamples);
      for (let i = 0; i < numSamples; i += 1) {
        samples[i] = view.getInt32(dataOffset + i * 4, littleEndian);
      }
      return samples;
    }
    default:
      // Rejected per record, never per connection: an unfamiliar encoding on one
      // channel must not end a session that is carrying others successfully.
      throw new MiniSeedParseError(`${stream}: unsupported data encoding ${String(encoding)}`);
  }
}
