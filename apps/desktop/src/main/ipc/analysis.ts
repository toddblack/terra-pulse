import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import {
  ARCHIVE_START_YEAR,
  CONTRACT_VERSION,
  H2B_DECLUSTERING,
  H2B_ITERATIONS,
  H2B_LAG_WINDOWS_HOURS,
  H2B_NULL_MODEL,
  H2B_Q,
  H2B_REQUESTED_START_UTC,
  H2B_SEED,
  H2B_SPATIAL_SPLIT_DEGREES,
  H2B_TAIL,
  H2B_TARGET_MIN_MAGNITUDE,
  H3B_BASELINE_WINDOW_DAYS,
  H3B_DECLUSTERING,
  H3B_ITERATIONS,
  H3B_LAG_WINDOWS_HOURS,
  H3B_NULL_MODEL,
  H3B_Q,
  H3B_REQUESTED_START_UTC,
  H3B_SEED,
  H3B_TAIL,
  H3B_TARGET_MIN_MAGNITUDE,
  H3B_TRIGGERS,
  H4C_BASELINE_WINDOW_DAYS,
  H4C_DECLUSTERING,
  H4C_ITERATIONS,
  H4C_LAG_WINDOWS_HOURS,
  H4C_NULL_MODEL,
  H4C_Q,
  H4C_REQUESTED_START_UTC,
  H4C_SEED,
  H4C_TAIL,
  H4C_TARGET_MIN_MAGNITUDE,
  H4C_TRIGGERS,
  REGISTERED_MATRIX_TESTS,
  isDirectImpact,
  type AnalysisResult,
  type AnalysisRunOutcome,
  type EngineStatus,
  type HypothesisId,
  type HypothesisSummary,
} from '@terra-pulse/schema';
import { queryAnalysisCatalog, queryCmeArrivals } from '@terra-pulse/db';
import { querySpaceWeather } from '@terra-pulse/db';

/**
 * Catalogue queries always reach back to the earthquake archive's own
 * completeness floor, regardless of which hypothesis is asking — declustering
 * benefits from full context (a pre-boundary mainshock can still correctly
 * claim a post-boundary aftershock), and each hypothesis module filters its
 * own *target* set to its own registered start afterward. Sending H4c a
 * narrower catalogue would change nothing (it already filters to 1970), and
 * sending H3b one bounded at its own 1995 start would lose real declustering
 * context across that boundary.
 */
const CATALOG_QUERY_START_UTC = `${String(ARCHIVE_START_YEAR)}-01-01T00:00:00.000Z`;

/** Fixed rather than ephemeral: adopt-if-running needs a port both sides agree on ahead of time. */
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';

/** How long a single /health probe is allowed before it counts as "nobody's there". */
const HEALTH_PROBE_TIMEOUT_MS = 500;
/** Cold numpy/scipy import measured at 1-2s; this is generous headroom above that. */
const START_TIMEOUT_MS = 15_000;
const HEALTH_POLL_INTERVAL_MS = 250;
/** A single Monte-Carlo-backed analysis run, measured at seconds against the real catalogue. */
const RUN_TIMEOUT_MS = 120_000;

interface HealthResponse {
  status: 'ok';
  engineVersion: string;
  contractVersion: number;
  python: string;
}

/**
 * Which local interpreter to launch.
 *
 * Simplified from a four-tier chain to three: an explicit override always
 * wins; otherwise the engine's own venv if one has been set up (the
 * documented dev path, `engine/README.md`); otherwise the OS-conventional
 * bare command name on PATH. There is no runtime fallback between "python3"
 * and "python" — without actually attempting a spawn there is no cheap way
 * to know which exists, and a wrong guess surfaces as `python-not-found`
 * either way, which the caller already has to handle.
 */
export function resolvePythonInterpreter(
  engineDir: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  const override = env['TERRA_PULSE_PYTHON']?.trim();
  if (override) return override;

  const venvPython =
    platform === 'win32'
      ? join(engineDir, '.venv', 'Scripts', 'python.exe')
      : join(engineDir, '.venv', 'bin', 'python');
  if (existsSync(venvPython)) return venvPython;

  return platform === 'win32' ? 'python' : 'python3';
}

async function probeHealth(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<HealthResponse | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/health`, { signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json()) as HealthResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type EngineRequestOutcome<T> =
  | { ok: true; json: T }
  | { ok: false; reason: string; detail: string };

export interface EngineController {
  status(): EngineStatus;
  getJson<T>(path: string): Promise<EngineRequestOutcome<T>>;
  postJson<T>(path: string, body: unknown, timeoutMs?: number): Promise<EngineRequestOutcome<T>>;
  /** Kills a **spawned** engine; an **adopted** one is left running, since main didn't start it. */
  dispose(): void;
}

export interface EngineControllerOptions {
  /** Absolute path to the `engine/` package — used only to locate its venv. */
  engineDir: string;
  host?: string;
  port?: number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  onStatusChange?: (status: EngineStatus) => void;
  /** Overridable so tests don't have to wait out the real multi-second defaults. */
  startTimeoutMs?: number;
  healthPollIntervalMs?: number;
  healthProbeTimeoutMs?: number;
}

/**
 * Adopt-if-running, otherwise spawn.
 *
 * On construction: probe `/health`. If something already answers with a
 * matching contract version, adopt it — this is the normal dev loop, where
 * the engine is run by hand (`pnpm engine:dev`, or `uvicorn --reload`) in a
 * second terminal. Otherwise spawn `python -m terra_pulse_engine` and poll
 * `/health` until it answers or `START_TIMEOUT_MS` elapses.
 *
 * Failure is always a status, never a thrown error or a crashed app —
 * matching this app's posture toward every other optional local
 * prerequisite (a missing DONKI key, an offline SWPC feed): an engine that
 * isn't running is an unconfigured feature, not a fault.
 */
export function createEngineController(options: EngineControllerOptions): EngineController {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const spawnImpl = options.spawnImpl ?? spawn;
  const baseUrl = `http://${host}:${String(port)}`;
  const startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
  const healthPollIntervalMs = options.healthPollIntervalMs ?? HEALTH_POLL_INTERVAL_MS;
  const healthProbeTimeoutMs = options.healthProbeTimeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;

  let status: EngineStatus = { state: 'starting' };
  let child: ChildProcess | null = null;
  let disposed = false;
  let restarted = false;

  function setStatus(next: EngineStatus): void {
    status = next;
    options.onStatusChange?.(next);
  }

  function trimmedDetail(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.split('\n')[0] ?? message;
  }

  async function waitForHealth(deadlineMs: number): Promise<HealthResponse | null> {
    while (Date.now() < deadlineMs) {
      const health = await probeHealth(baseUrl, fetchImpl, healthProbeTimeoutMs);
      if (health) return health;
      await delay(healthPollIntervalMs);
    }
    return null;
  }

  function evaluateHealth(health: HealthResponse | null, adopted: boolean): boolean {
    if (!health) return false;
    if (health.contractVersion !== CONTRACT_VERSION) {
      setStatus({
        state: 'unavailable',
        reason: 'contract-mismatch',
        detail: `engine speaks contract v${String(health.contractVersion)}, app expects v${String(CONTRACT_VERSION)}`,
      });
      return false;
    }
    setStatus({
      state: 'ready',
      engineVersion: health.engineVersion,
      contractVersion: health.contractVersion,
      adopted,
    });
    return true;
  }

  function spawnEngine(): void {
    const pythonPath = resolvePythonInterpreter(options.engineDir, platform, env);
    const proc = spawnImpl(
      pythonPath,
      ['-m', 'terra_pulse_engine', '--host', host, '--port', String(port)],
      { cwd: options.engineDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    child = proc;

    let stderrTail = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    proc.once('error', (error: Error) => {
      // ENOENT: the interpreter itself couldn't be found/launched.
      setStatus({ state: 'unavailable', reason: 'python-not-found', detail: trimmedDetail(error) });
    });

    proc.once('exit', (code, signal) => {
      if (disposed) return;
      if (child === proc) child = null;

      // A deliberate kill from dispose() is not a crash. Anything else,
      // during startup or afterward, gets exactly one automatic restart —
      // no respawn loop.
      if (signal === 'SIGKILL' || signal === 'SIGTERM') return;

      if (!restarted) {
        restarted = true;
        void startSpawned();
        return;
      }

      setStatus({
        state: 'unavailable',
        reason: 'crashed',
        detail: stderrTail.trim().split('\n').pop() ?? `engine exited (code ${String(code)})`,
      });
    });
  }

  async function startSpawned(): Promise<void> {
    setStatus({ state: 'starting' });
    spawnEngine();
    const health = await waitForHealth(Date.now() + startTimeoutMs);
    if (disposed) return;
    if (!evaluateHealth(health, false)) {
      if (status.state === 'starting') {
        setStatus({
          state: 'unavailable',
          reason: 'start-timeout',
          detail: `no response from ${baseUrl}/health within ${String(startTimeoutMs)}ms`,
        });
      }
    }
  }

  async function initialize(): Promise<void> {
    const adoptedHealth = await probeHealth(baseUrl, fetchImpl, healthProbeTimeoutMs);
    if (disposed) return;
    // Anything answering at all means the port is occupied — report exactly
    // why (ready, or a contract mismatch) rather than spawning on top of it,
    // which could only ever collide.
    if (adoptedHealth) {
      evaluateHealth(adoptedHealth, true);
      return;
    }
    await startSpawned();
  }

  void initialize();

  async function request<T>(
    path: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<EngineRequestOutcome<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, { ...init, signal: controller.signal });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { detail?: string } | null;
        return {
          ok: false,
          reason: `engine-error-${String(response.status)}`,
          detail: body?.detail ?? `${String(response.status)} ${response.statusText}`,
        };
      }
      return { ok: true, json: (await response.json()) as T };
    } catch (error: unknown) {
      return { ok: false, reason: 'request-failed', detail: trimmedDetail(error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    status: () => status,
    getJson: <T>(path: string) => request<T>(path, { method: 'GET' }, HEALTH_PROBE_TIMEOUT_MS * 4),
    postJson: <T>(path: string, body: unknown, timeoutMs = RUN_TIMEOUT_MS) =>
      request<T>(
        path,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        timeoutMs,
      ),
    dispose: () => {
      disposed = true;
      // An adopted engine was never ours to stop.
      if (child) {
        child.kill('SIGTERM');
        const toKill = child;
        setTimeout(() => {
          if (!toKill.killed) toKill.kill('SIGKILL');
        }, 2_000);
      }
    },
  };
}

/**
 * Assembles the H4c request body from exactly the registered constants
 * (`packages/schema/src/hypotheses.ts`) plus the catalogue and space-weather
 * series main already knows how to query. Nothing here is renderer-supplied
 * — `analysis:run` takes only a hypothesis id — which is what makes "no free
 * parameters chosen after seeing results" true of the IPC surface, not just
 * of intent.
 */
function buildH4cRequest(db: DatabaseSync, nowUtc: string): unknown {
  const catalog = queryAnalysisCatalog(db, {
    minMagnitude: H4C_TARGET_MIN_MAGNITUDE,
    startUtc: CATALOG_QUERY_START_UTC,
    endUtc: nowUtc,
  });
  const series = querySpaceWeather(db, H4C_REQUESTED_START_UTC, nowUtc);

  return {
    contractVersion: CONTRACT_VERSION,
    hypothesisId: 'H4c',
    parameters: {
      targetMinMagnitude: H4C_TARGET_MIN_MAGNITUDE,
      triggers: H4C_TRIGGERS,
      lagWindowsHours: H4C_LAG_WINDOWS_HOURS,
      declustering: H4C_DECLUSTERING,
      baselineWindowDays: H4C_BASELINE_WINDOW_DAYS,
      nullModel: H4C_NULL_MODEL,
      tail: H4C_TAIL,
      iterations: H4C_ITERATIONS,
      seed: H4C_SEED,
      q: H4C_Q,
      requestedStartUtc: H4C_REQUESTED_START_UTC,
      registeredMatrixTests: REGISTERED_MATRIX_TESTS,
    },
    catalog,
    series: {
      timeMs: series.map((sample) => Date.parse(sample.timeUtc)),
      kp: series.map((sample) => sample.kp),
      dst: series.map((sample) => sample.dst),
      windSpeed: series.map((sample) => sample.windSpeed),
    },
  };
}

/**
 * H3b's request, built the same way — see `buildH4cRequest`'s doc. Proves
 * the same assembly shape generalizes: only the constants imported and the
 * `hypothesisId` literal differ.
 */
function buildH3bRequest(db: DatabaseSync, nowUtc: string): unknown {
  const catalog = queryAnalysisCatalog(db, {
    minMagnitude: H3B_TARGET_MIN_MAGNITUDE,
    startUtc: CATALOG_QUERY_START_UTC,
    endUtc: nowUtc,
  });
  const series = querySpaceWeather(db, H3B_REQUESTED_START_UTC, nowUtc);

  return {
    contractVersion: CONTRACT_VERSION,
    hypothesisId: 'H3b',
    parameters: {
      targetMinMagnitude: H3B_TARGET_MIN_MAGNITUDE,
      triggers: H3B_TRIGGERS,
      lagWindowsHours: H3B_LAG_WINDOWS_HOURS,
      declustering: H3B_DECLUSTERING,
      baselineWindowDays: H3B_BASELINE_WINDOW_DAYS,
      nullModel: H3B_NULL_MODEL,
      tail: H3B_TAIL,
      iterations: H3B_ITERATIONS,
      seed: H3B_SEED,
      q: H3B_Q,
      requestedStartUtc: H3B_REQUESTED_START_UTC,
      registeredMatrixTests: REGISTERED_MATRIX_TESTS,
    },
    catalog,
    series: {
      timeMs: series.map((sample) => Date.parse(sample.timeUtc)),
      kp: series.map((sample) => sample.kp),
      dst: series.map((sample) => sample.dst),
      windSpeed: series.map((sample) => sample.windSpeed),
    },
  };
}

/**
 * H2b's request — a genuinely different shape from H4c/H3b's, not just new
 * constants: no `series` (there is no continuous index this hypothesis
 * thresholds), and the trigger set is CME arrivals rather than something
 * extracted from a series. Filtered to direct impacts by `isDirectImpact`
 * (`packages/schema/src/solar-events.ts`) — the exact registered rule
 * (HYPOTHESES.md H2b: "runs where `isEarthGB` and `isEarthMinorImpact` are
 * both false") — before the request ever reaches the engine, so h2b.py
 * receives arrival instants only, not raw glancing-blow flags to re-derive
 * the same rule from a second time.
 */
function buildH2bRequest(db: DatabaseSync, nowUtc: string): unknown {
  const catalog = queryAnalysisCatalog(db, {
    minMagnitude: H2B_TARGET_MIN_MAGNITUDE,
    startUtc: CATALOG_QUERY_START_UTC,
    endUtc: nowUtc,
  });
  const arrivals = queryCmeArrivals(db, H2B_REQUESTED_START_UTC, nowUtc);
  const directArrivalTimesMs = arrivals
    .filter(isDirectImpact)
    .map((arrival) => Date.parse(arrival.arrivalTimeUtc));

  return {
    contractVersion: CONTRACT_VERSION,
    hypothesisId: 'H2b',
    parameters: {
      targetMinMagnitude: H2B_TARGET_MIN_MAGNITUDE,
      spatialSplitDegrees: H2B_SPATIAL_SPLIT_DEGREES,
      lagWindowsHours: H2B_LAG_WINDOWS_HOURS,
      declustering: H2B_DECLUSTERING,
      nullModel: H2B_NULL_MODEL,
      tail: H2B_TAIL,
      iterations: H2B_ITERATIONS,
      seed: H2B_SEED,
      q: H2B_Q,
      requestedStartUtc: H2B_REQUESTED_START_UTC,
      registeredMatrixTests: REGISTERED_MATRIX_TESTS,
    },
    catalog,
    cmeArrivalTimesMs: directArrivalTimesMs,
  };
}

const REQUEST_BUILDERS: Record<HypothesisId, (db: DatabaseSync, nowUtc: string) => unknown> = {
  H4c: buildH4cRequest,
  H3b: buildH3bRequest,
  H2b: buildH2bRequest,
};

const SUPPORTED_HYPOTHESES: readonly HypothesisId[] = ['H4c', 'H3b', 'H2b'];

export function registerAnalysisIpcHandlers(
  db: DatabaseSync,
  engine: EngineController,
  now: () => Date = () => new Date(),
): void {
  ipcMain.handle('analysis:status', (): EngineStatus => engine.status());

  ipcMain.handle('analysis:hypotheses', async (): Promise<HypothesisSummary[]> => {
    const result = await engine.getJson<HypothesisSummary[]>('/v1/hypotheses');
    return result.ok ? result.json : [];
  });

  ipcMain.handle('analysis:run', async (_event, hypothesisId: unknown): Promise<AnalysisRunOutcome> => {
    if (typeof hypothesisId !== 'string' || !SUPPORTED_HYPOTHESES.includes(hypothesisId as HypothesisId)) {
      return { ok: false, reason: 'unknown-hypothesis', detail: `unsupported hypothesis: ${String(hypothesisId)}` };
    }

    const engineStatus = engine.status();
    if (engineStatus.state !== 'ready') {
      const detail = engineStatus.state === 'unavailable' ? engineStatus.detail : 'engine is still starting';
      const reason = engineStatus.state === 'unavailable' ? engineStatus.reason : 'not-ready';
      return { ok: false, reason, detail };
    }

    const buildRequest = REQUEST_BUILDERS[hypothesisId as HypothesisId];
    const request = buildRequest(db, now().toISOString());
    const result = await engine.postJson<AnalysisResult>('/v1/analysis/run', request);
    return result.ok ? { ok: true, result: result.json } : { ok: false, reason: result.reason, detail: result.detail };
  });
}
