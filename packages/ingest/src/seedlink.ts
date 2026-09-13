/**
 * SeedLink v3.1 client for the EarthScope ring.
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
 * Measured against `rtserve.iris.washington.edu:18000` (RingServer 4.5.6),
 * 2026-09-09/10:
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

export const SEEDLINK_HOST = 'rtserve.iris.washington.edu';
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
  | {
      kind: 'station';
      line: string;
      replyLines: 1;
      stationKey: string;
      channelIds: readonly string[];
    }
  | { kind: 'select'; line: string; replyLines: 1; stationKey: string; channelId: string }
  | { kind: 'data'; line: 'DATA'; replyLines: 1; stationKey: string }
  | { kind: 'end'; line: 'END'; replyLines: 0 };

export function seedlinkHandshakeScript(
  channels: readonly WaveformChannel[],
): readonly HandshakeStep[] {
  const byStation = new Map<string, WaveformChannel[]>();
  for (const channel of channels) {
    const key = `${channel.network}_${channel.station}`;
    const group = byStation.get(key);
    if (group === undefined) byStation.set(key, [channel]);
    else group.push(channel);
  }

  const steps: HandshakeStep[] = [
    { kind: 'hello', line: 'HELLO', replyLines: 2 },
    { kind: 'capabilities', line: 'CAPABILITIES SLPROTO:3.1', replyLines: 1 },
  ];
  for (const [stationKey, group] of byStation) {
    const first = group[0];
    if (first === undefined) continue;
    steps.push({
      kind: 'station',
      line: `STATION ${first.station} ${first.network}`,
      replyLines: 1,
      stationKey,
      channelIds: group.map(channelIdOf),
    });
    for (const channel of group) {
      steps.push({
        kind: 'select',
        line: `SELECT ${seedlinkSelectorFor(channel)}`,
        replyLines: 1,
        stationKey,
        channelId: channelIdOf(channel),
      });
    }
    steps.push({ kind: 'data', line: 'DATA', replyLines: 1, stationKey });
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
 * **Strictly sequential.** No command is written until the previous reply has
 * landed. Pipelining would be faster, but the reply to a `SELECT` is only
 * attributable to its channel by order, and a misattributed rejection would
 * report the wrong station as missing.
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

  const script = seedlinkHandshakeScript(channels);
  const framer = new SeedLinkFramer();

  let phase: 'connecting' | 'handshake' | 'streaming' = 'connecting';
  let done = false;
  let closedByCaller = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  let stepIndex = -1;
  let repliesOutstanding = 0;
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

  /** Whether a step should be skipped given what has been refused so far. */
  function skipped(step: HandshakeStep): boolean {
    if (step.kind === 'select') return stationRefused.has(step.stationKey);
    if (step.kind === 'data') {
      // DATA with no accepted selector would stream *every* channel of the
      // station, which is the opposite of what was asked for.
      return stationRefused.has(step.stationKey) || (accepted.get(step.stationKey) ?? []).length === 0;
    }
    return false;
  }

  function sendNext(): void {
    stepIndex += 1;
    while (stepIndex < script.length) {
      const step = script[stepIndex];
      if (step === undefined || !skipped(step)) break;
      stepIndex += 1;
    }

    const step = script[stepIndex];
    if (step === undefined) {
      finish(new SeedLinkProtocolError('handshake script ended without END'));
      return;
    }

    if (step.kind === 'end') {
      const acceptedIds = [...accepted.values()].flat();
      if (acceptedIds.length === 0) {
        finish(new SeedLinkProtocolError('no requested channel was accepted by the server'));
        return;
      }
      clearTimer();
      socket.write(`${step.line}\r\n`);
      phase = 'streaming';
      onStreaming?.(acceptedIds);
      // Anything already buffered past the last reply belongs to the stream.
      const leftover = lineBuffer;
      lineBuffer = new Uint8Array(0);
      if (leftover.length > 0) handleStreaming(leftover);
      return;
    }

    repliesOutstanding = step.replyLines;
    armTimer(step.line);
    socket.write(`${step.line}\r\n`);
  }

  function handleReply(line: string): void {
    const step = script[stepIndex];
    if (step === undefined) return;
    const refused = line.startsWith('ERROR');

    switch (step.kind) {
      case 'hello':
        break;
      case 'capabilities':
        if (refused) {
          // Trap 1: without 3.1 framing every packet would be discarded.
          finish(new SeedLinkProtocolError(`server refused CAPABILITIES SLPROTO:3.1: ${line}`));
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
        if (refused) {
          reject(step.channelId, `server refused SELECT: ${line}`);
        } else {
          const list = accepted.get(step.stationKey) ?? [];
          list.push(step.channelId);
          accepted.set(step.stationKey, list);
        }
        break;
      case 'data':
        if (refused) {
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
    if (repliesOutstanding <= 0) sendNext();
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
