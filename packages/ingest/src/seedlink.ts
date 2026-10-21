/**
 * SeedLink client: v3.1 for the EarthScope and GeoNet rings, v4 for GEOFON,
 * and `BATCH` mode for SeisComP's own 3.x servers (`seedlinkDialectFrom`).
 *
 * SeedLink is a line-based handshake followed by a binary stream of fixed-size
 * packets, each wrapping one 512-byte miniSEED record. This module owns the
 * transport and nothing else: records leave here as raw bytes, and
 * `miniseed.ts` turns them into samples.
 *
 * The pure parts — the handshake script, the framer and the stream-id parser —
 * are separate from the socket so each can be tested exactly. Everything that
 * goes wrong in this protocol goes wrong *quietly*, so the structure is
 * deliberately explicit rather than compact.
 *
 * ## Four traps, every one of which fails silently
 *
 * Measured against EarthScope's ring, then `rtserve.iris.washington.edu:18000`
 * (RingServer 4.5.6), 2026-09-09/10:
 *
 * 1. **`CAPABILITIES SLPROTO:3.1` must follow `HELLO` and precede any
 *    `STATION`.** Without it RingServer 4.x serves v4 framing; a v3 parser then
 *    discards every packet and reports nothing.
 * 2. **The selector must never be `??HHZ`** — see `SEEDLINK_SELECTOR_NOTE` in
 *    the schema. It drops every blank-location station, which is 95-100% of
 *    the regional networks.
 * 3. **Framing must be strict.** Scanning forward for the next `SL` after a bad
 *    byte invents plausible-looking records; a phantom station `OTO:3` appeared
 *    in every run of a prototype that did this. On a signature mismatch the
 *    connection is dropped and rebuilt, never resynced.
 * 4. **The ring answers `OK` to everything.** A station, channel or network that
 *    does not exist is accepted, then produces nothing. So the handshake cannot
 *    tell a typo from a slow station, and `fetchRingInventory` consults the
 *    ring's own stream list instead. See `NOT_ON_RING_REASON` in the schema.
 */

import net from 'node:net';
import type { WaveformChannel } from '@terra-pulse/schema';
import { channelIdOf, seedlinkSelectorFor } from '@terra-pulse/schema';

/**
 * EarthScope's ring. It was `rtserve.iris.washington.edu` until that name
 * stopped resolving (NXDOMAIN, found 2026-10-21) — the IRIS → EarthScope rename
 * reaching the real-time ring, as it reached `service.iris.edu` earlier. Same
 * RingServer 4.5.6 behind it, same `/streamids` listing.
 *
 * **When this host dies nothing errors on screen.** The other servers still
 * fill the merged station list, so it never reads as unavailable; it simply has
 * no US stations, and a click in California picks nothing.
 */
export const SEEDLINK_HOST = 'rtserve.earthscope.org';
export const SEEDLINK_PORT = 18000;

/** `SL` + six-character sequence number + one 512-byte miniSEED record. */
export const SEEDLINK_PACKET_BYTES = 520;
const SEEDLINK_HEADER_BYTES = 8;

/**
 * How long any single handshake command may wait for its reply, and how long a
 * connection attempt may take, before the whole connection is treated as failed.
 *
 * Measured round trip is ~180 ms per command, so 10 s is far outside anything a
 * healthy server does and well inside the point where a reader would give up.
 */
export const SEEDLINK_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Upper bound on the inventory request. Measured typical is ~1.8 s for the
 * 1.24 MB list. Without a bound the fetch inherits undici's defaults — 300 s
 * for headers and another 300 s for the body — and a stalled transfer was seen
 * in testing to hang well past a minute. The signal also covers reading the
 * body, which is where a stall on a large response actually happens.
 */
export const RING_INVENTORY_TIMEOUT_MS = 20_000;

/**
 * **This request must ask for `identity` encoding, or it crashes the app.**
 *
 * The ring serves `/streamids` gzipped (128 KB compressed, 1.19 MB of text) and
 * closes the connection afterwards — `connection: close`. That combination
 * trips an assertion inside Node's own HTTP client:
 *
 *     AssertionError [ERR_ASSERTION]: assert(!this.paused)
 *       at Parser.finish (node:internal/deps/undici/undici)
 *       at Socket.onHttpSocketEnd
 *
 * The parser is paused for decompression when the socket ends. It throws from a
 * socket handler rather than rejecting the promise, so **no `try`/`catch` around
 * the fetch can catch it** — in the main process it lands as an uncaught
 * exception, which Electron shows the user as a modal error box. It was
 * reported exactly that way: two dialogs, on launch and on opening the mode.
 *
 * Measured against the live ring: **gzipped, it asserted on all three runs
 * (after 6, 10 and 19 successful requests); with `identity`, 90 consecutive
 * requests were clean.** The cost is transfer size — 1.19 MB rather than
 * 128 KB — which is paid once per session, since the result is cached for an
 * hour. That is the right trade against a crash dialog.
 *
 * Nothing else here needs this: every other source is an HTTPS CDN with
 * keep-alive, and none has ever shown it. If this ever recurs, the next step is
 * `node:http` plus `zlib` for this one request, which avoids undici entirely
 * and keeps the compression.
 */
export const RING_INVENTORY_IDENTITY_NOTE =
  'Accept-Encoding: identity is required — gzip + connection:close trips an assertion in ' +
  "Node's HTTP parser that cannot be caught and crashes the main process.";

export class SeedLinkProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedLinkProtocolError';
  }
}

export class SeedLinkDesyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedLinkDesyncError';
  }
}

// ---------------------------------------------------------------------------
// Ring inventory
// ---------------------------------------------------------------------------

/**
 * The FDSN Source Identifier the ring uses to name a channel.
 *
 * RingServer 4.x lists streams as `FDSN:NET_STA_LOC_B_S_s/MSEED` — the channel
 * code split into its band, source and subsource letters, each behind its own
 * underscore. `HHZ` is therefore `H_H_Z`, and a blank location leaves two
 * adjacent underscores: `FDSN:CI_ADO__H_H_Z/MSEED`.
 */
export function sourceIdOf(channel: WaveformChannel): string {
  const [band, source, subsource] = channel.channel.split('');
  return `FDSN:${channel.network}_${channel.station}_${channel.location}_${band ?? ''}_${
    source ?? ''
  }_${subsource ?? ''}/MSEED`;
}

const SOURCE_ID_PATTERN =
  /^FDSN:([A-Z0-9]{1,2})_([A-Z0-9]{1,5})_([A-Z0-9]{0,2})_([A-Z0-9])_([A-Z0-9])_([A-Z0-9])\/MSEED$/;

/**
 * Parses `/streamids` output into channels.
 *
 * Lines that are not a SEED-shaped source id are skipped rather than failing
 * the parse: FDSN source ids permit multi-character band and subsource codes
 * that have no three-letter channel equivalent, and those can never be
 * requested anyway.
 */
export function parseStreamIds(text: string): WaveformChannel[] {
  const channels: WaveformChannel[] = [];
  for (const raw of text.split('\n')) {
    const match = SOURCE_ID_PATTERN.exec(raw.trim());
    if (match === null) continue;
    const [, network, station, location, band, source, subsource] = match;
    channels.push({
      network: network ?? '',
      station: station ?? '',
      location: location ?? '',
      channel: `${band ?? ''}${source ?? ''}${subsource ?? ''}`,
    });
  }
  return channels;
}

/**
 * Every channel the ring carries, as a set of channel ids.
 *
 * Returns **null when the answer is unknown** — a network failure or an
 * unexpected response — and the caller must then treat every channel as
 * possibly present. An inventory check that failed closed would turn one flaky
 * HTTP request into "every station is missing".
 *
 * **The whole list, deliberately, not a server-side `match`.** `match` looks
 * like the efficient route — three channels come back in 52 bytes — but it has
 * an undocumented length cap, measured 2026-09-11: patterns up to 70 characters
 * return 200, 72 returns **500**, and 73 onward returns **414 URI Too Long**.
 * URL-encoded, that fits about two channels a request. The first version of
 * this used `match`, hit the cap at three channels, failed open exactly as
 * designed, and so would have shipped as a check that silently never ran —
 * found only by running it against the live ring.
 *
 * The full list is 1.24 MB and ~1.8 s. It is one request whatever the channel
 * count, depends on no undocumented limit, and is the same inventory a station
 * picker needs. It also costs the reader no waiting: the controller fetches it
 * *alongside* connecting, because requesting a station that is not on the ring
 * is harmless — it is acknowledged and then simply sends nothing.
 */
export async function fetchRingInventory(
  fetchImpl: typeof fetch = fetch,
  host: string = SEEDLINK_HOST,
  port: number = SEEDLINK_PORT,
  timeoutMs: number = RING_INVENTORY_TIMEOUT_MS,
): Promise<Set<string> | null> {
  let response: Response;
  let body: string;
  try {
    response = await fetchImpl(`http://${host}:${String(port)}/streamids`, {
      signal: AbortSignal.timeout(timeoutMs),
      // See RING_INVENTORY_IDENTITY_NOTE: compressed, this response crashes
      // the process.
      headers: { 'accept-encoding': 'identity' },
    });
    body = await response.text();
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const channels = parseStreamIds(body);
  // An empty parse of a non-empty body means the listing's format changed, not
  // that the ring is empty. Reporting "nothing is here" would reject every
  // channel on the strength of a parser that no longer understands the reply.
  if (channels.length === 0) return null;
  return new Set(channels.map(channelIdOf));
}

/**
 * The channel ids an `INFO STREAMS` reply lists, from its XML. Only data
 * streams (`type="D"`) — the others are logs, events and calibrations, which
 * no row or detector can use.
 *
 * Attribute order is not relied on: each element is found whole, then its
 * attributes read by name.
 *
 * **A forward scan, not a regex over the document, and that is load-bearing.**
 * It was `matchAll(/<station\b([^>]*)>([\s\S]*?)<\/station>/g)`, and found by
 * fuzzing: a reply that opens elements and never closes them makes every
 * opening scan to the end of the text. Measured, 1.2 MB of `<station ` took
 * **52 s**, quadrupling with each doubling — and this runs on the main
 * process, whose reader accepts 16 MB, so a hostile or broken server (or
 * anyone on the unencrypted connection) could freeze the app for hours. Each
 * `indexOf` below starts where the last stopped, so the whole parse is one
 * pass, and a missing close ends it: nothing later could close either.
 */
export function parseInfoStreams(xml: string): Set<string> {
  const ids = new Set<string>();
  let at = 0;
  for (;;) {
    const open = xml.indexOf('<station', at);
    if (open === -1) break;
    // `<stations…` is another element; the regex's `\b` excluded it too.
    if (/\w/.test(xml.charAt(open + 8))) {
      at = open + 8;
      continue;
    }
    const tagEnd = xml.indexOf('>', open);
    if (tagEnd === -1) break;
    const close = xml.indexOf('</station>', tagEnd);
    if (close === -1) break;

    const stationAttrs = xml.slice(open + 8, tagEnd);
    const network = /\bnetwork="([^"]*)"/.exec(stationAttrs)?.[1] ?? '';
    const station = /\bname="([^"]*)"/.exec(stationAttrs)?.[1] ?? '';
    for (const attrs of streamElements(xml.slice(tagEnd + 1, close))) {
      if ((/\btype="([^"]*)"/.exec(attrs)?.[1] ?? 'D') !== 'D') continue;
      const location = (/\blocation="([^"]*)"/.exec(attrs)?.[1] ?? '').trim();
      const channel = /\bseedname="([^"]*)"/.exec(attrs)?.[1] ?? '';
      if (network === '' || station === '' || channel === '') continue;
      ids.add(channelIdOf({ network, station, location, channel }));
    }
    at = close + '</station>'.length;
  }
  return ids;
}

/** The attribute text of each `<stream …>` in a station's body, in one forward pass. */
function streamElements(body: string): string[] {
  const elements: string[] = [];
  let at = 0;
  for (;;) {
    const open = body.indexOf('<stream', at);
    if (open === -1) break;
    if (/\w/.test(body.charAt(open + 7))) {
      at = open + 7;
      continue;
    }
    const tagEnd = body.indexOf('>', open);
    if (tagEnd === -1) break;
    // A self-closing `/>` leaves its slash on the attributes, as the regex's
    // greedy `[^>]*` did; no attribute read cares.
    elements.push(body.slice(open + 7, tagEnd));
    at = tagEnd + 1;
  }
  return elements;
}

/** `INFO STREAMS` from GeoNet is ~300 KB; this bounds a stall, not a slow link. */
export const SEEDLINK_INFO_TIMEOUT_MS = 30_000;
/** Stops a server that never sends its last info packet from growing the buffer forever. */
const SEEDLINK_INFO_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Every channel a SeedLink server carries, from the protocol's own
 * `INFO STREAMS` — for servers with no HTTP listing, which is all of them but
 * RingServer 4 (see `SEEDLINK_SERVERS`). Null when the answer is unknown, with
 * the same fail-open meaning as `fetchRingInventory`.
 *
 * The reply is a sequence of packets headed `SLINFO *` (more follow) and
 * `SLINFO  ` (the last), each wrapping one 512-byte miniSEED log record whose
 * text, concatenated, is one XML document. No `CAPABILITIES` is sent: INFO
 * packets keep this framing on every server version that answers it, and the
 * SeisComP servers refuse the command outright.
 */
export function fetchSeedLinkInventory(
  host: string,
  port: number = SEEDLINK_PORT,
  connect: SeedLinkConnect = connectSeedLinkSocket,
  timeoutMs: number = SEEDLINK_INFO_TIMEOUT_MS,
): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    const socket = connect(host, port);
    let settled = false;
    let buffer: Uint8Array = new Uint8Array(0);
    let helloLines = 0;
    let text = '';
    const decoder = new TextDecoder('latin1');
    let received = 0;
    const startedMs = Date.now();
    /** Null with a logged reason — "unknown" is the answer, but why is worth knowing. */
    const fail = (reason: string) => {
      if (settled) return;
      console.warn(
        `SeedLink INFO STREAMS from ${host} failed after ${String(Date.now() - startedMs)} ms, ${String(received)} bytes: ${reason}`,
      );
      finish(null);
    };
    const finish = (result: Set<string> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      fail('timed out');
    }, timeoutMs);

    socket.onConnect(() => {
      socket.write('HELLO\r\n');
    });
    socket.onError((error) => {
      fail(error.message);
    });
    socket.onClose(() => {
      fail('connection closed before the last info packet');
    });
    socket.onData((chunk) => {
      if (settled) return;
      received += chunk.length;
      buffer = concatBytes(buffer, chunk);
      if (received > SEEDLINK_INFO_MAX_BYTES) {
        fail('reply larger than any stream list');
        return;
      }
      while (helloLines < 2) {
        let end = -1;
        for (let i = 0; i + 1 < buffer.length; i += 1) {
          if (buffer[i] === CRLF[0] && buffer[i + 1] === CRLF[1]) {
            end = i;
            break;
          }
        }
        if (end === -1) return;
        buffer = buffer.slice(end + 2);
        helloLines += 1;
        if (helloLines === 2) socket.write('INFO STREAMS\r\n');
      }
      // Walk the packets by offset and trim once: GEOFON's list is 1.12 MB,
      // ~2,160 packets, and slicing per packet would copy the rest each time.
      let at = 0;
      while (buffer.length - at >= SEEDLINK_PACKET_BYTES) {
        const packet = buffer.subarray(at, at + SEEDLINK_PACKET_BYTES);
        if (decoder.decode(packet.subarray(0, 6)) !== 'SLINFO') {
          // An ERROR line in place of the packets: the server refuses INFO at
          // this level. Unknown, not empty.
          fail(`not an info packet: ${JSON.stringify(decoder.decode(packet.subarray(0, 24)))}`);
          return;
        }
        const more = packet[7] === 0x2a; // '*'
        const record = packet.subarray(SEEDLINK_HEADER_BYTES);
        const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
        const length = view.getUint16(30);
        const offset = view.getUint16(44);
        if (offset < 48 || offset + length > record.length) {
          fail(`info record text out of bounds (offset ${String(offset)}, length ${String(length)})`);
          return;
        }
        text += decoder.decode(record.subarray(offset, offset + length));
        at += SEEDLINK_PACKET_BYTES;
        if (!more) {
          const ids = parseInfoStreams(text);
          // A document that names nothing is a format we no longer read.
          if (ids.size === 0) fail('the stream list named no streams');
          else finish(ids);
          return;
        }
      }
      buffer = buffer.slice(at);
    });
  });
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

/**
 * One line of the handshake and what it expects back.
 *
 * The script is data rather than control flow so that its **ordering can be
 * asserted by a test** — trap 1 is an ordering rule, and an ordering buried in
 * socket callbacks is one nobody can check.
 *
 * Channels are grouped by station: one `STATION`, then a `SELECT` per channel,
 * then `DATA`. Issuing `STATION` twice for the same station would replace the
 * first rather than add to it.
 */
export type HandshakeStep =
  | { kind: 'hello'; line: 'HELLO'; replyLines: 2 }
  | { kind: 'capabilities'; line: 'CAPABILITIES SLPROTO:3.1'; replyLines: 1 }
  | { kind: 'slproto'; line: 'SLPROTO 4.0'; replyLines: 1 }
  | { kind: 'batch'; line: 'BATCH'; replyLines: 1 }
  | {
      kind: 'station';
      line: string;
      /** 0 in batch mode, where the server answers none of the station block. */
      replyLines: 0 | 1;
      stationKey: string;
      channelIds: readonly string[];
    }
  | { kind: 'select'; line: string; replyLines: 0 | 1; stationKey: string; channelId: string }
  | { kind: 'data'; line: 'DATA'; replyLines: 0 | 1; stationKey: string }
  | { kind: 'end'; line: 'END'; replyLines: 0 };

/**
 * Which handshake a server takes, decided from the first line of its `HELLO`:
 *
 * - **`v3.1`** when it advertises `SLPROTO:3.1` (RingServer — EarthScope,
 *   GeoNet). Preferred even where 4.0 is also offered: it is the path measured
 *   against EarthScope since 2026-09, and the one every trap note above
 *   describes.
 * - **`v4`** when it advertises only `SLPROTO:4.0` (GEOFON's server).
 * - **`batch`** when it advertises nothing — SeisComP's own SeedLink 3.x
 *   (BGR, ORFEUS, IPGP, Croatia, Brazil), whose `HELLO` is just
 *   `SeedLink v3.3 (2024.020)`. See `seedlinkHandshakeScript` for why.
 */
export type SeedLinkDialect = 'v3.1' | 'v4' | 'batch';

export function seedlinkDialectFrom(helloLine: string): SeedLinkDialect {
  const capabilities = helloLine.split('::')[1] ?? '';
  if (/\bSLPROTO:3\.1\b/.test(capabilities)) return 'v3.1';
  if (/\bSLPROTO:4\.0\b/.test(capabilities)) return 'v4';
  return 'batch';
}

/**
 * The SeedLink 4 stream selector, `LOC_B_S_SS`: the channel code split into
 * band, source and subsource, and a blank location left blank — `_H_H_Z`.
 * Measured on GEOFON 2026-10-08: that selects exactly the one channel, as
 * `00_B_H_Z` does for a real location.
 */
export function seedlink4SelectorFor(channel: WaveformChannel): string {
  const [band = '', source = '', subsource = ''] = channel.channel.split('');
  return `${channel.location}_${band}_${source}_${subsource}`;
}

/**
 * The handshake for a dialect. The station block is the same shape in all
 * three — `STATION`, a `SELECT` per channel, `DATA` — and only the opener and
 * the naming differ, except in batch mode, which changes who answers.
 *
 * ## Batch mode (SeisComP 3.x), measured 2026-10-09
 *
 * These servers reply `ERROR` to `CAPABILITIES`, and to a pipelined block they
 * act on the first line and drop the rest. `BATCH` is their own answer: it is
 * acknowledged `OK`, and after it the server **answers nothing** — not the
 * `STATION`, `SELECT` or `DATA` lines, and not `END`. So the whole block goes
 * in one write and streaming begins at once. Measured on BGR, ORFEUS,
 * Croatia, Brazil, Catalonia and Évora: first packet 1.3-3.4 s after `HELLO`.
 *
 * Silence covers refusals too: a station that does not exist and a `SELECT`
 * matching nothing were both met with no reply and no data, on four servers —
 * no stray `ERROR` in the stream to desynchronise the framer. That is
 * EarthScope's trap 4 by another route, and the same answer applies: the
 * controller checks each channel against the server's own stream list.
 */
export function seedlinkHandshakeScript(
  channels: readonly WaveformChannel[],
  dialect: SeedLinkDialect = 'v3.1',
): readonly HandshakeStep[] {
  const byStation = new Map<string, WaveformChannel[]>();
  for (const channel of channels) {
    const key = `${channel.network}_${channel.station}`;
    const group = byStation.get(key);
    if (group === undefined) byStation.set(key, [channel]);
    else group.push(channel);
  }

  const opener: HandshakeStep =
    dialect === 'v4'
      ? { kind: 'slproto', line: 'SLPROTO 4.0', replyLines: 1 }
      : dialect === 'batch'
        ? { kind: 'batch', line: 'BATCH', replyLines: 1 }
        : { kind: 'capabilities', line: 'CAPABILITIES SLPROTO:3.1', replyLines: 1 };
  const steps: HandshakeStep[] = [{ kind: 'hello', line: 'HELLO', replyLines: 2 }, opener];
  const replyLines = dialect === 'batch' ? 0 : 1;
  for (const [stationKey, group] of byStation) {
    const first = group[0];
    if (first === undefined) continue;
    steps.push({
      kind: 'station',
      // v4 names a station by its FDSN `NET_STA`; 3.x by two fields.
      line: dialect === 'v4' ? `STATION ${first.network}_${first.station}` : `STATION ${first.station} ${first.network}`,
      replyLines,
      stationKey,
      channelIds: group.map(channelIdOf),
    });
    for (const channel of group) {
      steps.push({
        kind: 'select',
        line: `SELECT ${dialect === 'v4' ? seedlink4SelectorFor(channel) : seedlinkSelectorFor(channel)}`,
        replyLines,
        stationKey,
        channelId: channelIdOf(channel),
      });
    }
    steps.push({ kind: 'data', line: 'DATA', replyLines, stationKey });
  }
  steps.push({ kind: 'end', line: 'END', replyLines: 0 });
  return steps;
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export interface FramerResult {
  /** Complete records, copied out so later input cannot mutate them. */
  records: Uint8Array[];
  /** Set when a packet failed its signature. The connection must be dropped. */
  desync: string | null;
}

/**
 * Splits the streaming phase into 512-byte records.
 *
 * TCP delivers bytes, not packets: a chunk may hold half a packet, several, or
 * end in the middle of the `SL` signature. So input accumulates until a whole
 * 520-byte packet is present.
 *
 * **A bad signature is terminal and sticky.** Records completed before it are
 * returned, because they passed; everything after is refused, because once the
 * stream is misaligned there is no way to know where the next packet starts.
 * Guessing — scanning for the next `SL` — is how a prototype of this invented
 * a phantom station.
 */
export class SeedLinkFramer {
  private buffer: Uint8Array = new Uint8Array(0);
  private desynced = false;

  push(chunk: Uint8Array): FramerResult {
    if (this.desynced) {
      return { records: [], desync: 'framer already desynchronised' };
    }
    this.buffer = concatBytes(this.buffer, chunk);

    const records: Uint8Array[] = [];
    let offset = 0;
    while (this.buffer.length - offset >= SEEDLINK_PACKET_BYTES) {
      const first = this.buffer[offset] ?? -1;
      const second = this.buffer[offset + 1] ?? -1;
      if (first !== 0x53 || second !== 0x4c) {
        this.desynced = true;
        this.buffer = new Uint8Array(0);
        return {
          records,
          desync: `expected "SL" packet signature, found bytes ${String(first)}/${String(second)}`,
        };
      }
      records.push(
        this.buffer.slice(offset + SEEDLINK_HEADER_BYTES, offset + SEEDLINK_PACKET_BYTES),
      );
      offset += SEEDLINK_PACKET_BYTES;
    }
    this.buffer = this.buffer.slice(offset);
    return { records, desync: null };
  }
}

/** SeedLink 4 header before the station id: `SE`, format, subformat, u32 length, u64 sequence, u8 id length. */
const SEEDLINK4_FIXED_HEADER_BYTES = 17;
/**
 * A miniSEED record is at most a few kilobytes; a "payload" larger than this
 * means the stream is misaligned and the length field is reading sample data.
 */
const SEEDLINK4_MAX_PAYLOAD_BYTES = 1 << 20;

/**
 * Splits a SeedLink 4 data stream into payloads (FDSN SeedLink 4 §"Data
 * packets"). Unlike 3.x, packets are **variable length**: the header carries
 * the payload's length, so a packet is complete only once that many bytes have
 * arrived after its station id.
 *
 * Only miniSEED data payloads are returned — format `2` or `3` with subformat
 * `D`. Anything else (logs, JSON info) is skipped whole, by its declared
 * length, which is what keeps the stream aligned past it.
 *
 * **Strict, as the 3.x framer is**: a signature other than `SE`, or a length no
 * miniSEED record could have, ends the stream rather than scanning for the next
 * `SE` — the same reason a 3.x desync is never resynchronised.
 */
export class SeedLink4Framer {
  private buffer: Uint8Array = new Uint8Array(0);
  private desynced = false;

  push(chunk: Uint8Array): FramerResult {
    if (this.desynced) return { records: [], desync: 'framer already desynchronised' };
    this.buffer = concatBytes(this.buffer, chunk);

    const records: Uint8Array[] = [];
    let offset = 0;
    for (;;) {
      if (this.buffer.length - offset < SEEDLINK4_FIXED_HEADER_BYTES) break;
      const first = this.buffer[offset] ?? -1;
      const second = this.buffer[offset + 1] ?? -1;
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset);
      const payloadLength = view.getUint32(4, true);
      if (first !== 0x53 || second !== 0x45 || payloadLength > SEEDLINK4_MAX_PAYLOAD_BYTES) {
        this.desynced = true;
        this.buffer = new Uint8Array(0);
        return {
          records,
          desync:
            first !== 0x53 || second !== 0x45
              ? `expected "SE" packet signature, found bytes ${String(first)}/${String(second)}`
              : `SeedLink 4 payload length ${String(payloadLength)} is not a miniSEED record`,
        };
      }
      const idLength = this.buffer[offset + 16] ?? 0;
      const start = offset + SEEDLINK4_FIXED_HEADER_BYTES + idLength;
      const end = start + payloadLength;
      if (end > this.buffer.length) break;
      const format = String.fromCharCode(this.buffer[offset + 2] ?? 0);
      const subformat = String.fromCharCode(this.buffer[offset + 3] ?? 0);
      if ((format === '2' || format === '3') && subformat === 'D') records.push(this.buffer.slice(start, end));
      offset = end;
    }
    this.buffer = this.buffer.slice(offset);
    return { records, desync: null };
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * The slice of a socket the session needs. An interface rather than
 * `net.Socket` so tests can drive the whole protocol from a plain object.
 */
export interface SeedLinkSocket {
  write(text: string): void;
  destroy(): void;
  onConnect(listener: () => void): void;
  onData(listener: (chunk: Uint8Array) => void): void;
  onError(listener: (error: Error) => void): void;
  onClose(listener: () => void): void;
}

export type SeedLinkConnect = (host: string, port: number) => SeedLinkSocket;

/**
 * The real transport. Keepalive is set because this is the app's only
 * long-lived outbound connection, and an idle NAT mapping dropped without a
 * FIN would otherwise leave a socket that looks open and delivers nothing.
 */
export const connectSeedLinkSocket: SeedLinkConnect = (host, port) => {
  const socket = net.connect({ host, port });
  socket.setKeepAlive(true, 30_000);
  return {
    write: (text) => {
      socket.write(text, 'ascii');
    },
    destroy: () => {
      socket.destroy();
    },
    onConnect: (listener) => {
      socket.once('connect', listener);
    },
    onData: (listener) => {
      socket.on('data', listener);
    },
    onError: (listener) => {
      socket.on('error', listener);
    },
    onClose: (listener) => {
      socket.once('close', listener);
    },
  };
};

export interface SeedLinkSessionOptions {
  channels: readonly WaveformChannel[];
  host?: string;
  port?: number;
  connect?: SeedLinkConnect;
  commandTimeoutMs?: number;
  /** One raw 512-byte miniSEED record. */
  onRecord: (record: Uint8Array) => void;
  /** A channel the server refused during the handshake. */
  onChannelRejected?: (channelId: string, reason: string) => void;
  /** The handshake finished and records may now arrive. */
  onStreaming?: (acceptedChannelIds: readonly string[]) => void;
  /**
   * The session ended for any reason **other than `close()`**, exactly once.
   * `error` is null only if the server closed a healthy stream cleanly.
   */
  onEnd: (error: Error | null) => void;
}

export interface SeedLinkSession {
  /** Ends the session. `onEnd` is not called, and no callback fires after. */
  close(): void;
}

const CRLF = [0x0d, 0x0a] as const;

/**
 * One SeedLink connection carrying every requested channel.
 *
 * Multi-station mode exists for this: every record carries its own
 * network/station/location/channel, so demultiplexing is by header rather than
 * by socket. One connection is one thing to back off, one status and one thing
 * to stop.
 *
 * **`HELLO` and `CAPABILITIES` go one at a time; every station line goes in one
 * write.** The two openers must be sequential — a refused `CAPABILITIES` has
 * to stop the session before any `STATION` is sent (trap 1). The station block
 * is pipelined, because one command at a time costs a full round trip each,
 * three per station: measured on the live ring 2026-10-08, **74 stations took
 * 17.4 s sequentially and 0.53 s pipelined**, all 225 replies OK. That is the
 * difference between a live watch that starts at once and one that sits
 * deaf for most of twenty seconds on every reconnect.
 *
 * Replies are still matched to commands **by position**, which pipelining does
 * not disturb: one TCP stream, one reply line per command, answered in order.
 *
 * One behaviour this gives up: sequentially, a station whose `SELECT` was
 * refused never got its `DATA` (which with no selector streams *every* channel
 * of the station). Pipelined, the `DATA` is already on the wire. The ring has
 * never refused a `SELECT` — trap 4 — and anything unrequested that did arrive
 * would be dropped by the caller, which keeps only the channels it asked for.
 *
 * **Batch mode (SeisComP 3.x) has no replies to match.** After `BATCH` is
 * acknowledged the block and `END` go out together and streaming begins; see
 * `seedlinkHandshakeScript`. The command timer stops with the `OK`, so a
 * server that then sends nothing is the controller's stall detection to catch,
 * exactly as a silent station is.
 */
export function createSeedLinkSession(options: SeedLinkSessionOptions): SeedLinkSession {
  const {
    channels,
    host = SEEDLINK_HOST,
    port = SEEDLINK_PORT,
    connect = connectSeedLinkSocket,
    commandTimeoutMs = SEEDLINK_COMMAND_TIMEOUT_MS,
    onRecord,
    onChannelRejected,
    onStreaming,
    onEnd,
  } = options;

  // The script and framer are chosen once HELLO says which protocol the server
  // speaks (`seedlinkDialectFrom`); HELLO itself is step 0 of every script.
  let script = seedlinkHandshakeScript(channels);
  let dialect: SeedLinkDialect = 'v3.1';
  let framer: { push(chunk: Uint8Array): FramerResult } = new SeedLinkFramer();
  let helloFirstLine: string | null = null;

  let phase: 'connecting' | 'handshake' | 'streaming' = 'connecting';
  let done = false;
  let closedByCaller = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** The step the next reply line belongs to. */
  let stepIndex = -1;
  let repliesOutstanding = 0;
  /** Set once the station block has been written in one go. */
  let pipelined = false;
  let lineBuffer: Uint8Array = new Uint8Array(0);

  const stationRefused = new Set<string>();
  const accepted = new Map<string, string[]>(); // stationKey -> accepted channel ids

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const armTimer = (what: string) => {
    clearTimer();
    timer = setTimeout(() => {
      finish(new SeedLinkProtocolError(`no reply to ${what} within ${String(commandTimeoutMs)} ms`));
    }, commandTimeoutMs);
  };

  const socket = connect(host, port);

  function finish(error: Error | null): void {
    if (done) return;
    done = true;
    clearTimer();
    socket.destroy();
    if (!closedByCaller) onEnd(error);
  }

  function reject(channelId: string, reason: string): void {
    onChannelRejected?.(channelId, reason);
  }

  /** Writes the next opener, or — once both are answered — the whole station block. */
  function sendNext(): void {
    stepIndex += 1;
    const step = script[stepIndex];
    if (step === undefined) {
      finish(new SeedLinkProtocolError('handshake script ended without END'));
      return;
    }
    if (step.kind === 'hello' || step.kind === 'capabilities' || step.kind === 'slproto' || step.kind === 'batch') {
      repliesOutstanding = step.replyLines;
      armTimer(step.line);
      socket.write(`${step.line}\r\n`);
      return;
    }
    if (step.kind === 'end') {
      endHandshake(step.line);
      return;
    }
    if (dialect === 'batch') {
      // Nothing in the block is answered, END included, so it all goes in one
      // write — the shape measured on every SeisComP server — and every channel
      // counts as accepted. An absent one is caught by the inventory check.
      clearTimer();
      socket.write(script.slice(stepIndex).map((s) => `${s.line}\r\n`).join(''));
      for (const s of script) {
        if (s.kind === 'select') accepted.set(s.stationKey, [...(accepted.get(s.stationKey) ?? []), s.channelId]);
      }
      beginStreaming();
      return;
    }

    // Every STATION, SELECT and DATA, in one write. Each answers one line, so
    // the replies are walked step by step in `handleReply`.
    const block = script.slice(stepIndex).filter((s) => s.kind !== 'end');
    pipelined = true;
    repliesOutstanding = step.replyLines;
    armTimer(step.line);
    socket.write(block.map((s) => `${s.line}\r\n`).join(''));
  }

  /** The step after the current one in the pipelined block; no write, it is already sent. */
  function advancePipelined(): void {
    stepIndex += 1;
    const step = script[stepIndex];
    if (step === undefined) {
      finish(new SeedLinkProtocolError('handshake script ended without END'));
      return;
    }
    if (step.kind === 'end') {
      endHandshake(step.line);
      return;
    }
    repliesOutstanding = step.replyLines;
    // Re-armed per reply: the bound is on the server going quiet, not on how
    // long a long block takes to answer in full.
    armTimer(step.line);
  }

  function endHandshake(endLine: string): void {
    if ([...accepted.values()].flat().length === 0) {
      finish(new SeedLinkProtocolError('no requested channel was accepted by the server'));
      return;
    }
    clearTimer();
    socket.write(`${endLine}\r\n`);
    beginStreaming();
  }

  /** END is written; from here every byte is packets. */
  function beginStreaming(): void {
    phase = 'streaming';
    onStreaming?.([...accepted.values()].flat());
    // Anything already buffered past the last reply belongs to the stream.
    const leftover = lineBuffer;
    lineBuffer = new Uint8Array(0);
    if (leftover.length > 0) handleStreaming(leftover);
  }

  function handleReply(line: string): void {
    const step = script[stepIndex];
    if (step === undefined) return;
    const refused = line.startsWith('ERROR');

    switch (step.kind) {
      case 'hello':
        if (helloFirstLine === null) {
          helloFirstLine = line;
          // Before the second reply line lands, so the next step sent is the
          // right protocol's. Steps after HELLO are rebuilt; HELLO is shared.
          dialect = seedlinkDialectFrom(line);
          if (dialect !== 'v3.1') script = seedlinkHandshakeScript(channels, dialect);
          if (dialect === 'v4') framer = new SeedLink4Framer();
        }
        break;
      case 'capabilities':
        if (refused) {
          // Trap 1: without 3.1 framing every packet would be discarded.
          finish(new SeedLinkProtocolError(`server refused CAPABILITIES SLPROTO:3.1: ${line}`));
          return;
        }
        break;
      case 'batch':
        if (refused) {
          finish(new SeedLinkProtocolError(`server refused BATCH: ${line}`));
          return;
        }
        break;
      case 'slproto':
        if (refused) {
          finish(new SeedLinkProtocolError(`server refused SLPROTO 4.0: ${line}`));
          return;
        }
        break;
      case 'station':
        if (refused) {
          stationRefused.add(step.stationKey);
          for (const channelId of step.channelIds) {
            reject(channelId, `server refused STATION: ${line}`);
          }
        }
        break;
      case 'select':
        // Its STATION was refused, so the channel is rejected already —
        // whatever this line says.
        if (stationRefused.has(step.stationKey)) break;
        if (refused) {
          reject(step.channelId, `server refused SELECT: ${line}`);
        } else {
          const list = accepted.get(step.stationKey) ?? [];
          list.push(step.channelId);
          accepted.set(step.stationKey, list);
        }
        break;
      case 'data':
        if (refused && !stationRefused.has(step.stationKey)) {
          for (const channelId of accepted.get(step.stationKey) ?? []) {
            reject(channelId, `server refused DATA: ${line}`);
          }
          accepted.delete(step.stationKey);
        }
        break;
      case 'end':
        return;
    }

    repliesOutstanding -= 1;
    if (repliesOutstanding > 0) return;
    if (pipelined) advancePipelined();
    else sendNext();
  }

  function handleHandshake(chunk: Uint8Array): void {
    lineBuffer = concatBytes(lineBuffer, chunk);
    for (;;) {
      if (done || phase !== 'handshake') return;
      let end = -1;
      for (let i = 0; i + 1 < lineBuffer.length; i += 1) {
        if (lineBuffer[i] === CRLF[0] && lineBuffer[i + 1] === CRLF[1]) {
          end = i;
          break;
        }
      }
      if (end === -1) return;
      const line = new TextDecoder('ascii').decode(lineBuffer.subarray(0, end));
      lineBuffer = lineBuffer.slice(end + 2);
      handleReply(line);
    }
  }

  function handleStreaming(chunk: Uint8Array): void {
    const { records, desync } = framer.push(chunk);
    for (const record of records) {
      if (done) return;
      onRecord(record);
    }
    if (desync !== null) finish(new SeedLinkDesyncError(desync));
  }

  armTimer('connection attempt');

  socket.onConnect(() => {
    if (done) return;
    phase = 'handshake';
    sendNext();
  });

  socket.onData((chunk) => {
    if (done) return;
    if (phase === 'handshake') handleHandshake(chunk);
    else if (phase === 'streaming') handleStreaming(chunk);
  });

  socket.onError((error) => {
    finish(error);
  });

  socket.onClose(() => {
    finish(
      phase === 'streaming' ? null : new SeedLinkProtocolError(`connection closed during ${phase}`),
    );
  });

  return {
    close: () => {
      if (done) return;
      closedByCaller = true;
      finish(null);
    },
  };
}
