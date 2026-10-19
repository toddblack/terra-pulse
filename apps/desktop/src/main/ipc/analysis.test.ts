import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
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
import {
  createEngineController,
  findFreePort,
  registerAnalysisIpcHandlers,
  resolveEngineCommand,
  resolvePythonInterpreter,
} from './analysis';

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

describe('resolveEngineCommand', () => {
  /** Nothing on disk unless a case says so. */
  const nothingExists = () => false;

  it('runs a shipped bundle directly, with no interpreter involved', () => {
    // The whole point of freezing: a packaged build has no Python to find.
    const command = resolveEngineCommand('/engine', '/resources/engine', 'win32', {}, () => true);

    expect(command.kind).toBe('bundled');
    expect(command.command).toBe(join('/resources/engine', 'terra-pulse-engine.exe'));
    expect(command.args).toEqual([]);
  });

  it('names the platform executable without an extension off Windows', () => {
    const command = resolveEngineCommand('/engine', '/resources/engine', 'darwin', {}, () => true);

    expect(command.command).toBe(join('/resources/engine', 'terra-pulse-engine'));
  });

  it('spawns from the bundle directory, never from a source tree that was not shipped', () => {
    // `spawn` with a non-existent cwd fails on Windows, and a packaged build's
    // `engineDir` points into a repo that is not there. Getting this wrong
    // surfaces as an ENOENT that reads as "Python is missing".
    const command = resolveEngineCommand(
      '/never/shipped/engine',
      '/resources/engine',
      'win32',
      {},
      () => true,
    );

    expect(command.cwd).toBe('/resources/engine');
  });

  it('falls back to an interpreter when no bundle was shipped', () => {
    const command = resolveEngineCommand('/engine', undefined, 'linux', {}, nothingExists);

    expect(command.kind).toBe('interpreter');
    expect(command.command).toBe('python3');
    expect(command.args).toEqual(['-m', 'terra_pulse_engine']);
    expect(command.cwd).toBe('/engine');
  });

  it('falls back to an interpreter when a bundle was expected but is missing', () => {
    // Packaging without running `pnpm engine:bundle` first. Better to try a
    // local Python and report honestly than to spawn a path that isn't there.
    const command = resolveEngineCommand('/engine', '/resources/engine', 'linux', {}, nothingExists);

    expect(command.kind).toBe('interpreter');
  });

  it('lets an explicit interpreter override beat a shipped bundle', () => {
    // The documented escape hatch for running modified engine source against
    // an installed build.
    const command = resolveEngineCommand(
      '/engine',
      '/resources/engine',
      'win32',
      { TERRA_PULSE_PYTHON: 'C:/custom/python.exe' },
      () => true,
    );

    expect(command.kind).toBe('interpreter');
    expect(command.command).toBe('C:/custom/python.exe');
  });

  it('lets TERRA_PULSE_ENGINE_BIN point a dev run at a bundle', () => {
    // In dev `bundledEngineDir` is deliberately undefined so the venv wins;
    // this is the way to aim at a bundle on purpose.
    const command = resolveEngineCommand(
      '/engine',
      undefined,
      'win32',
      { TERRA_PULSE_ENGINE_BIN: '/built/terra-pulse-engine.exe' },
      nothingExists,
    );

    expect(command.kind).toBe('bundled');
    expect(command.command).toBe('/built/terra-pulse-engine.exe');
    expect(command.cwd).toBe(dirname('/built/terra-pulse-engine.exe'));
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

describe('createEngineController access', () => {
  /** The header a fetch call carried, whatever shape `init.headers` took. */
  function tokenSent(call: unknown[]): string | null {
    const init = call[1] as RequestInit | undefined;
    return new Headers(init?.headers).get('X-Terra-Pulse-Token');
  }

  /** A spawn that becomes healthy, recording what it was launched with. */
  function healthyAfterSpawn() {
    let spawned = false;
    const fetchImpl = vi.fn().mockImplementation(() =>
      spawned ? Promise.resolve(jsonResponse(healthBody())) : Promise.reject(new Error('ECONNREFUSED')),
    );
    const spawnImpl = vi.fn().mockImplementation(() => {
      spawned = true;
      return makeFakeChild();
    });
    return { fetchImpl, spawnImpl };
  }

  it('gives a spawned engine its token in the environment, never on the command line', async () => {
    const { fetchImpl, spawnImpl } = healthyAfterSpawn();
    const controller = createEngineController({
      engineDir: '/engine',
      token: 'tok-123',
      env: { PATH: '/bin' },
      fetchImpl,
      spawnImpl,
      ...FAST_TIMEOUTS,
    });
    await vi.waitFor(() => {
      expect(controller.status().state).toBe('ready');
    });

    const [, args, spawnOptions] = spawnImpl.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(spawnOptions.env['TERRA_PULSE_ENGINE_TOKEN']).toBe('tok-123');
    expect(spawnOptions.env['PATH']).toBe('/bin'); // the rest of the environment survives
    expect(args.join(' ')).not.toContain('tok-123');
  });

  it('sends the token on every request, probes included', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(healthBody()));
    const controller = createEngineController({
      engineDir: '/engine',
      token: 'tok-123',
      fetchImpl,
      spawnImpl: vi.fn(),
      ...FAST_TIMEOUTS,
    });
    await vi.waitFor(() => {
      expect(controller.status().state).toBe('ready');
    });
    await controller.getJson('/v1/hypotheses');
    await controller.postJson('/v1/analysis/run', { hypothesisId: 'H4c' });

    expect(fetchImpl.mock.calls.length).toBe(3);
    for (const call of fetchImpl.mock.calls) expect(tokenSent(call)).toBe('tok-123');
    // The POST keeps its content type alongside the token.
    const postInit = fetchImpl.mock.calls[2]?.[1] as RequestInit;
    expect(new Headers(postInit.headers).get('Content-Type')).toBe('application/json');
  });

  it('makes a different token for each controller when none is given', async () => {
    const tokens: (string | null)[] = [];
    for (let i = 0; i < 2; i++) {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(healthBody()));
      const controller = createEngineController({ engineDir: '/engine', fetchImpl, spawnImpl: vi.fn(), ...FAST_TIMEOUTS });
      await vi.waitFor(() => {
        expect(controller.status().state).toBe('ready');
      });
      tokens.push(tokenSent(fetchImpl.mock.calls[0] as unknown[]));
    }
    expect(tokens[0]).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('with adoption off, spawns its own engine even when one already answers', async () => {
    // A packaged build: whatever holds the port, the app talks to an engine it started.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(healthBody()));
    const spawnImpl = vi.fn().mockReturnValue(makeFakeChild());
    const controller = createEngineController({
      engineDir: '/engine',
      allowAdopt: false,
      fetchImpl,
      spawnImpl,
      ...FAST_TIMEOUTS,
    });
    await vi.waitFor(() => {
      expect(controller.status().state).toBe('ready');
    });

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(controller.status()).toMatchObject({ adopted: false });
  });

  it("with port 'auto', spawns on the port it was given and talks to it there", async () => {
    const { fetchImpl, spawnImpl } = healthyAfterSpawn();
    const controller = createEngineController({
      engineDir: '/engine',
      port: 'auto',
      allowAdopt: false,
      findPort: () => Promise.resolve(54321),
      fetchImpl,
      spawnImpl,
      ...FAST_TIMEOUTS,
    });
    await vi.waitFor(() => {
      expect(controller.status().state).toBe('ready');
    });

    const [, args] = spawnImpl.mock.calls[0] as [string, string[]];
    expect(args.slice(-2)).toEqual(['--port', '54321']);
    for (const call of fetchImpl.mock.calls) expect(String(call[0])).toContain('127.0.0.1:54321/');
  });

  it('reports port-conflict when no free port can be found', async () => {
    const spawnImpl = vi.fn();
    const controller = createEngineController({
      engineDir: '/engine',
      port: 'auto',
      findPort: () => Promise.reject(new Error('EACCES')),
      fetchImpl: vi.fn(),
      spawnImpl,
      ...FAST_TIMEOUTS,
    });
    await vi.waitFor(() => {
      expect(controller.status().state).toBe('unavailable');
    });

    expect(controller.status()).toMatchObject({ reason: 'port-conflict' });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('reports port-conflict, not a slow start timeout, when the port holds an engine wanting another token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ detail: 'missing or wrong engine token' }, 401));
    const spawnImpl = vi.fn();
    const controller = createEngineController({ engineDir: '/engine', fetchImpl, spawnImpl, ...FAST_TIMEOUTS });
    await vi.waitFor(() => {
      expect(controller.status().state).toBe('unavailable');
    });

    expect(controller.status()).toMatchObject({ reason: 'port-conflict' });
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

describe('findFreePort', () => {
  it('returns a port that can actually be bound', async () => {
    const port = await findFreePort('127.0.0.1');
    expect(port).toBeGreaterThan(0);
    const { createServer } = await import('node:net');
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.close(() => {
          resolve();
        });
      });
    });
  });
});
