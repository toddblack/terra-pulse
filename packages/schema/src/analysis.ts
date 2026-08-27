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

export type HypothesisId = 'H4c' | 'H3b' | 'H2b' | 'H1b' | 'H5' | 'H6';

/**
 * Hypotheses that cannot run without the JPL ephemeris kernel on disk.
 *
 * Declared here rather than inferred in the UI, and deliberately **not** added
 * to `HypothesisSummary`: whether H6 needs an ephemeris is a fact about the
 * registration, fixed in `HYPOTHESES.md`, not something the engine should get
 * to report differently from one build to the next. The renderer reads this to
 * decide whether to show the prerequisite card and whether Run is available.
 *
 * A `Set` over a union member that does not exist fails to compile, so adding a
 * future ephemeris-dependent hypothesis is caught here the same way
 * `HYPOTHESIS_COPY` and `useAnalysisStore`'s record catch a new id.
 */
export const EPHEMERIS_DEPENDENT_HYPOTHESES: readonly HypothesisId[] = ['H6'];

export function requiresEphemeris(id: HypothesisId): boolean {
  return EPHEMERIS_DEPENDENT_HYPOTHESES.includes(id);
}

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
  /**
   * What `observed` and `expected` actually are, when they are not an observed
   * count and a Poisson expectation. All three statistic fields are required,
   * so a hypothesis with a different shape repurposes them — H2b's are near/far
   * hemisphere counts, H5's a sample size and a two-sided D. Rendering those
   * under headers reading "Observed"/"Expected" states something false about
   * what the number is. Null means the default reading holds.
   */
  observedLabel: string | null;
  expectedLabel: string | null;
  /**
   * What `ratio` actually is, when it is not a ratio.
   *
   * `ratio` has to hold whatever statistic the null histogram was built from,
   * because the histogram's observed-value guide line is drawn from this
   * field — so a hypothesis whose statistic is not a ratio cannot park it
   * anywhere else. H5's is a one-sided KS D⁺. Null (H4c/H3b/H1b) means it
   * really is an observed/expected ratio and renders with the `×` suffix.
   */
  statisticLabel: string | null;
  /**
   * Circular descriptives, for a hypothesis whose statistic is a concentration
   * on a circle rather than a rate. H6 is the only one so far; every other
   * hypothesis leaves both null.
   *
   * `preferredPhaseDeg` is the direction of Schuster's resultant — the tidal
   * phase events cluster toward, if any. Reported even when the resultant sits
   * at its noise floor, because withholding it there would make a null look
   * like a missing value instead of a null.
   *
   * `phaseHistogram` is the registered 12-bin presentation view, running from
   * −180°. `HYPOTHESES.md` H6 is explicit that the binning is "for presentation
   * and the sinusoidal fit only" — the statistic itself is unbinned, so nothing
   * about the p-value depends on it.
   */
  preferredPhaseDeg: number | null;
  phaseHistogram: number[] | null;
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
  iterations: number;
  /** Exactly one of these two is populated, matching which parameter shape
   * the hypothesis registers — H4c/H3b's moving Poisson baseline, or H2b's
   * spatial split. Both stay on one response shape because the UI renders
   * one generic results panel for every hypothesis. */
  baselineWindowDays: number | null;
  spatialSplitDegrees: number | null;
  /**
   * How a hypothesis meets a registered completeness requirement, when it has
   * one. H5's is the only one so far and it is the parameter the whole test
   * turns on — without this the results panel would list every registered
   * parameter *except* the one a reader most needs to check.
   */
  completenessModel: string | null;
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
