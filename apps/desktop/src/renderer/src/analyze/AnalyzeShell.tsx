import { useState } from 'react';
import type { AnalysisTestResult } from '@terra-pulse/schema';
import { useAnalysisStore } from './useAnalysisStore';
import { useEngineStatus } from './useEngineStatus';
import { layoutNullHistogram, observedFraction } from './null-histogram';
import { formatCount, formatPValue, formatRatio } from './result-format';
import styles from './AnalyzeShell.module.css';

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
 */
export function AnalyzeShell() {
  const engineStatus = useEngineStatus();
  const result = useAnalysisStore((state) => state.result);
  const running = useAnalysisStore((state) => state.running);
  const error = useAnalysisStore((state) => state.error);
  const run = useAnalysisStore((state) => state.run);
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);

  const selectedTest =
    result?.tests.find((test) => test.id === selectedTestId) ?? result?.tests[0] ?? null;

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <h2 className={styles.title}>H4c — Global geomagnetic disturbance</h2>
        <p className={styles.statement}>
          Elevated planetary geomagnetic activity is followed by an elevated global M5.0+
          earthquake rate.
        </p>
        <p className={styles.meta}>Registered 2026-08-14 · 6 tests in this family</p>
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
        disabled={engineStatus.state !== 'ready' || running}
        onClick={() => {
          void run('H4c');
        }}
      >
        {running ? 'Running…' : 'Run H4c'}
      </button>

      {error && <p className={styles.error}>{error}</p>}

      {result && (
        <>
          <section>
            <h3 className={styles.sectionHeading}>Registered parameters</h3>
            <dl className={styles.paramList}>
              <dt>Target floor</dt>
              <dd>M{result.catalog.minMagnitude.toFixed(1)}+</dd>
              <dt>Declustering</dt>
              <dd>{result.catalog.declustering}</dd>
              <dt>Baseline window</dt>
              <dd>±{(result.method.baselineWindowDays / 2).toFixed(1)} days</dd>
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
