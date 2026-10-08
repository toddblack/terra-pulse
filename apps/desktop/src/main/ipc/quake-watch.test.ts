import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeedLinkConnect, SeedLinkSocket } from '@terra-pulse/ingest';
import type { QuakeWatchStatus, WaveformStation, WaveformStationCatalogue, WatchPin } from '@terra-pulse/schema';

const ipcHandle = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ ipcMain: { handle: ipcHandle } }));

import {
  WATCH_PIN_KEY,
  WATCH_RETRY_MS,
  createQuakeWatchController,
  registerQuakeWatchHandlers,
  type QuakeWatchDeps,
} from './quake-watch';

const PIN: WatchPin = { latitude: 34.1808, longitude: -118.309, label: 'Burbank' };

function station(code: string, dLat: number, dLon: number): WaveformStation {
  return {
    network: 'CI',
    station: code,
    location: '',
    channel: 'HHZ',
    latitude: PIN.latitude + dLat,
    longitude: PIN.longitude + dLon,
    site: code,
    sampleRateHz: 100,
  };
}

/** Five stations near Burbank, and one in Japan the watch must not take. */
const STATIONS = [
  station('AAA', 0.1, 0),
  station('BBB', 0.5, 0.5),
  station('CCC', -0.5, 0.5),
  station('DDD', 0.5, -0.5),
  station('EEE', -1, -1),
  { ...station('JPN', 0, 0), latitude: 35.7, longitude: 139.7 },
];

class FakeSocket implements SeedLinkSocket {
  writes: string[] = [];
  destroyed = false;
  write(text: string): void {
    this.writes.push(...text.split('\r\n').filter((line) => line !== ''));
  }
  destroy(): void {
    this.destroyed = true;
  }
  onConnect(): void {}
  onData(): void {}
  onError(): void {}
  onClose(): void {}
}

function setup(overrides: Partial<QuakeWatchDeps> = {}) {
  const sockets: FakeSocket[] = [];
  const connect: SeedLinkConnect = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  const stored = new Map<string, string>();
  const statuses: QuakeWatchStatus[] = [];
  const deps: QuakeWatchDeps = {
    catalogue: () => Promise.resolve<WaveformStationCatalogue>({ status: 'ready', stations: STATIONS, fetchedAtMs: 0 }),
    fetchInventory: () => Promise.resolve(null),
    readPin: () => stored.get(WATCH_PIN_KEY) ?? null,
    writePin: (value) => {
      if (value === null) stored.delete(WATCH_PIN_KEY);
      else stored.set(WATCH_PIN_KEY, value);
    },
    onStatus: (s) => statuses.push(s),
    onAlert: vi.fn(),
    onAlertUpdated: vi.fn(),
    fetchEpochs: () => Promise.resolve([]),
    connect,
    ...overrides,
  };
  const controller = createQuakeWatchController(deps);
  return { controller, sockets, stored, statuses };
}

/** Lets the controller's awaited fetches resolve. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('quake watch controller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens nothing on a launch with no pin', async () => {
    const { controller, sockets, statuses } = setup();
    controller.restore();
    await settle();
    expect(sockets).toEqual([]);
    expect(statuses).toEqual([]);
    expect(controller.status().state).toBe('off');
  });

  it('stores the pin and streams the stations around it, not the one in Japan', async () => {
    const { controller, sockets, stored } = setup();
    expect(controller.start(PIN).state).toBe('starting');
    expect(JSON.parse(stored.get(WATCH_PIN_KEY) ?? 'null')).toEqual(PIN);
    await settle();
    const status = controller.status();
    expect(status.state).toBe('watching');
    expect(status.stations).toBe(5);
    expect(status.limit).toBeNull();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.destroyed).toBe(false);
    controller.dispose();
  });

  it('resumes a stored pin on launch, and drops a stored value that is not a pin', async () => {
    const resumed = setup();
    resumed.stored.set(WATCH_PIN_KEY, JSON.stringify(PIN));
    resumed.controller.restore();
    await settle();
    expect(resumed.controller.status().pin).toEqual(PIN);
    expect(resumed.controller.status().state).toBe('watching');
    resumed.controller.dispose();

    const junk = setup();
    junk.stored.set(WATCH_PIN_KEY, '{"latitude": 400}');
    junk.controller.restore();
    expect(junk.stored.has(WATCH_PIN_KEY)).toBe(false);
    expect(junk.controller.status().state).toBe('off');
  });

  it('Stop removes the pin and closes the connection', async () => {
    const { controller, sockets, stored } = setup();
    controller.start(PIN);
    await settle();
    expect(controller.stop().state).toBe('off');
    expect(stored.has(WATCH_PIN_KEY)).toBe(false);
    expect(sockets[0]?.destroyed).toBe(true);
    expect(controller.status().pin).toBeNull();
  });

  it('says a spot with no station near it cannot be watched, and opens nothing', async () => {
    const { controller, sockets } = setup();
    controller.start({ latitude: -60, longitude: -120, label: 'Southern Ocean' });
    await settle();
    expect(controller.status().state).toBe('unavailable');
    expect(controller.status().reason).toMatch(/no public stations/);
    expect(sockets).toEqual([]);
  });

  it('marks a pin too far from any station as such, but still watches', async () => {
    const { controller } = setup();
    // ~100 km south of the cluster: four stations in range, none within 50 km.
    controller.start({ latitude: PIN.latitude - 1.4, longitude: PIN.longitude, label: 'offshore' });
    await settle();
    expect(controller.status().state).toBe('watching');
    expect(controller.status().limit).toBe('too-far');
    controller.dispose();
  });

  it('retries a missing station list later rather than giving up', async () => {
    let ready = false;
    const { controller, sockets } = setup({
      catalogue: () =>
        Promise.resolve<WaveformStationCatalogue>(
          ready ? { status: 'ready', stations: STATIONS, fetchedAtMs: 0 } : { status: 'unavailable', reason: 'offline' },
        ),
    });
    controller.start(PIN);
    await settle();
    expect(controller.status().state).toBe('unavailable');
    expect(sockets).toEqual([]);
    ready = true;
    await vi.advanceTimersByTimeAsync(WATCH_RETRY_MS);
    expect(controller.status().state).toBe('watching');
    expect(sockets).toHaveLength(1);
    controller.dispose();
  });

  it('streams without gains but says so, and retries them', async () => {
    let calls = 0;
    const { controller } = setup({
      fetchEpochs: () => {
        calls += 1;
        return Promise.resolve(calls === 1 ? null : []);
      },
    });
    controller.start(PIN);
    await settle();
    expect(controller.status().state).toBe('watching');
    expect(controller.status().reason).toMatch(/gains/);
    await vi.advanceTimersByTimeAsync(WATCH_RETRY_MS);
    expect(calls).toBe(2);
    expect(controller.status().reason).toBeNull();
    controller.dispose();
  });

  it('a new pin supersedes one still loading: the old catalogue reply changes nothing', async () => {
    let release: (c: WaveformStationCatalogue) => void = () => undefined;
    let first = true;
    const { controller, sockets } = setup({
      catalogue: () => {
        if (!first) return Promise.resolve<WaveformStationCatalogue>({ status: 'ready', stations: STATIONS, fetchedAtMs: 0 });
        first = false;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    controller.start({ latitude: 0, longitude: 0, label: 'old' });
    controller.start(PIN);
    await settle();
    release({ status: 'unavailable', reason: 'late' });
    await settle();
    expect(controller.status().pin).toEqual(PIN);
    expect(controller.status().state).toBe('watching');
    expect(sockets).toHaveLength(1);
    controller.dispose();
  });
});

describe('quake-watch IPC', () => {
  it('refuses a pin that is not one', () => {
    ipcHandle.mockClear();
    const { controller } = setup();
    registerQuakeWatchHandlers(controller);
    const start = ipcHandle.mock.calls.find(([channel]) => channel === 'quake-watch:start')?.[1] as (
      event: unknown,
      raw: unknown,
    ) => unknown;
    expect(() => start({}, { latitude: 'north', longitude: 0, label: 'x' })).toThrow(/bad watch pin/);
    expect(controller.status().state).toBe('off');
  });
});
