import { useCallback, useEffect, useState } from 'react';
import {
  ARCHIVE_MIN_MAGNITUDE,
  ARCHIVE_START_YEAR,
  type ArchiveProgress,
} from '@terra-pulse/schema';
import styles from './ArchivePanel.module.css';

/**
 * The historical archive's download control — PROJECT_PLAN §Storage, Tier 1.
 *
 * Deliberately explicit about size before you commit to it. This is ~62 MB and
 * a few minutes of requests against a free public service, which is not
 * something to start without saying so.
 */

const EXPECTED_EVENTS = '~295,000';
const EXPECTED_SIZE = '~62 MB';

function formatCount(count: number): string {
  return count.toLocaleString();
}

/** Whether the last recorded year is the one before the current one. */
function isUpToDate(progress: ArchiveProgress): boolean {
  // The current year is never recorded complete — it's still accruing events —
  // so a finished archive sits one short of the total by design, not by
  // failure. Reporting "56 of 57" forever would look broken.
  return progress.completedChunks >= progress.totalChunks - 1;
}

function describe(progress: ArchiveProgress): string {
  if (progress.state === 'running') {
    const year = progress.currentYear;
    return year === null ? 'starting…' : `${String(year)} · ${formatCount(progress.storedEvents)} stored`;
  }
  if (progress.completedChunks === 0) return 'not downloaded';
  if (isUpToDate(progress)) {
    return `${String(ARCHIVE_START_YEAR)}–present · ${formatCount(progress.storedEvents)} events`;
  }
  return `${String(progress.completedChunks)} of ${String(progress.totalChunks)} years · ${formatCount(progress.storedEvents)} events`;
}

export function ArchivePanel() {
  const [progress, setProgress] = useState<ArchiveProgress | null>(null);

  useEffect(() => {
    window.terraPulse.archive
      .status()
      .then(setProgress)
      .catch((error: unknown) => {
        console.error('Could not read archive status', error);
      });

    return window.terraPulse.archive.onProgress(setProgress);
  }, []);

  const start = useCallback(() => {
    // Not awaited: this settles minutes later, and the panel follows the
    // progress stream instead. Errors surface through `progress.state`.
    void window.terraPulse.archive.start().catch((error: unknown) => {
      console.error('Archive backfill rejected', error);
    });
  }, []);

  const cancel = useCallback(() => {
    void window.terraPulse.archive.cancel().catch((error: unknown) => {
      console.error('Could not cancel the archive backfill', error);
    });
  }, []);

  // Nothing to show until main has answered — an empty shell that then jumps
  // to a filled one reads worse than appearing complete.
  if (!progress) return null;

  const running = progress.state === 'running';
  const percent =
    progress.totalChunks === 0
      ? 0
      : Math.round((progress.completedChunks / progress.totalChunks) * 100);

  return (
    <div id="archive-panel" className={styles.panel}>
      <h2 className={styles.heading}>Historical archive</h2>
      <p className={styles.status}>{describe(progress)}</p>

      {running && (
        <div
          className={styles.track}
          role="progressbar"
          aria-label="Archive download progress"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={styles.fill} style={{ width: `${String(percent)}%` }} />
        </div>
      )}

      {/* The cost is stated before the click, not after it. */}
      {!running && progress.completedChunks === 0 && (
        <p className={styles.note}>
          M{ARCHIVE_MIN_MAGNITUDE}+ from {ARCHIVE_START_YEAR} · {EXPECTED_EVENTS} events,{' '}
          {EXPECTED_SIZE}
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
          <button type="button" id="archive-cancel" className={styles.button} onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button
            type="button"
            id="archive-start"
            className={`${styles.button} ${styles.buttonPrimary}`}
            onClick={start}
          >
            {progress.completedChunks === 0
              ? 'Download'
              : isUpToDate(progress)
                ? 'Check for new'
                : 'Resume'}
          </button>
        )}
      </div>
    </div>
  );
}
