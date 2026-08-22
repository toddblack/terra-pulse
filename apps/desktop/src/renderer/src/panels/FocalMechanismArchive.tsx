import { useEffect, useState } from 'react';
import { GCMT_START_YEAR, type GcmtProgress } from '@terra-pulse/schema';
import styles from './ArchivePanel.module.css';

const IDLE: GcmtProgress = {
  state: 'idle',
  completedChunks: 0,
  totalChunks: 0,
  storedMechanisms: 0,
  currentChunk: null,
  pendingMonths: 0,
  error: null,
};

function describe(progress: GcmtProgress): string {
  if (progress.state === 'running') {
    return progress.currentChunk === null
      ? 'starting…'
      : `${progress.currentChunk} · ${String(progress.completedChunks)}/${String(progress.totalChunks)}`;
  }
  if (progress.storedMechanisms === 0) {
    return `fault orientations ${String(GCMT_START_YEAR)}–present`;
  }
  return `${progress.storedMechanisms.toLocaleString()} mechanisms · from ${String(GCMT_START_YEAR)}`;
}

/**
 * The Global CMT focal-mechanism backfill — the fault orientations H6 resolves
 * tidal stress onto, and the only source of them in this app.
 *
 * A fifth panel under `HistoricalDataPanel`'s disclosure, beside the earthquake
 * archive, space weather, DONKI and the GOES flare record. Holds its own state
 * rather than using the store, following `GoesFlareArchive` — nothing outside
 * this panel needs anything from this backfill.
 *
 * **Much cheaper than the panels beside it**: the whole 1976-onward record is a
 * single 8.8 MB request, against the GOES report's 21 and OMNI's 63. It is
 * still user-triggered, because every historical record here is, and because
 * "it's only 8.8 MB" is not a reason to start fetching archives on someone's
 * behalf at launch.
 *
 * **Why a completed download can leave months outstanding.** Global CMT
 * determines solutions on a three-to-four-month delay, so the most recent
 * monthly files do not exist yet. Those are counted and named rather than left
 * as a progress bar stuck short of full, which would read as a failure. H6
 * spans fifty years, so the missing tail changes nothing it can say.
 */
export function FocalMechanismArchive() {
  const [progress, setProgress] = useState<GcmtProgress>(IDLE);

  useEffect(() => {
    let cancelled = false;

    window.terraPulse.gcmt
      .status()
      .then((initial) => {
        if (!cancelled) setProgress(initial);
      })
      .catch((error: unknown) => {
        console.error('Could not read the focal-mechanism backfill status', error);
      });

    const unsubscribe = window.terraPulse.gcmt.onProgress(setProgress);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const inProgress = progress.state === 'running';
  const percent =
    progress.totalChunks === 0
      ? 0
      : Math.round((progress.completedChunks / progress.totalChunks) * 100);

  return (
    <div id="focal-mechanism-archive">
      {/* h4, not h2 — see the identical note in ArchivePanel.tsx. */}
      <h4 className={styles.heading}>Fault orientations</h4>
      <p className={styles.status}>{describe(progress)}</p>

      {inProgress && (
        <div
          className={styles.track}
          role="progressbar"
          aria-label="Fault orientation download progress"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={styles.fill} style={{ width: `${String(percent)}%` }} />
        </div>
      )}

      {progress.state === 'complete' && progress.pendingMonths > 0 && (
        <p className={styles.note}>
          {progress.pendingMonths === 1
            ? '1 recent month not published yet'
            : `${String(progress.pendingMonths)} recent months not published yet`}{' '}
          — Global CMT runs a few months behind.
        </p>
      )}

      {progress.state === 'failed' && progress.error && (
        <p className={styles.error}>{progress.error} — resuming picks up where it stopped.</p>
      )}
      {progress.state === 'cancelled' && (
        <p className={styles.note}>cancelled · what downloaded was kept</p>
      )}

      <div className={styles.actions}>
        {inProgress ? (
          <button
            type="button"
            id="gcmt-cancel"
            className={styles.button}
            onClick={() => {
              void window.terraPulse.gcmt.cancel();
            }}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            id="gcmt-start"
            className={`${styles.button} ${styles.buttonPrimary}`}
            onClick={() => {
              void window.terraPulse.gcmt.start();
            }}
          >
            {progress.storedMechanisms === 0 ? 'Download' : 'Resume'}
          </button>
        )}
      </div>
    </div>
  );
}
