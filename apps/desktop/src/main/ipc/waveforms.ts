import { ipcMain, type WebContents } from 'electron';
import {
  createSeedLinkSession,
  fetchRingInventory,
  parseMiniSeedRecord,
  type MiniSeedRecord,
  type SeedLinkConnect,
  type SeedLinkSession,
} from '@terra-pulse/ingest';
import {
  NOT_ON_RING_REASON,
  WAVEFORM_CONNECTION_DEAD_AFTER_MS,
  WAVEFORM_MAX_CHANNELS,
  WAVEFORM_STALL_AFTER_MS,
  channelIdOf,
  isValidWaveformChannel,
  type WaveformChannel,
  type WaveformChannelStatus,
  type WaveformSegment,
  type WaveformStreamStatus,
} from '@terra-pulse/schema';

/**
 * Live seismic waveforms: one SeedLink connection, held open only while the
 * waveform mode is on screen.
 *
 * ## Why this is not modelled on the pollers
 *
 * Every other feed here is a poller that starts at launch and runs forever
 * (`startAuroraPolling`, the magnetometer poll). This is the app's only
 * **persistent outbound connection**, so its lifetime is the *mode's* — the
 * renderer calls `start` when the mode mounts and `stop` when it unmounts,
 * the same shape as `createArchiveController` (start/cancel, never automatic)
 * and `useTec` (fetches only while visible). A launch never opens a socket.
 *
 * ## What main holds, and what it does not
 *
 * Status only — never samples. The renderer is the only consumer, the mode is
 * genuinely unmounted when inactive so its buffer dies with it, and at ~3 KB/s
 * there is no transfer cost to amortise. Each record is decoded here (so the
 * renderer never sees a raw miniSEED byte, non-negotiable #7) and pushed as a
 * `WaveformSegment` straight away.
 */

/** Reconnect delays after consecutive failures, before jitter. */
export const WAVEFORM_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

/** How often stall and dead-connection checks run. */
export const WAVEFORM_WATCHDOG_INTERVAL_MS = 5_000;

/**
 * How long a ring inventory is trusted. Stations join and leave the ring over
 * days, not minutes, and the list is 1.24 MB — refetching it on every region
 * switch would spend that for nothing. A packet from a channel the inventory
 * called absent still wins; see `handleRecord`.
 */
export const WAVEFORM_INVENTORY_TTL_MS = 60 * 60_000;

export class WaveformRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WaveformRequestError';
  }
}

/**
 * Validates a `waveforms:start` payload from the renderer.
 *
 * **Security-relevant, not hygiene.** The channel codes are interpolated into
 * SeedLink command lines, so a station code carrying `\r\n` would inject
 * commands into the session. `isValidWaveformChannel` whitelists the character
 * set; this also enforces the channel cap and rejects duplicates. Same posture
 * as the validated `shell:open-external` handler — the renderer is not trusted
 * to have done this.
 */
export function parseWaveformStartRequest(payload: unknown): WaveformChannel[] {
  if (typeof payload !== 'object' || payload === null || !('channels' in payload)) {
    throw new WaveformRequestError('start request must be an object with a channels array');
  }
  const raw: unknown = payload.channels;
  if (!Array.isArray(raw)) {
    throw new WaveformRequestError('channels must be an array');
  }
  if (raw.length === 0) {
    throw new WaveformRequestError('at least one channel is required');
  }
  if (raw.length > WAVEFORM_MAX_CHANNELS) {
    throw new WaveformRequestError(
      `at most ${String(WAVEFORM_MAX_CHANNELS)} channels may be streamed, got ${String(raw.length)}`,
    );
  }

  const channels: WaveformChannel[] = [];
  const seen = new Set<string>();
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) {
      throw new WaveformRequestError('each channel must be an object');
    }
    const { network, station, location, channel } = item as Record<string, unknown>;
    if (
      typeof network !== 'string' ||
      typeof station !== 'string' ||
      typeof location !== 'string' ||
      typeof channel !== 'string'
    ) {
      throw new WaveformRequestError('each channel needs string network, station, location and channel');
    }
    const candidate: WaveformChannel = { network, station, location, channel };
    if (!isValidWaveformChannel(candidate)) {
      // Deliberately does not echo the codes: they may be exactly the control
      // characters being refused.
      throw new WaveformRequestError('channel codes must be FDSN-shaped upper-case alphanumerics');
    }
    const id = channelIdOf(candidate);
    if (seen.has(id)) {
      throw new WaveformRequestError(`duplicate channel ${id}`);
    }
    seen.add(id);
    channels.push(candidate);
  }
  return channels;
}

export interface WaveformControllerOptions {
  onSegment: (segment: WaveformSegment) => void;
  onStatus: (status: WaveformStreamStatus) => void;
  connect?: SeedLinkConnect;
  fetchInventory?: () => Promise<Set<string> | null>;
  now?: () => number;
  random?: () => number;
}

export interface WaveformController {
  start(channels: readonly WaveformChannel[]): WaveformStreamStatus;
  stop(): void;
  status(): WaveformStreamStatus;
  dispose(): void;
}

export function createWaveformController(options: WaveformControllerOptions): WaveformController {
  const {
    onSegment,
    onStatus,
    connect,
    fetchInventory = () => fetchRingInventory(),
    now = () => Date.now(),
    random = Math.random,
  } = options;

  /**
   * Two generation counters, not a boolean — and not one counter.
   *
   * `startGeneration` changes on every start and stop. A region switch is
   * start→stop→start inside one tick, and a `stopped` flag (which suffices for
   * `startAuroraPolling`) would let the first session's in-flight callbacks —
   * a late inventory, a queued reconnect — act on the second.
   *
   * `connectionGeneration` also changes on every reconnect within one start,
   * so a dying connection's last callbacks cannot touch its replacement. The
   * inventory is keyed to the start, not the connection, because it stays
   * valid across reconnects.
   */
  let startGeneration = 0;
  let connectionGeneration = 0;

  let running = false;
  let requested: WaveformChannel[] = [];
  let statuses = new Map<string, WaveformChannelStatus>();

  let session: SeedLinkSession | null = null;
  let connected = false;
  let connectedSinceMs: number | null = null;
  let streamingSinceMs: number | null = null;
  let lastAnyPacketMs: number | null = null;
  let packetSinceConnect = false;
  let retries = 0;
  let lastError: string | null = null;

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;

  let inventory: { atMs: number; ids: Set<string> } | null = null;
  let parseFailures = 0;

  function snapshot(): WaveformStreamStatus {
    return {
      running,
      connected,
      retries,
      connectedSinceMs,
      lastError,
      channels: [...statuses.values()].map((status) => ({ ...status, channel: { ...status.channel } })),
    };
  }

  function emit(): void {
    onStatus(snapshot());
  }

  function clearTimers(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (watchdogTimer !== null) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function streamable(): WaveformChannel[] {
    return requested.filter((channel) => statuses.get(channelIdOf(channel))?.state !== 'rejected');
  }

  function reject(channelId: string, reason: string): boolean {
    const status = statuses.get(channelId);
    if (status === undefined || status.state === 'rejected') return false;
    status.state = 'rejected';
    status.rejectedReason = reason;
    return true;
  }

  /**
   * Marks channels the ring does not list, and stops if nothing is left.
   *
   * A channel that has already delivered is never rejected, whatever the list
   * says. The inventory arrives *alongside* the stream, so it can land after
   * data has proved a channel present — and a cached list can be up to an hour
   * old. Data is the stronger evidence.
   */
  function applyInventory(ids: Set<string>): void {
    let changed = false;
    for (const channel of requested) {
      const id = channelIdOf(channel);
      if (ids.has(id) || (statuses.get(id)?.records ?? 0) > 0) continue;
      changed = reject(id, NOT_ON_RING_REASON) || changed;
    }
    if (!changed) return;

    if (streamable().length === 0) {
      connectionGeneration += 1;
      session?.close();
      session = null;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connected = false;
      lastError = 'none of the requested channels are on the public ring';
    }
    emit();
  }

  function handleRecord(bytes: Uint8Array): void {
    let record: MiniSeedRecord;
    try {
      record = parseMiniSeedRecord(bytes);
    } catch (error) {
      // Per record, never per connection: one odd channel must not end a
      // session carrying seven healthy ones. An integrity failure here means a
      // decoder bug worth seeing, so the first few are logged in full.
      parseFailures += 1;
      if (parseFailures <= 5 || parseFailures % 100 === 0) {
        console.warn(`Waveform record rejected (${String(parseFailures)} so far)`, error);
      }
      return;
    }
    if (record.kind === 'log') return;

    // A blank-location selector can deliver locations nobody asked for; see
    // SEEDLINK_SELECTOR_NOTE. Anything not requested is dropped here.
    const status = statuses.get(record.channelId);
    if (status === undefined) return;

    const at = now();
    let changed = status.state !== 'live';
    if (!packetSinceConnect) {
      packetSinceConnect = true;
      // The ladder resets only once data has actually arrived. A server that
      // accepts connections and then fails would otherwise reset it on every
      // attempt and be hammered at the one-second rung forever.
      if (retries !== 0) {
        retries = 0;
        changed = true;
      }
    }
    lastAnyPacketMs = at;

    // Data outranks the inventory: a packet from a channel called absent means
    // the cached list was stale, not that the packet is wrong.
    status.state = 'live';
    status.rejectedReason = null;
    status.lastPacketMs = at;
    status.records += 1;

    onSegment({
      channelId: record.channelId,
      startTimeMs: record.startTimeMs,
      sampleRateHz: record.sampleRateHz,
      samples: record.samples,
    });
    if (changed) emit();
  }

  function handleEnd(error: Error | null): void {
    session = null;
    connected = false;
    streamingSinceMs = null;
    lastError = error?.message ?? 'the server closed the connection';
    for (const status of statuses.values()) {
      if (status.state !== 'rejected') status.state = 'connecting';
    }
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    retries += 1;
    const base = WAVEFORM_BACKOFF_MS[Math.min(retries - 1, WAVEFORM_BACKOFF_MS.length - 1)] ?? 30_000;
    // Jitter, so many clients dropped by one server restart do not all come
    // back on the same second.
    const delay = Math.round(base * (0.75 + 0.5 * random()));
    const generation = startGeneration;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (generation !== startGeneration) return;
      openConnection();
    }, delay);
    emit();
  }

  function openConnection(): void {
    const channels = streamable();
    if (channels.length === 0) return;

    connectionGeneration += 1;
    const generation = connectionGeneration;
    packetSinceConnect = false;
    streamingSinceMs = null;

    session = createSeedLinkSession({
      channels,
      ...(connect === undefined ? {} : { connect }),
      onRecord: (bytes) => {
        if (generation !== connectionGeneration) return;
        handleRecord(bytes);
      },
      onChannelRejected: (channelId, reason) => {
        if (generation !== connectionGeneration) return;
        if (reject(channelId, reason)) emit();
      },
      onStreaming: () => {
        if (generation !== connectionGeneration) return;
        connected = true;
        connectedSinceMs ??= now();
        streamingSinceMs = now();
        emit();
      },
      onEnd: (error) => {
        if (generation !== connectionGeneration) return;
        handleEnd(error);
      },
    });
  }

  /**
   * Stall and dead-connection detection.
   *
   * **Silence is unambiguous on this feed**: a seismometer always records
   * something, ocean microseism if nothing else, so a channel that stops
   * delivering has a dead path rather than still ground. That is what makes a
   * plain timeout a sound detector here.
   *
   * A channel that has *never* delivered is measured from when streaming
   * began, which is what catches a channel the ring accepted but does not
   * carry when the inventory could not be fetched.
   */
  function watchdog(): void {
    if (!connected || streamingSinceMs === null) return;
    const at = now();
    let changed = false;

    for (const status of statuses.values()) {
      if (status.state === 'rejected' || status.state === 'stalled') continue;
      const since = Math.max(status.lastPacketMs ?? 0, streamingSinceMs);
      if (at - since > WAVEFORM_STALL_AFTER_MS) {
        status.state = 'stalled';
        changed = true;
      }
    }

    // One silent channel is a station problem; all of them at once is a path
    // problem. A healthy-looking socket that delivers nothing — a NAT mapping
    // dropped without a FIN — is torn down and rebuilt.
    const lastHeard = Math.max(lastAnyPacketMs ?? 0, streamingSinceMs);
    if (at - lastHeard > WAVEFORM_CONNECTION_DEAD_AFTER_MS) {
      connectionGeneration += 1;
      session?.close();
      handleEnd(
        new Error(
          `no data from any channel for ${String(Math.round(WAVEFORM_CONNECTION_DEAD_AFTER_MS / 1000))} s`,
        ),
      );
      return;
    }

    if (changed) emit();
  }

  function stopInternal(): void {
    startGeneration += 1;
    connectionGeneration += 1;
    session?.close();
    session = null;
    clearTimers();
    running = false;
    connected = false;
    streamingSinceMs = null;
  }

  return {
    start(channels) {
      stopInternal();
      const generation = startGeneration;

      running = true;
      requested = [...channels];
      statuses = new Map(
        requested.map((channel) => [
          channelIdOf(channel),
          {
            channelId: channelIdOf(channel),
            channel: { ...channel },
            state: 'connecting',
            rejectedReason: null,
            lastPacketMs: null,
            records: 0,
          },
        ]),
      );
      connectedSinceMs = null;
      lastAnyPacketMs = null;
      retries = 0;
      lastError = null;

      if (inventory !== null && now() - inventory.atMs < WAVEFORM_INVENTORY_TTL_MS) {
        // A cached list is applied before connecting, so absent channels are
        // never even requested. Nothing to emit yet — start emits below.
        for (const channel of requested) {
          const id = channelIdOf(channel);
          if (!inventory.ids.has(id)) reject(id, NOT_ON_RING_REASON);
        }
      } else {
        // Alongside connecting, not before: asking the ring for a station it
        // does not carry costs nothing, so there is no reason to make the reader
        // wait 1.8 s for the list before the first trace can start.
        void fetchInventory().then((ids) => {
          if (ids === null) return;
          inventory = { atMs: now(), ids };
          if (generation !== startGeneration) return;
          applyInventory(ids);
        });
      }

      openConnection();
      if (streamable().length === 0) {
        lastError = 'none of the requested channels are on the public ring';
      }
      watchdogTimer = setInterval(watchdog, WAVEFORM_WATCHDOG_INTERVAL_MS);
      emit();
      return snapshot();
    },

    stop() {
      if (!running) return;
      stopInternal();
      statuses = new Map();
      requested = [];
      emit();
    },

    status: snapshot,

    dispose() {
      stopInternal();
      inventory = null;
    },
  };
}

/**
 * `waveforms:start` / `:stop` / `:status`. Segments and status changes are
 * pushed by `main/index.ts` through the controller's callbacks.
 *
 * **The renderer-reload guard is the one thing here a watchdog cannot cover.**
 * If the renderer reloads — dev HMR, F5 — without its effect cleanup running,
 * `stop` is never called and the connection stays up. The watchdog will not
 * notice, because the connection is *healthy*: it is simply unwatched. So the
 * sender that started the stream is watched for `did-start-loading`, and a
 * reload stops it.
 */
export function registerWaveformIpcHandlers(controller: WaveformController): void {
  let watched: { sender: WebContents; listener: () => void } | null = null;

  const unwatch = () => {
    if (watched !== null && !watched.sender.isDestroyed()) {
      watched.sender.removeListener('did-start-loading', watched.listener);
      watched.sender.removeListener('destroyed', watched.listener);
    }
    watched = null;
  };

  ipcMain.handle('waveforms:start', (event, payload: unknown): WaveformStreamStatus => {
    const channels = parseWaveformStartRequest(payload);
    // One listener pair per stream, not per start — a region switch calls this
    // repeatedly, and stacking `once` listeners would trip Node's leak warning
    // after ten switches.
    unwatch();
    const sender = event.sender;
    const listener = () => {
      unwatch();
      controller.stop();
    };
    sender.once('did-start-loading', listener);
    sender.once('destroyed', listener);
    watched = { sender, listener };
    return controller.start(channels);
  });

  ipcMain.handle('waveforms:stop', (): void => {
    unwatch();
    controller.stop();
  });

  ipcMain.handle('waveforms:status', (): WaveformStreamStatus => controller.status());
}
