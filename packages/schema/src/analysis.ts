/**
 * The Analyze-mode contract with the Python statistical engine
 * (`engine/terra_pulse_engine/api/contracts.py` — that file is the other
 * half of this one; the two are meant to be read together, and
 * `CONTRACT_VERSION` is what catches them drifting apart).
 *
 * These types describe wire JSON, not internal state — every field name here
 * matches the engine's camelCase Pydantic aliases exactly, since main passes
 * the engine's HTTP response straight through to the renderer with no
 * remapping in between.
 */

/**
 * Bumped whenever a field's *meaning* changes, not merely when one is added.
 * Checked on every engine health poll (`apps/desktop/src/main/ipc/analysis.ts`);
 * a mismatch is reported as `EngineStatus.reason === 'contract-mismatch'`
 * rather than trusted.
 */
export const CONTRACT_VERSION = 1;

export type HypothesisId = 'H4c';

export interface HypothesisSummary {
  id: HypothesisId;
  implemented: boolean;
  testsInFamily: number;
}

/**
 * Main's view of the local engine process — adopted (already running, the
 * normal dev loop) or spawned, and why it's unavailable when it is.
 *
 * Modelled as a status, not an error thrown across IPC: an engine that isn't
 * running is an unconfigured feature, not a fault, the same posture this app
 * already takes toward a missing DONKI key.
 */
export type EngineStatus =
  | { state: 'starting' }
  | { state: 'ready'; engineVersion: string; contractVersion: number; adopted: boolean }
  | {
      state: 'unavailable';
      reason:
        | 'python-not-found'
        | 'deps-missing'
        | 'contract-mismatch'
        | 'start-timeout'
        | 'crashed'
        | 'port-conflict';
      /** One trimmed line — never a full traceback crossing the bridge. */
      detail: string;
    };

export interface SpanInfo {
  requestedStartUtc: string;
  usedStartUtc: string;
  usedEndUtc: string;
  truncationReason: string | null;
}

export interface CatalogInfo {
  minMagnitude: number;
  rawCount: number;
  declusteredCount: number;
  declustering: string;
}

export interface TriggerInfo {
  id: string;
  count: number;
  eligibleHours: number;
}

export interface NullHistogram {
  edges: number[];
  counts: number[];
}

export interface NullInfo {
  mean: number;
  sd: number;
  quantiles: Record<string, number>;
  histogram: NullHistogram;
}

export interface AnalysisTestResult {
  id: string;
  triggerId: string;
  lagHours: readonly [number, number];
  observed: number;
  expected: number;
  ratio: number;
  pRaw: number;
  pAdjustedWithinRun: number;
  pAdjustedFullMatrix: number;
  rejectedAtQ: boolean;
  null: NullInfo;
}

export interface CorrectionInfo {
  method: 'benjamini-hochberg';
  q: number;
  testsRun: number;
  registeredMatrixTests: number;
  deferredTests: number;
  blockedTests: number;
  partialMatrix: boolean;
  /** Human-readable, always rendered verbatim rather than reconstructed — see
   * `CLAUDE.md`'s Analyze-mode notes on why the denominator sentence is never
   * hardcoded in the UI. */
  note: string;
}

export interface MethodInfo {
  nullModel: string;
  tail: string;
  baselineWindowDays: number;
  iterations: number;
}

/**
 * One completed hypothesis run. Every field the UI needs to make "no free
 * parameters" and "report the denominator" (`HYPOTHESES.md` rules 2 and 4)
 * *visible*, not merely true in code the reader can't see.
 */
export interface AnalysisResult {
  contractVersion: number;
  engineVersion: string;
  hypothesisId: HypothesisId;
  runAtUtc: string;
  durationMs: number;
  seed: number;
  span: SpanInfo;
  catalog: CatalogInfo;
  triggers: TriggerInfo[];
  tests: AnalysisTestResult[];
  correction: CorrectionInfo;
  method: MethodInfo;
  caveats: string[];
}

/**
 * `analysis:run`'s result. A typed failure rather than a rejected promise —
 * matching this app's IPC convention that things the user can't fix by
 * retrying (an unreachable engine, a stale contract) are represented as
 * data, not exceptions crossing the bridge.
 */
export type AnalysisRunOutcome =
  | { ok: true; result: AnalysisResult }
  | { ok: false; reason: string; detail: string };
