import { ipcMain } from 'electron';
import {
  LiveQuakeWatch,
  SEEDLINK_SERVERS,
  TEST_ALERT,
  climbTestAlert,
  fetchChannelEpochs,
  testWatchAlert,
  watchNetwork,
  watchReach,
  type FdsnTextRow,
  type SeedLinkConnect,
} from '@terra-pulse/ingest';
import {
  SEEDLINK_SERVER_IDS,
  WATCH_STATUS_OFF,
  parseWatchPin,
  serverOf,
  type SeedLinkServerId,
  type QuakeWatchAlert,
  type QuakeWatchStatus,
  type WatchPin,
  type WaveformChannel,
  type WaveformStationCatalogue,
  type WaveformStreamStatus,
} from '@terra-pulse/schema';
import { createMultiServerController, type SeedLinkEndpoint, type WaveformController } from './waveforms';

/** Every server's endpoint, with its inventory from the shared source. */
export function endpointsFor(
  inventoryFor: (server: SeedLinkServerId) => Promise<Set<string> | null>,
): Record<SeedLinkServerId, SeedLinkEndpoint> {
  const entries = SEEDLINK_SERVER_IDS.map((id): [SeedLinkServerId, SeedLinkEndpoint] => {
    const server = SEEDLINK_SERVERS[id];
    return [id, { label: server.label, host: server.host, port: server.port, fetchInventory: () => inventoryFor(id) }];
  });
  return Object.fromEntries(entries) as Record<SeedLinkServerId, SeedLinkEndpoint>;
}

/**
 * The live watch (§5.13): the stations around one pin, streamed for as long as
 * the app is open, through the detector the replay script graded, with an
 * alert when a quake is predicted to be felt at the pin.
 *
 * ## Lifetime: main's, not the renderer's
 *
 * Unlike the waveform tab — whose stream the renderer starts and a reload
 * stops — this belongs to main. The pin is stored in `app_state`, so a launch
 * with a pin resumes watching on its own, after the window is up and never in
 * front of it (nothing on the startup path waits on the network). A reload,
 * Analyze mode or a closed dock leaves it running; only Stop, which removes the
 * pin, or quitting ends it. That is the user's design: "runs whenever the app
 * is open". A launch with no pin opens nothing.
 *
 * ## Its own connection
 *
 * A second `createWaveformController`, not a share of the tab's: the two want
 * different stations (up to 100 around the pin against 10 rows somewhere
 * else) and different lifetimes. Two connections run side by side on the ring
 * without trouble (measured 2026-10-08), and the stall detection, backoff and
 * inventory handling come along unchanged.
 *
 * ## Arrival time is the wall clock
 *
 * The detector is fed each record with `now()` at the moment it lands — the
 * live counterpart of the replay's record end + measured transit. It is the
 * same `QuakeDetector`, and `LiveQuakeWatch` was checked against the graded
 * loop over all 75 cached replay cases: identical alert instants in every one.
 */

/** Station list or gains unavailable: try again after this long, not on a tight loop. */
export const WATCH_RETRY_MS = 5 * 60_000;
/** Channel epochs either side of now; gains are taken at the instant the watch starts. */
const EPOCH_MARGIN_MS = 24 * 60 * 60_000;
/** The `app_state` key holding the pin. */
export const WATCH_PIN_KEY = 'quake_watch_pin';

export interface QuakeWatchDeps {
  /** The waveform picker's station list — shared, hour-cached, every server merged. */
  catalogue: () => Promise<WaveformStationCatalogue>;
  /** Each server's stream list, shared with the waveform tab. */
  inventoryFor: (server: SeedLinkServerId) => Promise<Set<string> | null>;
  readPin: () => string | null;
  writePin: (value: string | null) => void;
  onStatus: (status: QuakeWatchStatus) => void;
  onAlert: (alert: QuakeWatchAlert) => void;
  onAlertUpdated: (alert: QuakeWatchAlert) => void;
  /** One server's channel epochs, from that server's station service. */
  fetchEpochs?: (
    channels: readonly WaveformChannel[],
    startMs: number,
    endMs: number,
    serviceUrl: string,
  ) => Promise<FdsnTextRow[] | null>;
  connect?: SeedLinkConnect;
  now?: () => number;
}

/**
 * Gains for a network spanning servers: each server's channels from its own
 * station service — EarthScope's knows nothing of GeoNet's sensors. Partial is
 * kept (a station with no gain still detects; it just does not vote on
 * magnitude); null only when every server failed, which is what the retry
 * keys on.
 */
async function fetchGainsByServer(
  network: readonly WaveformChannel[],
  startMs: number,
  endMs: number,
  fetchEpochs: NonNullable<QuakeWatchDeps['fetchEpochs']>,
): Promise<FdsnTextRow[] | null> {
  const groups = new Map<SeedLinkServerId, WaveformChannel[]>();
  for (const channel of network) {
    const id = serverOf(channel);
    groups.set(id, [...(groups.get(id) ?? []), channel]);
  }
  const results = await Promise.all(
    [...groups.entries()].map(([id, channels]) => fetchEpochs(channels, startMs, endMs, SEEDLINK_SERVERS[id].stationServiceUrl)),
  );
  if (results.every((rows) => rows === null)) return null;
  return results.flatMap((rows) => rows ?? []);
}

export interface QuakeWatchController {
  /** Resumes a stored pin, if there is one. Called once, after the window is up. */
  restore(): void;
  /** Drops the pin here, replacing any other. */
  start(pin: WatchPin): QuakeWatchStatus;
  /** Removes the pin and stops. */
  stop(): QuakeWatchStatus;
  status(): QuakeWatchStatus;
  /**
   * Raises a test alert for the pin through the real alert path, then climbs
   * its magnitude once. Throws when there is no pin: a test with no place to
   * name would not look like a real alert.
   */
  testAlert(): QuakeWatchAlert;
  /** The raised-but-not-dismissed alert, for the renderer to ask for on mount. */
  currentAlert(): QuakeWatchAlert | null;
  dismissAlert(): void;
  dispose(): void;
}

export function createQuakeWatchController(deps: QuakeWatchDeps): QuakeWatchController {
  const now = deps.now ?? (() => Date.now());
  const fetchEpochsFor =
    deps.fetchEpochs ??
    ((channels, startMs, endMs, serviceUrl) => fetchChannelEpochs(channels, startMs, endMs, { serviceUrl }));
  const fetchEpochs = (channels: readonly WaveformChannel[], startMs: number, endMs: number) =>
    fetchGainsByServer(channels, startMs, endMs, fetchEpochsFor);

  /** Bumped on every start and stop, so a late catalogue or gain fetch cannot act on a newer pin. */
  let generation = 0;
  let status: QuakeWatchStatus = { ...WATCH_STATUS_OFF };
  let watch: LiveQuakeWatch | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The pending climb of a test alert. Cleared with everything else on stop. */
  let testTimer: ReturnType<typeof setTimeout> | null = null;
  let testCount = 0;
  let current: QuakeWatchAlert | null = null;

  const emit = () => {
    deps.onStatus({ ...status, pin: status.pin === null ? null : { ...status.pin } });
  };
  const set = (patch: Partial<QuakeWatchStatus>) => {
    status = { ...status, ...patch };
    emit();
  };

  const stream: WaveformController = createMultiServerController({
    servers: endpointsFor(deps.inventoryFor),
    ...(deps.connect === undefined ? {} : { connect: deps.connect }),
    now,
    onSegment: (segment) => {
      if (watch === null) return;
      const result = watch.push(segment, now());
      for (const alert of result.raised) {
        current = alert;
        deps.onAlert(alert);
      }
      for (const alert of result.updated) {
        if (current?.id === alert.id) current = alert;
        deps.onAlertUpdated(alert);
      }
      if (result.declared.length > 0) set({ detections: watch.detections });
    },
    onStatus: (s: WaveformStreamStatus) => {
      if (status.state !== 'watching') return;
      const live = s.channels.filter((c) => c.state === 'live').length;
      if (live === status.liveStations && s.connected === status.connected && s.retries === status.retries) return;
      set({ liveStations: live, connected: s.connected, retries: s.retries });
    },
  });

  const clearRetry = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const retryLater = (mine: number, pin: WatchPin) => {
    clearRetry();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (mine === generation) void begin(mine, pin);
    }, WATCH_RETRY_MS);
  };

  async function begin(mine: number, pin: WatchPin): Promise<void> {
    const catalogue = await deps.catalogue();
    if (mine !== generation) return;
    if (catalogue.status !== 'ready') {
      set({ state: 'unavailable', reason: `no station list: ${catalogue.reason}` });
      retryLater(mine, pin);
      return;
    }
    const network = watchNetwork(catalogue.stations, pin);
    const reach = watchReach(network, pin);
    set({ limit: reach.limit, nearestKm: reach.nearestKm, stations: network.length });
    if (network.length === 0) {
      // Not retried: the ring's station list is an hour fresh, and a spot with
      // no station within 300 km will not grow one by waiting.
      set({ state: 'unavailable', reason: 'no public stations within 300 km of this spot' });
      return;
    }

    // No gains means no magnitude, and with no magnitude nothing can alert —
    // so a failed fetch is retried rather than accepted. The stream still
    // starts: the detector detects without gains, and the status says so.
    const at = now();
    const gains = await fetchEpochs(network, at - EPOCH_MARGIN_MS, at + EPOCH_MARGIN_MS);
    if (mine !== generation) return;
    watch = new LiveQuakeWatch({ pin, network, gains, gainAtMs: at, idPrefix: String(at) });
    set({
      state: 'watching',
      reason: gains === null ? 'station gains could not be fetched, so no magnitude yet — retrying' : null,
      magnitudeStations: watch.magnitudeStations,
      detections: 0,
    });
    stream.start(
      network.map(({ network: net, station, location, channel, server }) =>
        server === undefined ? { network: net, station, location, channel } : { network: net, station, location, channel, server },
      ),
    );
    if (gains === null) retryGains(mine, pin, network);
  }

  /** Swaps in a detector with gains once they arrive; the stream itself carries on. */
  const retryGains = (mine: number, pin: WatchPin, network: Parameters<typeof watchNetwork>[0]) => {
    clearRetry();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (mine !== generation) return;
      const at = now();
      void fetchEpochs(network, at - EPOCH_MARGIN_MS, at + EPOCH_MARGIN_MS).then((gains) => {
        if (mine !== generation) return;
        if (gains === null) {
          retryGains(mine, pin, network);
          return;
        }
        // A fresh detector: its pickers warm up for 20 s, which is the price of
        // a magnitude it could not otherwise give at all.
        watch = new LiveQuakeWatch({ pin, network, gains, gainAtMs: at, idPrefix: String(at) });
        set({ reason: null, magnitudeStations: watch.magnitudeStations, detections: 0 });
      });
    }, WATCH_RETRY_MS);
  };

  const clearTest = () => {
    if (testTimer !== null) {
      clearTimeout(testTimer);
      testTimer = null;
    }
  };

  function halt(): void {
    generation += 1;
    clearRetry();
    clearTest();
    stream.stop();
    watch = null;
  }

  function start(pin: WatchPin): QuakeWatchStatus {
    halt();
    const mine = generation;
    deps.writePin(JSON.stringify(pin));
    status = { ...WATCH_STATUS_OFF, pin, state: 'starting' };
    emit();
    begin(mine, pin).catch((error: unknown) => {
      if (mine !== generation) return;
      set({ state: 'unavailable', reason: error instanceof Error ? error.message : String(error) });
      retryLater(mine, pin);
    });
    return status;
  }

  return {
    restore() {
      const raw = deps.readPin();
      if (raw === null) return;
      let pin: WatchPin | null = null;
      try {
        pin = parseWatchPin(JSON.parse(raw));
      } catch {
        pin = null;
      }
      // A stored value that is not a pin is dropped rather than kept failing on
      // every launch.
      if (pin === null) deps.writePin(null);
      else start(pin);
    },
    start,
    stop() {
      halt();
      deps.writePin(null);
      status = { ...WATCH_STATUS_OFF };
      emit();
      return status;
    },
    status: () => status,
    testAlert() {
      const pin = status.pin;
      if (pin === null) throw new Error('no watch pin to test');
      clearTest();
      testCount += 1;
      const alert = testWatchAlert(pin, now(), `test-${String(now())}-${String(testCount)}`);
      current = alert;
      deps.onAlert(alert);
      // Like a real update, it reaches the banner only if this alert is still
      // the one on screen. Dismissed or replaced first, it is dropped there.
      testTimer = setTimeout(() => {
        testTimer = null;
        const climbed = climbTestAlert(alert, TEST_ALERT.climbedMagnitude);
        if (current?.id === alert.id) current = climbed;
        deps.onAlertUpdated(climbed);
      }, TEST_ALERT.climbAfterMs);
      return alert;
    },
    currentAlert: () => current,
    dismissAlert() {
      current = null;
    },
    dispose() {
      halt();
      stream.dispose();
    },
  };
}

/**
 * `quake-watch:*`. Status and alerts are pushed by `main/index.ts` through the
 * controller's callbacks; `current-alert` exists because a push alone loses the
 * alert raised before the renderer subscribed (the large-event lesson, §5.8),
 * and `dismiss-alert` so a dismissed alert does not come back on remount.
 */
export function registerQuakeWatchHandlers(controller: QuakeWatchController): void {
  ipcMain.handle('quake-watch:status', (): QuakeWatchStatus => controller.status());
  ipcMain.handle('quake-watch:start', (_event, raw: unknown): QuakeWatchStatus => {
    const pin = parseWatchPin(raw);
    if (pin === null) throw new Error('bad watch pin');
    return controller.start(pin);
  });
  ipcMain.handle('quake-watch:stop', (): QuakeWatchStatus => controller.stop());
  ipcMain.handle('quake-watch:test-alert', (): QuakeWatchAlert => controller.testAlert());
  ipcMain.handle('quake-watch:current-alert', (): QuakeWatchAlert | null => controller.currentAlert());
  ipcMain.handle('quake-watch:dismiss-alert', (): void => {
    controller.dismissAlert();
  });
}
