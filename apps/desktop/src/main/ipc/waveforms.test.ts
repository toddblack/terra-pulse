import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeedLinkConnect, SeedLinkSocket } from '@terra-pulse/ingest';
import {
  NOT_ON_RING_REASON,
  WAVEFORM_CONNECTION_DEAD_AFTER_MS,
  WAVEFORM_STALL_AFTER_MS,
  type WaveformChannel,
  type WaveformSegment,
  type WaveformStreamStatus,
} from '@terra-pulse/schema';

const ipcHandle = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ ipcMain: { handle: ipcHandle } }));

import {
  WAVEFORM_WATCHDOG_INTERVAL_MS,
  createWaveformController,
  parseWaveformStartRequest,
  registerWaveformIpcHandlers,
  type WaveformController,
} from './waveforms';

const ADO: WaveformChannel = { network: 'CI', station: 'ADO', location: '', channel: 'HHZ' };
const BAK: WaveformChannel = { network: 'CI', station: 'BAK', location: '', channel: 'HHZ' };
const AFI_10: WaveformChannel = { network: 'IU', station: 'AFI', location: '10', channel: 'BHZ' };

class FakeSocket implements SeedLinkSocket {
  writes: string[] = [];
  destroyed = false;
  private listeners = {
    connect: [] as (() => void)[],
    data: [] as ((chunk: Uint8Array) => void)[],
    error: [] as ((error: Error) => void)[],
    close: [] as (() => void)[],
  };
  write(text: string): void {
    this.writes.push(text.replace('\r\n', ''));
  }
  destroy(): void {
    this.destroyed = true;
  }
  onConnect(listener: () => void): void {
    this.listeners.connect.push(listener);
  }
  onData(listener: (chunk: Uint8Array) => void): void {
    this.listeners.data.push(listener);
  }
  onError(listener: (error: Error) => void): void {
    this.listeners.error.push(listener);
  }
  onClose(listener: () => void): void {
    this.listeners.close.push(listener);
  }
  connect(): void {
    for (const listener of this.listeners.connect) listener();
  }
  send(bytes: Uint8Array): void {
    for (const listener of this.listeners.data) listener(bytes);
  }
  reply(...lines: string[]): void {
    this.send(new TextEncoder().encode(lines.map((line) => `${line}\r\n`).join('')));
  }
  fail(message: string): void {
    for (const listener of this.listeners.error) listener(new Error(message));
  }
}

function fakeTransport() {
  const sockets: FakeSocket[] = [];
  const connect: SeedLinkConnect = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  return { sockets, connect };
}

/** Answers every handshake line with OK, the way the ring does. */
function handshake(socket: FakeSocket): void {
  socket.connect();
  socket.reply('SeedLink v4.0 (RingServer/4.5.6)', 'EarthScope Ring Server');
  for (let guard = 0; !socket.writes.includes('END'); guard += 1) {
    if (guard > 50) throw new Error('handshake did not finish');
    socket.reply('OK');
  }
}

/** A 512-byte big-endian INT32 miniSEED record, wrapped in a SeedLink packet. */
function packetFor(channel: WaveformChannel, startMs: number, samples: number[] = [1, 2, 3]): Uint8Array {
  const packet = new Uint8Array(520);
  packet.set([0x53, 0x4c], 0);
  packet.set(new TextEncoder().encode('000001'), 2);
  const record = packet.subarray(8);
  const view = new DataView(record.buffer, record.byteOffset, 512);
  const text = (at: number, width: number, value: string) => {
    for (let i = 0; i < width; i += 1) record[at + i] = value.charCodeAt(i) || 0x20;
  };
  text(0, 6, '000001');
  record[6] = 'D'.charCodeAt(0);
  text(8, 5, channel.station);
  text(13, 2, channel.location);
  text(15, 3, channel.channel);
  text(18, 2, channel.network);

  const date = new Date(startMs);
  const dayOfYear = Math.floor((startMs - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
  view.setUint16(20, date.getUTCFullYear());
  view.setUint16(22, dayOfYear);
  view.setUint8(24, date.getUTCHours());
  view.setUint8(25, date.getUTCMinutes());
  view.setUint8(26, date.getUTCSeconds());
  view.setUint16(28, date.getUTCMilliseconds() * 10);
  view.setUint16(30, samples.length);
  view.setInt16(32, 100);
  view.setInt16(34, 1);
  view.setUint8(39, 1);
  view.setUint16(44, 64);
  view.setUint16(46, 48);
  view.setUint16(48, 1000);
  view.setUint16(50, 0);
  view.setUint8(52, 3); // INT32
  view.setUint8(53, 1); // big-endian
  view.setUint8(54, 9); // 512 bytes
  samples.forEach((sample, i) => {
    view.setInt32(64 + i * 4, sample);
  });
  return packet;
}

interface Harness {
  controller: WaveformController;
  sockets: FakeSocket[];
  segments: WaveformSegment[];
  statuses: WaveformStreamStatus[];
  /** Resolves every inventory request still pending. */
  resolveInventory: (ids: Set<string> | null) => void;
  /** Resolves only the `index`th inventory request ever made. */
  resolveInventoryAt: (index: number, ids: Set<string> | null) => void;
  inventoryCalls: () => number;
}

function harness(): Harness {
  const { sockets, connect } = fakeTransport();
  const segments: WaveformSegment[] = [];
  const statuses: WaveformStreamStatus[] = [];
  const resolvers: (((ids: Set<string> | null) => void) | null)[] = [];
  const controller = createWaveformController({
    onSegment: (segment) => segments.push(segment),
    onStatus: (status) => statuses.push(status),
    connect,
    fetchInventory: () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      }),
    random: () => 0.5, // jitter factor exactly 1
  });
  const resolveAt = (index: number, ids: Set<string> | null) => {
    resolvers[index]?.(ids);
    resolvers[index] = null;
  };
  return {
    controller,
    sockets,
    segments,
    statuses,
    resolveInventory: (ids) => {
      resolvers.forEach((_, index) => {
        resolveAt(index, ids);
      });
    },
    resolveInventoryAt: resolveAt,
    inventoryCalls: () => resolvers.length,
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('parseWaveformStartRequest', () => {
  it('accepts a valid request', () => {
    expect(parseWaveformStartRequest({ channels: [ADO, AFI_10] })).toEqual([ADO, AFI_10]);
  });

  it('refuses a station code carrying CRLF, which would inject SeedLink commands', () => {
    const attack = { ...ADO, station: 'AB\r\nBYE' };
    expect(() => parseWaveformStartRequest({ channels: [attack] })).toThrow(/FDSN-shaped/);
  });

  it('does not echo refused codes back in the error', () => {
    const attack = { ...ADO, station: 'AB\r\nBYE' };
    expect(() => parseWaveformStartRequest({ channels: [attack] })).not.toThrow(/BYE/);
  });

  it('enforces the channel cap', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...ADO, station: `S${String(i)}` }));
    expect(() => parseWaveformStartRequest({ channels: nine })).toThrow(/at most 8/);
  });

  it('rejects duplicates, lower case, missing fields, and non-arrays', () => {
    expect(() => parseWaveformStartRequest({ channels: [ADO, ADO] })).toThrow(/duplicate/);
    expect(() => parseWaveformStartRequest({ channels: [{ ...ADO, station: 'ado' }] })).toThrow();
    expect(() => parseWaveformStartRequest({ channels: [{ network: 'CI' }] })).toThrow();
    expect(() => parseWaveformStartRequest({ channels: 'CI_ADO' })).toThrow();
    expect(() => parseWaveformStartRequest({ channels: [] })).toThrow();
    expect(() => parseWaveformStartRequest(null)).toThrow();
  });
});

describe('createWaveformController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 10, 6, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('streams: handshake, then a record becomes a segment and the channel goes live', () => {
    const h = harness();
    h.controller.start([ADO]);
    const socket = h.sockets[0];
    if (socket === undefined) throw new Error('no socket');
    handshake(socket);

    socket.send(packetFor(ADO, Date.now() - 5_000, [10, 20, 30]));
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0]?.channelId).toBe('CI_ADO__HHZ');
    expect(Array.from(h.segments[0]?.samples ?? [])).toEqual([10, 20, 30]);
    expect(h.segments[0]?.samples).toBeInstanceOf(Int32Array);
    expect(h.controller.status().connected).toBe(true);
    expect(h.controller.status().channels[0]?.state).toBe('live');
  });

  it('stop() destroys the socket, and a late packet produces nothing', () => {
    const h = harness();
    h.controller.start([ADO]);
    const socket = h.sockets[0];
    if (socket === undefined) throw new Error('no socket');
    handshake(socket);
    h.controller.stop();

    expect(socket.destroyed).toBe(true);
    socket.send(packetFor(ADO, Date.now()));
    expect(h.segments).toEqual([]);
    expect(h.controller.status().running).toBe(false);
  });

  it('start→stop→start in one tick cannot cross sessions', async () => {
    const h = harness();
    h.controller.start([ADO]);
    h.controller.stop();
    h.controller.start([BAK]);
    const [first, second] = h.sockets;
    if (first === undefined || second === undefined) throw new Error('no sockets');

    // The first start's inventory, resolving late, says BAK is absent. It
    // belongs to a start that no longer exists and must not act on this one.
    h.resolveInventoryAt(0, new Set(['CI_ADO__HHZ']));
    await flush();
    expect(h.controller.status().channels.map((c) => c.state)).toEqual(['connecting']);

    // The first session's socket is destroyed; anything it still says is ignored.
    expect(first.destroyed).toBe(true);
    handshake(second);
    first.send(packetFor(ADO, Date.now()));
    second.send(packetFor(BAK, Date.now()));
    expect(h.segments.map((segment) => segment.channelId)).toEqual(['CI_BAK__HHZ']);
  });

  it('never rejects a channel that has already delivered, even if the inventory omits it', async () => {
    const h = harness();
    h.controller.start([ADO, BAK]);
    const socket = h.sockets[0];
    if (socket === undefined) throw new Error('no socket');
    handshake(socket);
    socket.send(packetFor(BAK, Date.now()));

    // The list lands after the data, omitting BAK. Data is the stronger evidence.
    h.resolveInventory(new Set(['CI_ADO__HHZ']));
    await flush();
    expect(h.controller.status().channels.find((c) => c.channelId === 'CI_BAK__HHZ')?.state).toBe('live');
  });

  it('backs off 1, 2, 4 s between failed attempts', async () => {
    const h = harness();
    h.controller.start([ADO]);
    h.sockets[0]?.fail('ECONNREFUSED');
    expect(h.controller.status().retries).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(2);

    h.sockets[1]?.fail('ECONNREFUSED');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(3);

    h.sockets[2]?.fail('ECONNREFUSED');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.sockets).toHaveLength(4);
  });

  it('resets the ladder only after a packet arrives, not after a successful connect', async () => {
    const h = harness();
    h.controller.start([ADO]);
    h.sockets[0]?.fail('reset');
    await vi.advanceTimersByTimeAsync(1_000);

    // Connects and completes a handshake — but no data — then dies again.
    const second = h.sockets[1];
    if (second === undefined) throw new Error('no socket');
    handshake(second);
    second.fail('reset');
    expect(h.controller.status().retries).toBe(2); // not reset by the handshake
    await vi.advanceTimersByTimeAsync(2_000);

    const third = h.sockets[2];
    if (third === undefined) throw new Error('no socket');
    handshake(third);
    third.send(packetFor(ADO, Date.now()));
    expect(h.controller.status().retries).toBe(0);

    third.fail('reset');
    await vi.advanceTimersByTimeAsync(1_000); // back on the first rung
    expect(h.sockets).toHaveLength(4);
  });

  it('marks channels the ring does not list as rejected, and keeps streaming the rest', async () => {
    const h = harness();
    h.controller.start([ADO, BAK]);
    h.resolveInventory(new Set(['CI_ADO__HHZ']));
    await flush();
    const states = h.controller.status().channels;
    expect(states.find((c) => c.channelId === 'CI_BAK__HHZ')).toMatchObject({
      state: 'rejected',
      rejectedReason: NOT_ON_RING_REASON,
    });
    expect(states.find((c) => c.channelId === 'CI_ADO__HHZ')?.state).toBe('connecting');
    expect(h.sockets[0]?.destroyed).toBe(false);
  });

  it('closes and does not reconnect when nothing requested is on the ring', async () => {
    const h = harness();
    h.controller.start([ADO]);
    h.resolveInventory(new Set(['CI_BAK__HHZ']));
    await flush();
    expect(h.sockets[0]?.destroyed).toBe(true);
    expect(h.controller.status().lastError).toMatch(/none of the requested channels/);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(1);
  });

  it('rejects nothing when the inventory is unknown', async () => {
    const h = harness();
    h.controller.start([ADO, BAK]);
    h.resolveInventory(null);
    await flush();
    expect(h.controller.status().channels.every((c) => c.state === 'connecting')).toBe(true);
  });

  it('reuses a fresh inventory and never requests a channel it lists as absent', async () => {
    const h = harness();
    h.controller.start([ADO]);
    h.resolveInventory(new Set(['CI_ADO__HHZ']));
    await flush();
    h.controller.start([ADO, BAK]);

    expect(h.inventoryCalls()).toBe(1);
    const socket = h.sockets.at(-1);
    if (socket === undefined) throw new Error('no socket');
    handshake(socket);
    expect(socket.writes).toContain('STATION ADO CI');
    expect(socket.writes).not.toContain('STATION BAK CI');
  });

  it('lets a packet outrank a stale inventory', async () => {
    const h = harness();
    h.controller.start([ADO, BAK]);
    const socket = h.sockets[0];
    if (socket === undefined) throw new Error('no socket');
    handshake(socket);
    h.resolveInventory(new Set(['CI_ADO__HHZ'])); // claims BAK is absent
    await flush();
    expect(h.controller.status().channels.find((c) => c.channelId === 'CI_BAK__HHZ')?.state).toBe('rejected');
    socket.send(packetFor(BAK, Date.now()));
    expect(h.controller.status().channels.find((c) => c.channelId === 'CI_BAK__HHZ')).toMatchObject({
      state: 'live',
      rejectedReason: null,
    });
  });

  it('drops records for channels nobody requested', () => {
    const h = harness();
    h.controller.start([AFI_10]);
    const socket = h.sockets[0];
    if (socket === undefined) throw new Error('no socket');
    handshake(socket);
    socket.send(packetFor({ ...AFI_10, location: '00' }, Date.now()));
    socket.send(packetFor(AFI_10, Date.now()));
    expect(h.segments.map((s) => s.channelId)).toEqual(['IU_AFI_10_BHZ']);
  });

  it('survives an undecodable record: one bad record does not end the session', () => {
    const h = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.controller.start([ADO]);
    const socket = h.sockets[0];
    if (socket === undefined) throw new Error('no socket');
    handshake(socket);

    const bad = packetFor(ADO, Date.now());
    bad[8 + 52] = 99; // unsupported encoding
    socket.send(bad);
    socket.send(packetFor(ADO, Date.now()));
    expect(h.segments).toHaveLength(1);
    expect(socket.destroyed).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('marks a silent channel stalled, then rebuilds a connection that has gone quiet entirely', async () => {
    const h = harness();
    h.controller.start([ADO, BAK]);
    const socket = h.sockets[0];
    if (socket === undefined) throw new Error('no socket');
    handshake(socket);
    socket.send(packetFor(ADO, Date.now()));

    // BAK never delivers; ADO keeps going.
    for (let t = 0; t < WAVEFORM_STALL_AFTER_MS + WAVEFORM_WATCHDOG_INTERVAL_MS; t += 10_000) {
      await vi.advanceTimersByTimeAsync(10_000);
      socket.send(packetFor(ADO, Date.now()));
    }
    const states = Object.fromEntries(h.controller.status().channels.map((c) => [c.channelId, c.state]));
    expect(states).toEqual({ CI_ADO__HHZ: 'live', CI_BAK__HHZ: 'stalled' });
    expect(socket.destroyed).toBe(false);

    // Now nothing at all.
    await vi.advanceTimersByTimeAsync(WAVEFORM_CONNECTION_DEAD_AFTER_MS + WAVEFORM_WATCHDOG_INTERVAL_MS);
    expect(socket.destroyed).toBe(true);
    expect(h.controller.status().lastError).toMatch(/no data from any channel/);

    // Rebuilt on the first rung of the ladder, since packets had been arriving.
    expect(h.controller.status().retries).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets).toHaveLength(2);
  });
});

describe('registerWaveformIpcHandlers', () => {
  function registered() {
    ipcHandle.mockClear();
    const controller = {
      start: vi.fn(() => ({ running: true }) as unknown as WaveformStreamStatus),
      stop: vi.fn(),
      status: vi.fn(),
      dispose: vi.fn(),
    };
    registerWaveformIpcHandlers(controller);
    const handlers = new Map<string, (...args: unknown[]) => unknown>(
      ipcHandle.mock.calls.map(([channel, handler]) => [
        channel as string,
        handler as (...args: unknown[]) => unknown,
      ]),
    );
    const listeners = new Map<string, () => void>();
    const sender = {
      once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
      removeListener: vi.fn((event: string) => listeners.delete(event)),
      isDestroyed: () => false,
    };
    return { controller, handlers, sender, listeners };
  }

  it('stops the stream when the renderer that started it reloads', () => {
    const { controller, handlers, sender, listeners } = registered();
    handlers.get('waveforms:start')?.({ sender }, { channels: [ADO] });
    expect(controller.start).toHaveBeenCalledWith([ADO]);

    listeners.get('did-start-loading')?.();
    expect(controller.stop).toHaveBeenCalled();
  });

  it('does not stack listeners across repeated starts', () => {
    const { handlers, sender, listeners } = registered();
    for (let i = 0; i < 12; i += 1) {
      handlers.get('waveforms:start')?.({ sender }, { channels: [ADO] });
    }
    expect(listeners.size).toBe(2); // did-start-loading + destroyed, once each
    expect(sender.removeListener).toHaveBeenCalled();
  });

  it('validates in main and never reaches the controller with a bad request', () => {
    const { controller, handlers, sender } = registered();
    expect(() =>
      handlers.get('waveforms:start')?.({ sender }, { channels: [{ ...ADO, station: 'A\r\nB' }] }),
    ).toThrow();
    expect(controller.start).not.toHaveBeenCalled();
  });
});
