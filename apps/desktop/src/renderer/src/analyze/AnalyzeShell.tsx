import { useState } from 'react';
import type { AnalysisTestResult, HypothesisId } from '@terra-pulse/schema';
import { useAnalysisStore } from './useAnalysisStore';
import { useEngineStatus } from './useEngineStatus';
import { useEngineHypotheses } from './useEngineHypotheses';
import { layoutNullHistogram, observedFraction } from './null-histogram';
import { formatCount, formatPValue, formatRatio } from './result-format';
import styles from './AnalyzeShell.module.css';

/**
 * UI-only copy — the human-readable statement and registration date, not a
 * registered *parameter*. Nothing here reaches the engine; it exists purely
 * to label whichever hypothesis is selected, the same way `layer-guides.ts`
 * carries explanatory prose that has no bearing on what a layer actually
 * draws. Sourced from `HYPOTHESES.md` verbatim.
 */
const HYPOTHESIS_COPY: Record<HypothesisId, { title: string; statement: string; registeredDate: string }> = {
  H4c: {
    title: 'H4c — Global geomagnetic disturbance',
    statement:
      'Elevated planetary geomagnetic activity is followed by an elevated global M5.0+ earthquake rate.',
    registeredDate: '2026-08-14',
  },
  H3b: {
    title: 'H3b — Coronal hole high-speed streams',
    statement: 'Coronal hole high-speed stream arrivals are followed by an elevated global M5.0+ rate.',
    registeredDate: '2026-08-15',
  },
  H2b: {
    title: 'H2b — CME hemispheric asymmetry',
    statement:
      'Any H1b effect is stronger on the hemisphere facing the Sun at CME arrival time than on the far hemisphere.',
    registeredDate: '2026-08-17',
  },
  H1b: {
    title: 'H1b — Solar flares',
    statement:
      'X- and M-class solar flare occurrence is followed by an elevated global M5.0+ earthquake rate.',
    registeredDate: '2026-08-17',
  },
};

/**
 * The app's first non-Explore surface (§Phase 4). `App.tsx` mounts this only
 * while `useAppModeStore`'s mode is `'analyze'` — genuinely unmounted, not
 * hidden, while Explore is active, which is one of the four layers keeping
 * this data out of Explore (see `useAnalysisStore.ts` and
 * `explore-purity.test.ts` for the other three).
 *
 * A null result is rendered with the same weight as a rejection —
 * `HYPOTHESES.md` rule 5 — so there is deliberately no green/red pass-fail
 * colouring anywhere below: a row that clears q=0.05 looks like data, not
 * like a win.
 *
 * **Generic across hypotheses, not H4c-specific**, since H3b landed
 * alongside it: the selector below reflects whatever the engine actually
 * implements (`useEngineHypotheses`), not a hardcoded list, and the header
 * describes whichever one is currently selected — proof the "the pipeline
 * generalizes" bet paid off on the UI side too, not just the engine's.
 */
export function AnalyzeShell() {
  const engineStatus = useEngineStatus();
  const implementedHypotheses = useEngineHypotheses();
  const byHypothesis = useAnalysisStore((state) => state.byHypothesis);
  const run = useAnalysisStore((state) => state.run);
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);
  // `null` means "nothing explicitly picked yet" — the *effective* selection
  // below then falls back to whichever the engine lists first, computed
  // during render rather than synced via an effect (there's nothing to
  // subscribe to here; this is a plain derived value).
  const [explicitHypothesisId, setExplicitHypothesisId] = useState<HypothesisId | null>(null);
  const selectedHypothesisId = explicitHypothesisId ?? implementedHypotheses[0]?.id ?? null;

  // Each tab keeps its own last result live underneath it (`useAnalysisStore`
  // is keyed by hypothesis) — switching tabs never clears a result and never
  // touches a run still in flight on another tab.
  const selectedRun = selectedHypothesisId ? byHypothesis[selectedHypothesisId] : null;
  const result = selectedRun?.result ?? null;
  const running = selectedRun?.running ?? false;
  const error = selectedRun?.error ?? null;

  const selectedTest =
    result?.tests.find((test) => test.id === selectedTestId) ?? result?.tests[0] ?? null;
  const selectedSummary = implementedHypotheses.find((h) => h.id === selectedHypothesisId) ?? null;
  const selectedCopy = selectedHypothesisId ? HYPOTHESIS_COPY[selectedHypothesisId] : null;

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        {implementedHypotheses.length > 1 && (
          <div className={styles.hypothesisSwitch} role="tablist" aria-label="Hypothesis">
            {implementedHypotheses.map((h) => {
              const tabRun = byHypothesis[h.id];
              return (
                <button
                  key={h.id}
                  type="button"
                  role="tab"
                  aria-selected={h.id === selectedHypothesisId}
                  className={h.id === selectedHypothesisId ? styles.hypothesisActive : styles.hypothesisInactive}
                  onClick={() => {
                    setExplicitHypothesisId(h.id);
                    setSelectedTestId(null);
                  }}
                >
                  {h.id}
                  {/* A run left going in the background has no other visible
                      trace once you've switched away from its tab — this is
                      what tells you it's still working, or that it failed
                      while you were looking elsewhere. */}
                  {tabRun.running && (
                    <span className={styles.tabRunning} aria-label="running" title="Running…" />
                  )}
                  {!tabRun.running && tabRun.error && (
                    <span className={styles.tabError} aria-label="error" title={tabRun.error} />
                  )}
                </button>
              );
            })}
          </div>
        )}
        <h2 className={styles.title}>{selectedCopy?.title ?? 'Loading hypotheses…'}</h2>
        {selectedCopy && <p className={styles.statement}>{selectedCopy.statement}</p>}
        {selectedCopy && (
          <p className={styles.meta}>
            Registered {selectedCopy.registeredDate}
            {selectedSummary && ` · ${String(selectedSummary.testsInFamily)} tests in this family`}
          </p>
        )}
      </header>

      {engineStatus.state !== 'ready' && (
        <div className={styles.engineNotice}>
          {engineStatus.state === 'starting' && <p>Starting the statistical engine…</p>}
          {engineStatus.state === 'unavailable' && (
            <>
              <p>{describeUnavailable(engineStatus.reason)}.</p>
              <p className={styles.engineDetail}>{engineStatus.detail}</p>
              <p className={styles.engineHint}>
                Dev-only this round — run <code>pnpm engine:dev</code> in a second terminal, then
                reopen this panel. See <code>engine/README.md</code>.
              </p>
            </>
          )}
        </div>
      )}

      <button
        type="button"
        className={styles.runButton}
        disabled={engineStatus.state !== 'ready' || running || selectedHypothesisId === null}
        onClick={() => {
          if (selectedHypothesisId) void run(selectedHypothesisId);
        }}
      >
        {running ? 'Running…' : selectedHypothesisId ? `Run ${selectedHypothesisId}` : 'Run'}
      </button>

      {error && <p className={styles.error}>{error}</p>}

      {result && (
        <>
          <section>
            <h3 className={styles.sectionHeading}>
              Registered parameters — {result.hypothesisId}
            </h3>
            <dl className={styles.paramList}>
              <dt>Target floor</dt>
              <dd>M{result.catalog.minMagnitude.toFixed(1)}+</dd>
              <dt>Declustering</dt>
              <dd>{result.catalog.declustering}</dd>
              {/* Exactly one of these two is populated, matching which
                  parameter shape the hypothesis registers — see
                  MethodInfo's own doc in packages/schema/src/analysis.ts. */}
              {result.method.baselineWindowDays !== null && (
                <>
                  <dt>Baseline window</dt>
                  <dd>±{(result.method.baselineWindowDays / 2).toFixed(1)} days</dd>
                </>
              )}
              {result.method.spatialSplitDegrees !== null && (
                <>
                  <dt>Spatial split</dt>
                  <dd>±{result.method.spatialSplitDegrees}° longitude</dd>
                </>
              )}
              <dt>Null model</dt>
              <dd>{result.method.nullModel}</dd>
              <dt>Tail</dt>
              <dd>{result.method.tail}</dd>
              <dt>Iterations</dt>
              <dd>{formatCount(result.method.iterations)}</dd>
              <dt>Span used</dt>
              <dd>
                {result.span.usedStartUtc.slice(0, 10)} – {result.span.usedEndUtc.slice(0, 10)}
                {result.span.truncationReason && (
                  <span className={styles.truncationNote}>
                    {' '}
                    (registered {result.span.requestedStartUtc.slice(0, 10)}, truncated:{' '}
                    {result.span.truncationReason})
                  </span>
                )}
              </dd>
            </dl>
          </section>

          <p className={styles.catalogLine}>
            {formatCount(result.catalog.rawCount)} raw M{result.catalog.minMagnitude.toFixed(1)}+
            events → {formatCount(result.catalog.declusteredCount)} independent after declustering
          </p>

          <div className={styles.tableWrapper}>
            <table className={styles.testTable}>
              <thead>
                <tr>
                  <th>Trigger</th>
                  <th>Lag</th>
                  <th>Observed</th>
                  <th>Expected</th>
                  <th>Ratio</th>
                  <th>p (raw)</th>
                  <th>p (adj., full matrix)</th>
                  <th>p (adj., this run)</th>
                </tr>
              </thead>
              <tbody>
                {result.tests.map((test) => (
                  <tr
                    key={test.id}
                    className={test.id === selectedTest?.id ? styles.selectedRow : undefined}
                    onClick={() => {
                      setSelectedTestId(test.id);
                    }}
                  >
                    <td>{test.triggerId}</td>
                    <td>
                      {test.lagHours[0]}–{test.lagHours[1]}h
                    </td>
                    <td>{formatCount(test.observed)}</td>
                    <td>{test.expected.toFixed(2)}</td>
                    <td>{formatRatio(test.ratio)}</td>
                    <td>{formatPValue(test.pRaw)}</td>
                    <td>{formatPValue(test.pAdjustedFullMatrix)}</td>
                    <td>{formatPValue(test.pAdjustedWithinRun)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedTest && (
            <section>
              <h3 className={styles.sectionHeading}>
                Null distribution — {selectedTest.triggerId}, {selectedTest.lagHours[0]}–
                {selectedTest.lagHours[1]}h
              </h3>
              <NullHistogramChart test={selectedTest} />
            </section>
          )}

          <p className={styles.denominator}>{result.correction.note}</p>

          {result.caveats.length > 0 && (
            <ul className={styles.caveats}>
              {result.caveats.map((caveat) => (
                <li key={caveat}>{caveat}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function describeUnavailable(reason: string): string {
  switch (reason) {
    case 'python-not-found':
      return 'No Python interpreter found';
    case 'deps-missing':
      return 'Engine dependencies are not installed';
    case 'contract-mismatch':
      return "The running engine speaks a version this app doesn't expect";
    case 'start-timeout':
      return 'The engine did not start in time';
    case 'crashed':
      return 'The engine process exited unexpectedly';
    case 'port-conflict':
      return 'The engine port is already in use';
    default:
      return 'The statistical engine is unavailable';
  }
}

/**
 * A 60-bin histogram, drawn as a bar per bin — never a smoothed curve, which
 * would imply more resolution than 10,000 discrete permutations actually
 * carry. The guide line marks the *observed* ratio, clamped into range by
 * `observedFraction` so a strongly significant result still shows the line
 * pinned to the edge rather than vanishing off it.
 */
function NullHistogramChart({ test }: { test: AnalysisTestResult }) {
  const width = 320;
  const height = 64;
  const bars = layoutNullHistogram(test.null.histogram);
  const guide = observedFraction(test.null.histogram, test.ratio);

  return (
    <svg
      className={styles.histogram}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      role="img"
      aria-label={`Null distribution for ${test.id}`}
    >
      {bars.map((bar, index) => (
        <rect
          key={`${String(bar.x)}-${String(index)}`}
          x={bar.x * width}
          y={height - bar.height * height}
          width={Math.max(bar.width * width - 1, 0)}
          height={bar.height * height}
          className={styles.histogramBar}
        />
      ))}
      {guide !== null && (
        <line
          x1={guide * width}
          x2={guide * width}
          y1={0}
          y2={height}
          className={styles.histogramGuide}
        />
      )}
    </svg>
  );
}
