import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WaveformChannel } from '@terra-pulse/schema';
import {
  SEEDLINK_COMMAND_TIMEOUT_MS,
  SEEDLINK_PACKET_BYTES,
  SeedLinkDesyncError,
  SeedLinkFramer,
  type SeedLinkSocket,
  createSeedLinkSession,
  fetchRingInventory,
  parseStreamIds,
  seedlinkHandshakeScript,
  sourceIdOf,
} from './seedlink';

const ADO: WaveformChannel = { network: 'CI', station: 'ADO', location: '', channel: 'HHZ' };
const BAK: WaveformChannel = { network: 'CI', station: 'BAK', location: '', channel: 'HHZ' };
const AFI_10: WaveformChannel = { network: 'IU', station: 'AFI', location: '10', channel: 'BHZ' };
const AFI_00: WaveformChannel = { network: 'IU', station: 'AFI', location: '00', channel: 'BHZ' };

describe('seedlinkHandshakeScript', () => {
  it('sends CAPABILITIES SLPROTO:3.1 after HELLO and before any STATION, or every packet is silently discarded', () => {
    const lines = seedlinkHandshakeScript([ADO, AFI_10]).map((step) => step.line);
    expect(lines[0]).toBe('HELLO');
    expect(lines[1]).toBe('CAPABILITIES SLPROTO:3.1');
    const firstStation = lines.findIndex((line) => line.startsWith('STATION'));
    expect(firstStation).toBeGreaterThan(1);
  });

  it('selects a blank-location channel by bare code: never "??HHZ", never "HHZ.D"', () => {
    const lines = seedlinkHandshakeScript([ADO]).map((step) => step.line);
    expect(lines).toContain('SELECT HHZ');
    expect(lines.some((line) => line.includes('??'))).toBe(false);
    expect(lines.some((line) => line.includes('.D'))).toBe(false);
  });

  it('writes a real location into the selector, since bare BHZ at IU delivers every location', () => {
    const lines = seedlinkHandshakeScript([AFI_10]).map((step) => step.line);
    expect(lines).toContain('SELECT 10BHZ');
  });

  it('groups channels by station: one STATION, a SELECT each, one DATA', () => {
    expect(seedlinkHandshakeScript([AFI_10, AFI_00, ADO]).map((step) => step.line)).toEqual([
      'HELLO',
      'CAPABILITIES SLPROTO:3.1',
      'STATION AFI IU',
      'SELECT 10BHZ',
      'SELECT 00BHZ',
      'DATA',
      'STATION ADO CI',
      'SELECT HHZ',
      'DATA',
      'END',
    ]);
  });
});

describe('ring inventory', () => {
  it('names channels by FDSN source id, with a doubled underscore for a blank location', () => {
    expect(sourceIdOf(ADO)).toBe('FDSN:CI_ADO__H_H_Z/MSEED');
    expect(sourceIdOf(AFI_10)).toBe('FDSN:IU_AFI_10_B_H_Z/MSEED');
  });

  it('parses /streamids lines and skips anything without a three-letter channel', () => {
    const text = [
      'FDSN:CI_ADO__H_H_Z/MSEED',
      'FDSN:IU_AFI_10_B_H_Z/MSEED',
      'FDSN:XX_ODD__H_HH_Z/MSEED',
      '',
    ].join('\n');
    expect(parseStreamIds(text)).toEqual([ADO, AFI_10]);
  });

  function fakeFetch(status: number, body: string): typeof fetch {
    return vi.fn(() => Promise.resolve(new Response(body, { status })));
  }

  it('returns every channel id the ring lists', async () => {
    const listing = 'FDSN:CI_ADO__H_H_Z/MSEED\nFDSN:IU_AFI_10_B_H_Z/MSEED\n';
    expect(await fetchRingInventory(fakeFetch(200, listing))).toEqual(
      new Set(['CI_ADO__HHZ', 'IU_AFI_10_BHZ']),
    );
  });

  it('reads the whole list, never a server-side match, which 414s past ~70 characters', async () => {
    const spy = fakeFetch(200, 'FDSN:CI_ADO__H_H_Z/MSEED\n');
    await fetchRingInventory(spy);
    expect(spy).toHaveBeenCalledWith(
      'http://rtserve.iris.washington.edu:18000/streamids',
      expect.objectContaining({ signal: expect.any(AbortSignal) as unknown }),
    );
  });

  it('gives up on a stalled transfer instead of inheriting a five-minute default', async () => {
    // Honour the signal the way real fetch does: reject when it aborts.
    const stalled = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    ) as unknown as typeof fetch;
    expect(await fetchRingInventory(stalled, undefined, undefined, 20)).toBeNull();
  });

  it('treats a failure as unknown rather than "missing", so nothing is rejected on a flaky request', async () => {
    expect(await fetchRingInventory(fakeFetch(500, 'boom'))).toBeNull();
    expect(await fetchRingInventory(fakeFetch(414, ''))).toBeNull();
    const throwing = vi.fn(() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch;
    expect(await fetchRingInventory(throwing)).toBeNull();
  });

  it('treats a listing it cannot parse as unknown, not as an empty ring', async () => {
    // A format change must not read as "every station is gone".
    expect(await fetchRingInventory(fakeFetch(200, 'CI_ADO__HHZ/MSEED\nsomething else\n'))).toBeNull();
  });
});

/** One SeedLink packet: `SL`, a six-character sequence, then a 512-byte record. */
function packet(sequence: number, fill: number): Uint8Array {
  const bytes = new Uint8Array(SEEDLINK_PACKET_BYTES);
  bytes[0] = 0x53;
  bytes[1] = 0x4c;
  const seq = sequence.toString(16).toUpperCase().padStart(6, '0');
  for (let i = 0; i < 6; i += 1) bytes[2 + i] = seq.charCodeAt(i);
  bytes.fill(fill, 8);
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function feed(framer: SeedLinkFramer, stream: Uint8Array, cuts: number[]) {
  const records: Uint8Array[] = [];
  let desync: string | null = null;
  let start = 0;
  for (const cut of [...cuts, stream.length]) {
    const result = framer.push(stream.subarray(start, cut));
    records.push(...result.records);
    desync ??= result.desync;
    start = cut;
  }
  return { records, desync };
}

describe('SeedLinkFramer', () => {
  const two = concat(packet(1, 0x11), packet(2, 0x22));

  // TCP delivers bytes, not packets — every one of these is a real way a
  // stream arrives, and each has broken a framer somewhere.
  it.each([
    { name: 'one byte at a time', cuts: Array.from({ length: two.length - 1 }, (_, i) => i + 1) },
    { name: '519 then the rest', cuts: [519] },
    { name: 'exactly on the packet boundary', cuts: [520] },
    { name: 'inside the SL signature', cuts: [521] },
    { name: 'inside the sequence number', cuts: [525] },
    { name: 'all at once', cuts: [] },
  ])('reassembles two packets split $name', ({ cuts }) => {
    const { records, desync } = feed(new SeedLinkFramer(), two, cuts);
    expect(desync).toBeNull();
    expect(records).toHaveLength(2);
    expect(records[0]?.length).toBe(512);
    expect(records[0]?.every((byte) => byte === 0x11)).toBe(true);
    expect(records[1]?.every((byte) => byte === 0x22)).toBe(true);
  });

  it('returns records that later input cannot mutate', () => {
    const framer = new SeedLinkFramer();
    const source = packet(1, 0x11);
    const [record] = framer.push(source).records;
    source.fill(0x99);
    expect(record?.[0]).toBe(0x11);
  });

  it('keeps the records before a bad signature, then refuses everything after — never rescans for "SL"', () => {
    const framer = new SeedLinkFramer();
    const garbage = packet(2, 0x33);
    garbage[0] = 0x58; // 'X'
    const result = framer.push(concat(packet(1, 0x11), garbage, packet(3, 0x44)));
    expect(result.records).toHaveLength(1);
    expect(result.desync).toMatch(/signature/);
    // Sticky: a perfectly good packet afterwards is still refused.
    const after = framer.push(packet(4, 0x55));
    expect(after.records).toHaveLength(0);
    expect(after.desync).not.toBeNull();
  });
});

class FakeSocket implements SeedLinkSocket {
  writes: string[] = [];
  destroyed = false;
  private connectListeners: (() => void)[] = [];
  private dataListeners: ((chunk: Uint8Array) => void)[] = [];
  private errorListeners: ((error: Error) => void)[] = [];
  private closeListeners: (() => void)[] = [];

  write(text: string): void {
    this.writes.push(text.replace('\r\n', ''));
  }
  destroy(): void {
    this.destroyed = true;
  }
  onConnect(listener: () => void): void {
    this.connectListeners.push(listener);
  }
  onData(listener: (chunk: Uint8Array) => void): void {
    this.dataListeners.push(listener);
  }
  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }
  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  connect(): void {
    for (const listener of this.connectListeners) listener();
  }
  send(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    for (const listener of this.dataListeners) listener(bytes);
  }
  reply(...lines: string[]): void {
    this.send(lines.map((line) => `${line}\r\n`).join(''));
  }
  fail(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
  close(): void {
    for (const listener of this.closeListeners) listener();
  }
}

function startSession(channels: WaveformChannel[]) {
  const socket = new FakeSocket();
  const records: Uint8Array[] = [];
  const rejected: [string, string][] = [];
  const streaming: (readonly string[])[] = [];
  const ended: (Error | null)[] = [];
  const session = createSeedLinkSession({
    channels,
    connect: () => socket,
    onRecord: (record) => records.push(record),
    onChannelRejected: (channelId, reason) => rejected.push([channelId, reason]),
    onStreaming: (ids) => streaming.push(ids),
    onEnd: (error) => ended.push(error),
  });
  return { socket, session, records, rejected, streaming, ended };
}

/** Answers HELLO and CAPABILITIES the way RingServer 4.5.6 does. */
function greet(socket: FakeSocket): void {
  socket.connect();
  socket.reply('SeedLink v4.0 (RingServer/4.5.6) :: SLPROTO:4.0 SLPROTO:3.1 CAP WS:13', 'EarthScope Ring Server');
  socket.reply('OK');
}

describe('createSeedLinkSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never writes a command before the previous reply has fully landed', () => {
    const { socket } = startSession([ADO]);
    expect(socket.writes).toEqual([]);
    socket.connect();
    expect(socket.writes).toEqual(['HELLO']);
    socket.reply('SeedLink v4.0');
    expect(socket.writes).toEqual(['HELLO']); // HELLO answers with two lines
    socket.reply('EarthScope Ring Server');
    expect(socket.writes).toEqual(['HELLO', 'CAPABILITIES SLPROTO:3.1']);
  });

  it('completes the handshake, sends END, and delivers records', () => {
    const { socket, records, streaming, ended } = startSession([ADO]);
    greet(socket);
    socket.reply('OK'); // STATION
    socket.reply('OK'); // SELECT
    socket.reply('OK'); // DATA
    expect(socket.writes).toEqual(['HELLO', 'CAPABILITIES SLPROTO:3.1', 'STATION ADO CI', 'SELECT HHZ', 'DATA', 'END']);
    expect(streaming).toEqual([['CI_ADO__HHZ']]);

    socket.send(packet(1, 0x11));
    expect(records).toHaveLength(1);
    expect(records[0]?.length).toBe(512);
    expect(ended).toEqual([]);
  });

  it('parses replies that arrive split across chunks, or several to a chunk', () => {
    const { socket, streaming } = startSession([ADO]);
    socket.connect();
    socket.send('SeedLink v4.0\r\nEarthScope');
    socket.send(' Ring Server\r');
    socket.send('\nOK\r\n');
    expect(socket.writes.at(-1)).toBe('STATION ADO CI');
    socket.reply('OK');
    socket.reply('OK');
    socket.reply('OK');
    expect(streaming).toHaveLength(1);
  });

  it('hands bytes that arrive behind the final reply to the framer', () => {
    const { socket, records } = startSession([ADO]);
    greet(socket);
    socket.reply('OK');
    socket.reply('OK');
    socket.send(concat(new TextEncoder().encode('OK\r\n'), packet(1, 0x11)));
    expect(records).toHaveLength(1);
  });

  it('rejects a refused station, skips its SELECT and DATA, and carries on with the others', () => {
    const { socket, rejected, streaming } = startSession([BAK, ADO]);
    greet(socket);
    socket.reply('ERROR'); // STATION BAK
    expect(socket.writes.at(-1)).toBe('STATION ADO CI');
    socket.reply('OK');
    socket.reply('OK');
    socket.reply('OK');
    expect(rejected).toEqual([['CI_BAK__HHZ', 'server refused STATION: ERROR']]);
    // Nothing between the two STATION lines: BAK's SELECT and DATA were skipped.
    expect(socket.writes).toEqual([
      'HELLO',
      'CAPABILITIES SLPROTO:3.1',
      'STATION BAK CI',
      'STATION ADO CI',
      'SELECT HHZ',
      'DATA',
      'END',
    ]);
    expect(streaming).toEqual([['CI_ADO__HHZ']]);
  });

  it('does not send DATA for a station whose only selector was refused, which would stream all its channels', () => {
    const { socket, rejected } = startSession([BAK, ADO]);
    greet(socket);
    socket.reply('OK'); // STATION BAK
    socket.reply('ERROR'); // SELECT HHZ for BAK
    expect(socket.writes.at(-1)).toBe('STATION ADO CI');
    expect(rejected.map(([id]) => id)).toEqual(['CI_BAK__HHZ']);
  });

  it('ends with an error when no channel survives the handshake', () => {
    const { socket, ended, streaming } = startSession([ADO]);
    greet(socket);
    socket.reply('ERROR');
    expect(streaming).toEqual([]);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.message).toMatch(/no requested channel was accepted/);
    expect(socket.writes).not.toContain('END');
    expect(socket.destroyed).toBe(true);
  });

  it('ends rather than streaming v4 framing when CAPABILITIES is refused', () => {
    const { socket, ended } = startSession([ADO]);
    socket.connect();
    socket.reply('SeedLink v4.0', 'EarthScope Ring Server');
    socket.reply('ERROR');
    expect(ended[0]?.message).toMatch(/CAPABILITIES/);
    expect(socket.writes.some((line) => line.startsWith('STATION'))).toBe(false);
  });

  it('times out a command that gets no reply', () => {
    const { socket, ended } = startSession([ADO]);
    socket.connect();
    vi.advanceTimersByTime(SEEDLINK_COMMAND_TIMEOUT_MS - 1);
    expect(ended).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ended[0]?.message).toMatch(/no reply to HELLO/);
    expect(socket.destroyed).toBe(true);
  });

  it('times out a connection attempt that never connects', () => {
    const { ended } = startSession([ADO]);
    vi.advanceTimersByTime(SEEDLINK_COMMAND_TIMEOUT_MS);
    expect(ended[0]?.message).toMatch(/connection attempt/);
  });

  it('does not time out a healthy stream: the command timer stops at END', () => {
    const { socket, ended } = startSession([ADO]);
    greet(socket);
    socket.reply('OK', 'OK', 'OK');
    vi.advanceTimersByTime(SEEDLINK_COMMAND_TIMEOUT_MS * 10);
    expect(ended).toEqual([]);
  });

  it('delivers the good records before a desync, then ends with SeedLinkDesyncError', () => {
    const { socket, records, ended } = startSession([ADO]);
    greet(socket);
    socket.reply('OK', 'OK', 'OK');
    const bad = packet(2, 0x22);
    bad[1] = 0x00;
    socket.send(concat(packet(1, 0x11), bad));
    expect(records).toHaveLength(1);
    expect(ended[0]).toBeInstanceOf(SeedLinkDesyncError);
    expect(socket.destroyed).toBe(true);
  });

  it('close() destroys the socket, does not report an end, and silences later input', () => {
    const { socket, session, records, ended } = startSession([ADO]);
    greet(socket);
    socket.reply('OK', 'OK', 'OK');
    session.close();
    expect(socket.destroyed).toBe(true);
    socket.send(packet(1, 0x11));
    socket.close();
    expect(records).toEqual([]);
    expect(ended).toEqual([]);
  });

  it('reports a server close during streaming as a clean end, and during the handshake as an error', () => {
    const streamingCase = startSession([ADO]);
    greet(streamingCase.socket);
    streamingCase.socket.reply('OK', 'OK', 'OK');
    streamingCase.socket.close();
    expect(streamingCase.ended).toEqual([null]);

    const handshakeCase = startSession([ADO]);
    handshakeCase.socket.connect();
    handshakeCase.socket.close();
    expect(handshakeCase.ended[0]?.message).toMatch(/during handshake/);
  });

  it('reports an end exactly once, however many ways the socket dies', () => {
    const { socket, ended } = startSession([ADO]);
    greet(socket);
    socket.fail(new Error('ECONNRESET'));
    socket.close();
    vi.advanceTimersByTime(SEEDLINK_COMMAND_TIMEOUT_MS * 2);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.message).toBe('ECONNRESET');
  });
});
