import { DONKI_START_YEAR, type DonkiProgress } from '@terra-pulse/schema';
import { useGlobeStore } from '../state/useGlobeStore';
import { useNow } from '../globe/useNow';
import { formatDuration } from './time-labels';
import styles from './ArchivePanel.module.css';

/** Whether anything at all is stored, and therefore Download versus Resume. */
function isEmpty(progress: DonkiProgress): boolean {
  return progress.storedFlares === 0 && progress.storedCmeArrivals === 0;
}

function describe(progress: DonkiProgress, nowMs: number): string {
  if (progress.state === 'running') {
    const label = progress.phase === 'cme' ? 'CME arrivals' : 'flares';
    return progress.currentYear === null
      ? 'starting…'
      : `${label} ${String(progress.currentYear)} · ${String(progress.completedChunks)}/${String(progress.totalChunks)}`;
  }
  if (progress.state === 'waiting') {
    const retryAtMs = progress.retryAtUtc === null ? NaN : Date.parse(progress.retryAtUtc);
    return Number.isFinite(retryAtMs)
      ? `rate limited · resumes in ${formatDuration(Math.max(0, retryAtMs - nowMs))}`
      : 'rate limited · waiting to resume';
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
 *
 * Reads `donkiProgress` from the store rather than holding its own state —
 * `LayerPanel` needs `hasApiKey` too, to gate the solar-flares/CME-arrivals
 * toggles, so both are fed by one subscription (`useDonkiStatus`, called once
 * in `App.tsx`) instead of two.
 */
export function DonkiArchive() {
  const progress = useGlobeStore((state) => state.donkiProgress);
  const openDonkiKeyModal = useGlobeStore((state) => state.openDonkiKeyModal);
  // Wall clock, for the 'waiting' countdown — same basis as the rest of the
  // app's relative-time labels.
  const nowMs = useNow();

  // Cancel must stay available through 'waiting', not just 'running' — a
  // rate-limited pause is not a stopped backfill.
  const inProgress = progress.state === 'running' || progress.state === 'waiting';
  const percent =
    progress.totalChunks === 0
      ? 0
      : Math.round((progress.completedChunks / progress.totalChunks) * 100);

  return (
    <div id="donki-archive">
      {/* h4, not h2 — see the identical note in ArchivePanel.tsx. */}
      <h4 className={styles.heading}>Solar event history</h4>
      <p className={styles.status}>{describe(progress, nowMs)}</p>

      {inProgress && (
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

      {!inProgress && !progress.hasApiKey && (
        <p className={styles.note}>needs a free NASA API key</p>
      )}
      {progress.state === 'waiting' && (
        <p className={styles.note}>
          NASA’s rate limit was hit — resuming automatically, no action needed.
        </p>
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
              if (progress.hasApiKey) {
                void window.terraPulse.solarEvents.start();
              } else {
                openDonkiKeyModal({ kind: 'download' });
              }
            }}
          >
            {isEmpty(progress) ? 'Download' : 'Resume'}
          </button>
        )}
      </div>
    </div>
  );
}
