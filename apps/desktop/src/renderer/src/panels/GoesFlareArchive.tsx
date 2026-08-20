import { useEffect, useState } from 'react';
import {
  GOES_FLARE_LAST_YEAR,
  GOES_FLARE_START_YEAR,
  type GoesFlareProgress,
} from '@terra-pulse/schema';
import styles from './ArchivePanel.module.css';

const IDLE: GoesFlareProgress = {
  state: 'idle',
  completedChunks: 0,
  totalChunks: 0,
  storedFlares: 0,
  currentYear: null,
  error: null,
};

function describe(progress: GoesFlareProgress): string {
  if (progress.state === 'running') {
    return progress.currentYear === null
      ? 'starting…'
      : `${String(progress.currentYear)} · ${String(progress.completedChunks)}/${String(progress.totalChunks)}`;
  }
  if (progress.storedFlares === 0) {
    return `flares ${String(GOES_FLARE_START_YEAR)}–${String(GOES_FLARE_LAST_YEAR)}`;
  }
  return `${progress.storedFlares.toLocaleString()} flares · ${String(progress.completedChunks)}/${String(progress.totalChunks)} years`;
}

/**
 * The NOAA GOES XRS flare backfill — the deep half of the flare record, and the
 * half H1b is registered against below 2017.
 *
 * A fourth panel under `HistoricalDataPanel`'s single disclosure, beside the
 * earthquake archive, space weather and DONKI. Independent of all three:
 * separate source, separate download, separate failure mode.
 *
 * **Holds its own state rather than using the store**, unlike `DonkiArchive`.
 * That panel shares `donkiProgress` because `LayerPanel` also needs its
 * `hasApiKey` to gate two layer toggles. Nothing outside this panel needs
 * anything from this backfill, so it follows the simpler `ArchivePanel` idiom
 * — one subscription, local state, no store entry.
 *
 * **Why it is a download rather than automatic**: 21 requests and ~2.7 MB is
 * cheap enough to argue either way, but every other historical record in this
 * app is user-triggered, and fetching a thirty-year archive on someone's behalf
 * at launch is not a thing to start doing quietly.
 */
export function GoesFlareArchive() {
  const [progress, setProgress] = useState<GoesFlareProgress>(IDLE);

  useEffect(() => {
    let cancelled = false;

    window.terraPulse.goesFlares
      .status()
      .then((initial) => {
        if (!cancelled) setProgress(initial);
      })
      .catch((error: unknown) => {
        console.error('Could not read the GOES flare backfill status', error);
      });

    const unsubscribe = window.terraPulse.goesFlares.onProgress(setProgress);
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
    <div id="goes-flare-archive">
      {/* h4, not h2 — see the identical note in ArchivePanel.tsx. */}
      <h4 className={styles.heading}>Deep flare history</h4>
      <p className={styles.status}>{describe(progress)}</p>

      {inProgress && (
        <div
          className={styles.track}
          role="progressbar"
          aria-label="Deep flare history download progress"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={styles.fill} style={{ width: `${String(percent)}%` }} />
        </div>
      )}

      {progress.state === 'failed' && progress.error && (
        <p className={styles.error}>{progress.error} — resuming picks up where it stopped.</p>
      )}
      {progress.state === 'cancelled' && (
        <p className={styles.note}>cancelled · completed years were kept</p>
      )}

      <div className={styles.actions}>
        {inProgress ? (
          <button
            type="button"
            id="goes-flares-cancel"
            className={styles.button}
            onClick={() => {
              void window.terraPulse.goesFlares.cancel();
            }}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            id="goes-flares-start"
            className={`${styles.button} ${styles.buttonPrimary}`}
            onClick={() => {
              void window.terraPulse.goesFlares.start();
            }}
          >
            {progress.storedFlares === 0 ? 'Download' : 'Resume'}
          </button>
        )}
      </div>
    </div>
  );
}
