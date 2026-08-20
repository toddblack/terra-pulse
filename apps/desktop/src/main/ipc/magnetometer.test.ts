import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MagnetometerReading, MagnetometerStation } from '@terra-pulse/schema';

const ipcHandle = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ ipcMain: { handle: ipcHandle } }));

const fetchMagnetometerStations = vi.hoisted(() => vi.fn());
const fetchStationDisturbance = vi.hoisted(() => vi.fn());
vi.mock('@terra-pulse/ingest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@terra-pulse/ingest')>();
  return { ...actual, fetchMagnetometerStations, fetchStationDisturbance };
});

const INTERVAL_MS = 1000;

function station(code: string): MagnetometerStation {
  return { code, name: `${code} observatory`, latitude: 40, longitude: -105, agency: 'USGS' };
}

/** Fresh module per case — `latest` lives at module scope, not in a closure. */
async function loadModule(): Promise<typeof import('./magnetometer')> {
  vi.resetModules();
  ipcHandle.mockClear();
  return import('./magnetometer');
}

function latestHandler(): () => MagnetometerReading[] {
  const call = ipcHandle.mock.calls.find(([channel]) => channel === 'magnetometer:latest');
  if (!call) throw new Error('no handler registered for magnetometer:latest');
  return call[1] as () => MagnetometerReading[];
}

beforeEach(() => {
  fetchMagnetometerStations.mockReset();
  fetchStationDisturbance.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('magnetometer polling', () => {
  it('polls once immediately rather than waiting out the first interval', async () => {
    // The layer would otherwise be blank for five minutes after launch.
    fetchMagnetometerStations.mockResolvedValue([station('BOU')]);
    fetchStationDisturbance.mockResolvedValue({
      code: 'BOU',
      rangeNt: 12,
      samples: 60,
      observedAtUtc: '2026-08-20T00:00:00.000Z',
    });

    const mod = await loadModule();
    const readings: MagnetometerReading[][] = [];
    const stop = mod.startMagnetometerPolling((r) => readings.push(r), INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMagnetometerStations).toHaveBeenCalledTimes(1);
    expect(readings).toHaveLength(1);
    expect(readings[0]?.[0]?.disturbance?.rangeNt).toBe(12);

    stop();
  });

  it('lets one station fail without costing the others their refresh', async () => {
    // Measured: only about 13 of 31 stations report in any given hour, and
    // observatories drop out for maintenance constantly. `Promise.all` over
    // un-caught rejections would lose the whole network to one bad station.
    fetchMagnetometerStations.mockResolvedValue([
      station('BOU'),
      station('KAK'),
      station('FRN'),
    ]);
    fetchStationDisturbance.mockImplementation((code: string) => {
      if (code === 'KAK') return Promise.reject(new Error('observatory offline'));
      return Promise.resolve({
        code,
        rangeNt: 5,
        samples: 60,
        observedAtUtc: '2026-08-20T00:00:00.000Z',
      });
    });

    const mod = await loadModule();
    const readings: MagnetometerReading[][] = [];
    const stop = mod.startMagnetometerPolling((r) => readings.push(r), INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(0);

    const batch = readings[0] ?? [];
    expect(batch).toHaveLength(3);
    expect(batch.map((r) => r.station.code)).toEqual(['BOU', 'KAK', 'FRN']);

    // The failed station is reported as "no reading", never as quiet — a
    // station offline during a storm is exactly the one a reader must not
    // mistake for calm.
    const kak = batch.find((r) => r.station.code === 'KAK');
    expect(kak?.disturbance).toBeNull();
    expect(batch.find((r) => r.station.code === 'BOU')?.disturbance?.rangeNt).toBe(5);

    stop();
  });

  it('does not start a second poll on top of one still running', async () => {
    // A poll could not outlast a five-minute interval; it can easily outlast
    // sixty seconds. Without the guard a slow run lets the next pile up on the
    // same network and the same alerter.
    fetchMagnetometerStations.mockReturnValue(new Promise(() => {}));

    const mod = await loadModule();
    const stop = mod.startMagnetometerPolling(() => {}, INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 4);

    expect(fetchMagnetometerStations).toHaveBeenCalledTimes(1);

    stop();
  });

  it('does not publish a reply that arrives after stopping', async () => {
    let resolveStations!: (value: MagnetometerStation[]) => void;
    fetchMagnetometerStations.mockReturnValue(
      new Promise<MagnetometerStation[]>((resolve) => {
        resolveStations = resolve;
      }),
    );
    fetchStationDisturbance.mockResolvedValue(null);

    const mod = await loadModule();
    const readings: MagnetometerReading[][] = [];
    const stop = mod.startMagnetometerPolling((r) => readings.push(r), INTERVAL_MS);

    stop();
    resolveStations([station('BOU')]);
    await vi.advanceTimersByTimeAsync(0);

    expect(readings).toHaveLength(0);
  });

  it('keeps the previous readings when the station list itself fails', async () => {
    // A blip must not empty a layer that was fine a moment ago.
    fetchMagnetometerStations
      .mockResolvedValueOnce([station('BOU')])
      .mockRejectedValueOnce(new Error('service unreachable'));
    fetchStationDisturbance.mockResolvedValue({
      code: 'BOU',
      rangeNt: 9,
      samples: 60,
      observedAtUtc: '2026-08-20T00:00:00.000Z',
    });

    const mod = await loadModule();
    mod.registerMagnetometerIpcHandlers();
    const latest = latestHandler();
    const stop = mod.startMagnetometerPolling(() => {}, INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(0);
    expect(latest()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(fetchMagnetometerStations).toHaveBeenCalledTimes(2);
    expect(latest()[0]?.disturbance?.rangeNt).toBe(9);

    stop();
  });
});

describe('magnetometer:latest', () => {
  it('answers with an empty network before the first poll lands', async () => {
    // Pulled rather than pushed for the first read, so the renderer asking
    // early gets an honest empty answer rather than undefined.
    const mod = await loadModule();
    mod.registerMagnetometerIpcHandlers();

    expect(latestHandler()()).toEqual([]);
  });
});
