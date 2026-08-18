import { useEffect, useState } from 'react';
import { DONKI_START_YEAR, type DonkiProgress } from '@terra-pulse/schema';
import styles from './ArchivePanel.module.css';

const IDLE: DonkiProgress = {
  state: 'idle',
  phase: null,
  completedChunks: 0,
  totalChunks: 0,
  storedFlares: 0,
  storedCmeArrivals: 0,
  currentYear: null,
  error: null,
};

/** Whether anything at all is stored, and therefore Download versus Resume. */
function isEmpty(progress: DonkiProgress): boolean {
  return progress.storedFlares === 0 && progress.storedCmeArrivals === 0;
}

function describe(progress: DonkiProgress): string {
  if (progress.state === 'running') {
    const label = progress.phase === 'cme' ? 'CME arrivals' : 'flares';
    return progress.currentYear === null
      ? 'starting…'
      : `${label} ${String(progress.currentYear)} · ${String(progress.completedChunks)}/${String(progress.totalChunks)}`;
  }
  if (isEmpty(progress)) {
    return `flares and CME arrivals from ${String(DONKI_START_YEAR)}`;
  }
  return `${progress.storedFlares.toLocaleString()} flares · ${progress.storedCmeArrivals.toLocaleString()} CME arrivals`;
}

/**
 * The DONKI backfill control — the data H1b and H2b are registered against.
 *
 * A third panel grouped with `ArchivePanel` and `SpaceWeatherArchive` under
 * `HistoricalDataPanel`'s single disclosure, but independent from both:
 * separate download, separate cost, separate failure mode. Reuses the
 * archive panel's stylesheet for its content — the same idiom, and a second
 * visual language for the same interaction would be noise — though the outer
 * card chrome now belongs to the parent.
 *
 * **The live tail needs none of this** — it arrives from the rolling poll and
 * the two marker layers show it immediately. This is only for the historical
 * record.
 */
export function DonkiArchive() {
  const [progress, setProgress] = useState<DonkiProgress>(IDLE);

  useEffect(() => {
    let cancelled = false;

    void window.terraPulse.solarEvents.status().then(
      (initial) => {
        if (!cancelled) setProgress(initial);
      },
      (error: unknown) => {
        console.error('Failed to read DONKI status', error);
      },
    );

    const unsubscribe = window.terraPulse.solarEvents.onProgress(setProgress);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const running = progress.state === 'running';
  const percent =
    progress.totalChunks === 0
      ? 0
      : Math.round((progress.completedChunks / progress.totalChunks) * 100);

  return (
    <div id="donki-archive">
      {/* h4, not h2 — see the identical note in ArchivePanel.tsx. */}
      <h4 className={styles.heading}>Solar event history</h4>
      <p className={styles.status}>{describe(progress)}</p>

      {running && (
        <div
          className={styles.track}
          role="progressbar"
          aria-label="Solar event history download progress"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={styles.fill} style={{ width: `${String(percent)}%` }} />
        </div>
      )}

      {!running && isEmpty(progress) && (
        <p className={styles.note}>
          {/* The real constraint here is the shared key's request budget, not
              file size — DONKI records are small JSON, unlike the OMNI/USGS
              archives this panel sits beside.

              Kept to one short line deliberately: `.leftColumn` is
              `width: max-content` (App.module.css), so its widest child sets
              the width for Magnitude, Window, History and both other archive
              panels together. The first version of this note was 124
              characters against the Archive/Geomagnetic notes' ~60 and
              visibly widened the whole column. */}
          shared NASA key · 10 requests/hour · NASA_DONKI_API_KEY raises it
        </p>
      )}

      {progress.state === 'failed' && progress.error && (
        <p className={styles.error}>{progress.error} — resuming picks up where it stopped.</p>
      )}
      {progress.state === 'cancelled' && (
        <p className={styles.note}>cancelled · completed years were kept</p>
      )}

      <div className={styles.actions}>
        {running ? (
          <button
            type="button"
            id="donki-cancel"
            className={styles.button}
            onClick={() => {
              void window.terraPulse.solarEvents.cancel();
            }}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            id="donki-start"
            className={`${styles.button} ${styles.buttonPrimary}`}
            onClick={() => {
              void window.terraPulse.solarEvents.start();
            }}
          >
            {isEmpty(progress) ? 'Download' : 'Resume'}
          </button>
        )}
      </div>
    </div>
  );
}
