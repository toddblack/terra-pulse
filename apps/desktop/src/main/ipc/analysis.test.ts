import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openDatabase,
  insertEarthquakes,
  insertCmeArrivals,
  insertSolarFlares,
  recordGoesFlareChunk,
} from '@terra-pulse/db';
import { goesFlareYears } from '@terra-pulse/ingest';
import type { DatabaseSync } from 'node:sqlite';
import { CONTRACT_VERSION } from '@terra-pulse/schema';
import type { CmeArrival, EarthquakeEvent, FlareClass, SolarFlare } from '@terra-pulse/schema';
import { createEngineController, registerAnalysisIpcHandlers, resolvePythonInterpreter } from './analysis';

const ipcHandle = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ ipcMain: { handle: ipcHandle } }));

/** A GOES-shaped flare fixture, matching the ids that adapter synthesises. */
function goesFlare(id: string, peakTimeUtc: string, flareClass: FlareClass, magnitude: number): SolarFlare {
  return {
    id,
    source: 'goes',
    classType: `${flareClass}${String(magnitude)}`,
    flareClass,
    magnitude,
    peakTimeUtc,
    beginTimeUtc: null,
    endTimeUtc: null,
    sourceLocation: null,
    activeRegionNumber: null,
    link: null,
  };
}

function handlerFor(channel: string): (event: unknown, request?: unknown) => unknown {
  const call = ipcHandle.mock.calls.find(([registered]) => registered === channel);
  if (!call) throw new Error(`no handler registered for ${channel}`);
  return call[1] as (event: unknown, request?: unknown) => unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function healthBody(contractVersion = CONTRACT_VERSION): unknown {
  return { status: 'ok', engineVersion: '0.1.0', contractVersion, python: '3.12.3' };
}

interface FakeChild extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  stderr: EventEmitter;
  stdout: EventEmitter;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

const FAST_TIMEOUTS = { startTimeoutMs: 500, healthPollIntervalMs: 5, healthProbeTimeoutMs: 50 };

beforeEach(() => {
  ipcHandle.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolvePythonInterpreter', () => {
  it('an explicit override always wins', () => {
    const result = resolvePythonInterpreter('/engine', 'win32', {
      TERRA_PULSE_PYTHON: 'C:/custom/python.exe',
    });
    expect(result).toBe('C:/custom/python.exe');
  });

  it('falls back to a bare command name when no venv and no override exist', () => {
    const result = resolvePythonInterpreter('/does/not/exist', 'linux', {});
    expect(result).toBe('python3');
  });
});

describe('createEngineController lifecycle', () => {
  it('adopts an already-healthy engine without spawning', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(healthBody()));
    const spawnImpl = vi.fn();

    const controller = createEngineController({
      engineDir: '/engine',
      fetchImpl: fetchImpl,
      spawnImpl: spawnImpl,
      ...FAST_TIMEOUTS,
    });

    await vi.waitFor(() => {
      expect(controller.status().state).toBe('ready');
    });

    const status = controller.status();
    expect(status).toMatchObject({ state: 'ready', adopted: true });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('spawns when nothing answers /health, then becomes ready once it does', async () => {
    let spawnedHealthy = false;
    const fetchImpl = vi.fn().mockImplementation(() => {
      if (!spawnedHealthy) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve(jsonResponse(healthBody()));
    });
    const fakeChild = makeFakeChild();
    const spawnImpl = vi.fn().mockImplementation(() => {
      spawnedHealthy = true;
      return fakeChild;
    });

    const controller = createEngineController({
      engineDir: '/engine',
      fetchImpl: fetchImpl,
      spawnImpl: spawnImpl,
      ...FAST_TIMEOUTS,
    });

    await vi.waitFor(() => {
      expect(controller.status().state).toBe('ready');
    });

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(controller.status()).toMatchObject({ state: 'ready', adopted: false });
  });

  it('reports python-not-found when the interpreter cannot be launched', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const spawnImpl = vi.fn().mockImplementation(() => {
      const fakeChild = makeFakeChild();
      queueMicrotask(() => fakeChild.emit('error', new Error('spawn python ENOENT')));
      return fakeChild;
    });

    const controller = createEngineController({
      engineDir: '/engine',
      fetchImpl: fetchImpl,
      spawnImpl: spawnImpl,
      ...FAST_TIMEOUTS,
    });

    await vi.waitFor(() => {
      expect(controller.status().state).toBe('unavailable');
    });

    const status = controller.status();
    expect(status.state === 'unavailable' && status.reason).toBe('python-not-found');
  });

  it('reports start-timeout when the spawned process never answers /health', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const spawnImpl = vi.fn().mockReturnValue(makeFakeChild());

    const controller = createEngineController({
      engineDir: '/engine',
      fetchImpl: fetchImpl,
      spawnImpl: spawnImpl,
      startTimeoutMs: 50,
      healthPollIntervalMs: 5,
      healthProbeTimeoutMs: 10,
    });

    await vi.waitFor(
      () => {
        expect(controller.status().state).toBe('unavailable');
      },
      { timeout: 2000 },
    );

    const status = controller.status();
    expect(status.state === 'unavailable' && status.reason).toBe('start-timeout');
  });

  it('an adopted engine is never killed on dispose', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(healthBody()));
    const spawnImpl = vi.fn();

    const controller = createEngineController({
      engineDir: '/engine',
      fetchImpl: fetchImpl,
      spawnImpl: spawnImpl,
      ...FAST_TIMEOUTS,
    });

    await vi.waitFor(() => {
      expect(controller.status().state).toBe('ready');
    });

    controller.dispose();
    expect(spawnImpl).not.toHaveBeenCalled(); // nothing was ever spawned to kill
  });

  it('a spawned engine is killed on dispose', async () => {
    let spawnedHealthy = false;
    const fakeChild = makeFakeChild();
    const fetchImpl = vi.fn().mockImplementation(() => {
      if (!spawnedHealthy) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve(jsonResponse(healthBody()));
    });
    const spawnImpl = vi.fn().mockImplementation(() => {
      spawnedHealthy = true;
      return fakeChild;
    });

    const controller = createEngineController({
      engineDir: '/engine',
      fetchImpl: fetchImpl,
      spawnImpl: spawnImpl,
      ...FAST_TIMEOUTS,
    });

    await vi.waitFor(() => {
      expect(controller.status().state).toBe('ready');
    });

    controller.dispose();
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('reports contract-mismatch rather than trusting an incompatible engine', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(healthBody(CONTRACT_VERSION + 1)));
    const controller = createEngineController({
      engineDir: '/engine',
      fetchImpl: fetchImpl,
      spawnImpl: vi.fn(),
      ...FAST_TIMEOUTS,
    });

    await vi.waitFor(() => {
      expect(controller.status().state).toBe('unavailable');
    });

    const status = controller.status();
    expect(status.state === 'unavailable' && status.reason).toBe('contract-mismatch');
  });
});

describe('registerAnalysisIpcHandlers', () => {
  function makeDb(): DatabaseSync {
    const db = openDatabase(':memory:');
    const event: EarthquakeEvent = {
      id: 'us0001',
      source: 'usgs',
      magnitude: 5.5,
      magnitudeType: 'mww',
      place: 'somewhere',
      timeUtc: '2011-03-11T05:46:24.000Z',
      updatedUtc: '2011-03-11T05:46:24.000Z',
      longitude: 142.369,
      latitude: 38.297,
      depthKm: 29,
      status: 'reviewed',
      tsunami: true,
      alertLevel: 'red',
      significance: 2910,
      url: 'https://example.test',
    };
    insertEarthquakes(db, [event]);
    return db;
  }

  it('analysis:status reflects the engine controller', () => {
    const db = makeDb();
    const engine = {
      status: () => ({ state: 'ready' as const, engineVersion: '0.1.0', contractVersion: 1, adopted: true }),
      getJson: vi.fn(),
      postJson: vi.fn(),
      dispose: vi.fn(),
    };
    registerAnalysisIpcHandlers(db, engine);

    const result = handlerFor('analysis:status')(undefined);
    expect(result).toMatchObject({ state: 'ready' });
  });

  it('analysis:run sends only the registered constants, never renderer-supplied parameters', async () => {
    const db = makeDb();
    const postJson = vi.fn().mockResolvedValue({
      ok: true,
      json: { hypothesisId: 'H4c', tests: [] },
    });
    const engine = {
      status: () => ({ state: 'ready' as const, engineVersion: '0.1.0', contractVersion: 1, adopted: true }),
      getJson: vi.fn(),
      postJson,
      dispose: vi.fn(),
    };
    registerAnalysisIpcHandlers(db, engine, () => new Date('2026-08-18T00:00:00.000Z'));

    // A renderer trying to smuggle a parameter through the request is simply
    // ignored — the handler only reads the hypothesis id.
    await handlerFor('analysis:run')(undefined, 'H4c');

    expect(postJson).toHaveBeenCalledTimes(1);
    const [path, body] = postJson.mock.calls[0] as [string, { parameters: Record<string, unknown> }];
    expect(path).toBe('/v1/analysis/run');
    expect(body.parameters).toMatchObject({
      targetMinMagnitude: 5.0,
      declustering: 'gardner-knopoff',
      baselineWindowDays: 365.25,
      nullModel: 'uniform-redraw',
      tail: 'upper',
      iterations: 10_000,
      q: 0.05,
    });
    expect(body.parameters['triggers']).toHaveLength(2);
  });

  it('analysis:run dispatches H3b to its own request builder, with H3b\'s own registered constants', async () => {
    const db = makeDb();
    const postJson = vi.fn().mockResolvedValue({
      ok: true,
      json: { hypothesisId: 'H3b', tests: [] },
    });
    const engine = {
      status: () => ({ state: 'ready' as const, engineVersion: '0.1.0', contractVersion: 1, adopted: true }),
      getJson: vi.fn(),
      postJson,
      dispose: vi.fn(),
    };
    registerAnalysisIpcHandlers(db, engine, () => new Date('2026-08-19T00:00:00.000Z'));

    await handlerFor('analysis:run')(undefined, 'H3b');

    expect(postJson).toHaveBeenCalledTimes(1);
    const [path, body] = postJson.mock.calls[0] as [string, { parameters: Record<string, unknown> }];
    expect(path).toBe('/v1/analysis/run');
    expect(body.parameters).toMatchObject({
      targetMinMagnitude: 5.0,
      declustering: 'gardner-knopoff',
      requestedStartUtc: '1995-01-01T00:00:00.000Z',
    });
    expect(body.parameters['triggers']).toHaveLength(1);
    expect(body.parameters['lagWindowsHours']).toHaveLength(4);
  });

  it("analysis:run dispatches H2b to its own request builder, sending only direct-impact arrivals", async () => {
    const db = makeDb();
    const arrivals: CmeArrival[] = [
      {
        simulationId: 'direct-1',
        arrivalTimeUtc: '2020-01-01T00:00:00.000Z',
        predictedKp: 6,
        glancingBlow: false,
        minorImpact: false,
        link: null,
      },
      {
        simulationId: 'glancing-1',
        arrivalTimeUtc: '2020-02-01T00:00:00.000Z',
        predictedKp: 2,
        glancingBlow: true,
        minorImpact: false,
        link: null,
      },
      {
        simulationId: 'minor-1',
        arrivalTimeUtc: '2020-03-01T00:00:00.000Z',
        predictedKp: 1,
        glancingBlow: false,
        minorImpact: true,
        link: null,
      },
    ];
    insertCmeArrivals(db, arrivals);

    const postJson = vi.fn().mockResolvedValue({
      ok: true,
      json: { hypothesisId: 'H2b', tests: [] },
    });
    const engine = {
      status: () => ({ state: 'ready' as const, engineVersion: '0.1.0', contractVersion: 1, adopted: true }),
      getJson: vi.fn(),
      postJson,
      dispose: vi.fn(),
    };
    registerAnalysisIpcHandlers(db, engine, () => new Date('2026-08-19T00:00:00.000Z'));

    await handlerFor('analysis:run')(undefined, 'H2b');

    expect(postJson).toHaveBeenCalledTimes(1);
    const [path, body] = postJson.mock.calls[0] as [
      string,
      { parameters: Record<string, unknown>; cmeArrivalTimesMs: number[] },
    ];
    expect(path).toBe('/v1/analysis/run');
    expect(body.parameters).toMatchObject({
      targetMinMagnitude: 5.0,
      spatialSplitDegrees: 90,
      declustering: 'gardner-knopoff',
      requestedStartUtc: '2014-01-01T00:00:00.000Z',
    });
    expect(body.parameters['lagWindowsHours']).toHaveLength(2);
    // Only the direct impact survives — the glancing blow and minor impact
    // are filtered out before the request ever reaches the engine.
    expect(body.cmeArrivalTimesMs).toEqual([Date.parse('2020-01-01T00:00:00.000Z')]);
  });

  it('analysis:run refuses an unknown hypothesis id without touching the engine', async () => {
    const db = makeDb();
    const postJson = vi.fn();
    const engine = {
      status: () => ({ state: 'ready' as const, engineVersion: '0.1.0', contractVersion: 1, adopted: true }),
      getJson: vi.fn(),
      postJson,
      dispose: vi.fn(),
    };
    registerAnalysisIpcHandlers(db, engine);

    const result = await handlerFor('analysis:run')(undefined, 'H999');

    expect(result).toMatchObject({ ok: false, reason: 'unknown-hypothesis' });
    expect(postJson).not.toHaveBeenCalled();
  });

  it('analysis:run fails cleanly, not with a thrown error, when the engine is not ready', async () => {
    const db = makeDb();
    const engine = {
      status: () => ({ state: 'unavailable' as const, reason: 'python-not-found' as const, detail: 'no python' }),
      getJson: vi.fn(),
      postJson: vi.fn(),
      dispose: vi.fn(),
    };
    registerAnalysisIpcHandlers(db, engine);

    const result = await handlerFor('analysis:run')(undefined, 'H4c');

    expect(result).toEqual({ ok: false, reason: 'python-not-found', detail: 'no python' });
  });
  it('analysis:run dispatches H1b with a discrete flare trigger set, not a series', async () => {
    const db = makeDb();
    // GOES below 2017, DONKI above — the registered join. The C-class flare
    // must not survive the M1.0 filter, and the pre-1996 one must not survive
    // the registered start.
    insertSolarFlares(db, [
      goesFlare('goes:1999', '1999-05-01T00:00:00.000Z', 'M', 2.4),
      goesFlare('goes:1994', '1994-05-01T00:00:00.000Z', 'M', 3.1),
      goesFlare('goes:2015c', '2015-05-01T00:00:00.000Z', 'C', 5.0),
      { ...goesFlare('donki:2020', '2020-05-01T00:00:00.000Z', 'X', 1.2), source: 'donki' as const },
    ]);
    const postJson = vi.fn().mockResolvedValue({ ok: true, json: { hypothesisId: 'H1b', tests: [] } });
    const engine = {
      status: () => ({ state: 'ready' as const, engineVersion: '0.1.0', contractVersion: 1, adopted: true }),
      getJson: vi.fn(),
      postJson,
      dispose: vi.fn(),
    };
    registerAnalysisIpcHandlers(db, engine, () => new Date('2026-08-19T00:00:00.000Z'));

    await handlerFor('analysis:run')(undefined, 'H1b');

    const [, body] = postJson.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.parameters).toMatchObject({
      targetMinMagnitude: 5.0,
      baselineWindowDays: 365.25,
      requestedStartUtc: '1996-01-01T00:00:00.000Z',
    });
    // No series, and no trigger definitions — H1b's whole structural difference.
    expect(body['series']).toBeUndefined();
    expect((body.parameters as Record<string, unknown>)['triggers']).toBeUndefined();
    // Only the M2.4 (1999) and X1.2 (2020) survive both filters.
    expect(body['flarePeakTimesMs']).toEqual([
      Date.parse('1999-05-01T00:00:00.000Z'),
      Date.parse('2020-05-01T00:00:00.000Z'),
    ]);
  });

  it('analysis:run tells the engine when the GOES record is not fully downloaded', async () => {
    // The guard that stops H1b silently reporting a quarter of its registered
    // trigger set as if it were the whole thing.
    const db = makeDb();
    const postJson = vi.fn().mockResolvedValue({ ok: true, json: { hypothesisId: 'H1b', tests: [] } });
    const engine = {
      status: () => ({ state: 'ready' as const, engineVersion: '0.1.0', contractVersion: 1, adopted: true }),
      getJson: vi.fn(),
      postJson,
      dispose: vi.fn(),
    };
    registerAnalysisIpcHandlers(db, engine, () => new Date('2026-08-19T00:00:00.000Z'));

    await handlerFor('analysis:run')(undefined, 'H1b');
    expect((postJson.mock.calls[0] as [string, Record<string, unknown>])[1]['flareCoverageComplete']).toBe(false);

    // Every registered year recorded -> complete.
    for (const year of goesFlareYears()) recordGoesFlareChunk(db, year, 1);
    postJson.mockClear();
    await handlerFor('analysis:run')(undefined, 'H1b');
    expect((postJson.mock.calls[0] as [string, Record<string, unknown>])[1]['flareCoverageComplete']).toBe(true);
  });
});
