import {
  EPHEMERIS_KERNEL_BYTES,
  EPHEMERIS_KERNEL_END_YEAR,
  EPHEMERIS_KERNEL_FILENAME,
  EPHEMERIS_KERNEL_START_YEAR,
  type EphemerisProgress,
} from '@terra-pulse/schema';
import styles from './AnalyzeShell.module.css';

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * H6's prerequisite: the JPL DE440 ephemeris kernel.
 *
 * ## Why this lives in Analyze and not beside the five archive panels
 *
 * Those are *historical records* — catalogues of things that happened, which
 * Explore draws. This is a **precondition for one test**, and nothing in
 * Explore reads it. Putting it under Explore's "Historical data" disclosure
 * would file it under a heading that does not describe it, in a mode that never
 * needs it, several clicks from the button it gates.
 *
 * ## It says the size before you press anything
 *
 * 31.2 MB is small next to the OMNI backfill's ~184 MB, but it is the only
 * download here that is a hard gate: without it H6 does not run at all, where a
 * partial earthquake archive merely narrows what the panel can claim. So the
 * cost is stated up front rather than discovered from a progress bar — the same
 * courtesy the archive panel extends, for a download that is more consequential
 * per byte.
 *
 * ## Absence is not an error state
 *
 * A missing kernel renders as a normal "not downloaded yet" card, not a
 * failure. Nothing is wrong with an install that has never run H6 — the same
 * posture the engine notice takes toward a missing Python, and the archive
 * panels take toward an empty database.
 */
export function EphemerisRequirement({ progress }: { progress: EphemerisProgress }) {
  const downloading = progress.state === 'running';
  const percent =
    progress.totalBytes === 0
      ? 0
      : Math.round((progress.downloadedBytes / progress.totalBytes) * 100);

  // Present and idle is the ordinary steady state once downloaded, and it needs
  // no card at all — a satisfied prerequisite is not news. Kept visible only
  // while it is unmet or actively changing.
  if (progress.present && !downloading) {
    return (
      <p className={styles.ephemerisSatisfied}>
        Ephemeris ready — JPL DE440 ({EPHEMERIS_KERNEL_FILENAME}),{' '}
        {String(EPHEMERIS_KERNEL_START_YEAR)}–{String(EPHEMERIS_KERNEL_END_YEAR)}.
      </p>
    );
  }

  return (
    <div className={styles.ephemerisCard}>
      <h3 className={styles.sectionHeading}>Ephemeris required</h3>
      <p className={styles.ephemerisBody}>
        H6 resolves tidal stress from JPL <strong>DE440</strong> planetary and lunar positions.
        The kernel is <strong>{megabytes(EPHEMERIS_KERNEL_BYTES)}</strong>, covers{' '}
        {String(EPHEMERIS_KERNEL_START_YEAR)}–{String(EPHEMERIS_KERNEL_END_YEAR)}, and is
        downloaded once — it is not bundled with the app because nothing outside this test uses
        it.
      </p>

      {downloading && (
        <>
          <div
            className={styles.track}
            role="progressbar"
            aria-label="Ephemeris kernel download progress"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className={styles.fill} style={{ width: `${String(percent)}%` }} />
          </div>
          <p className={styles.ephemerisStatus}>
            {megabytes(progress.downloadedBytes)} of {megabytes(progress.totalBytes)} ·{' '}
            {String(percent)}%
          </p>
        </>
      )}

      {progress.state === 'failed' && progress.error && (
        <p className={styles.error}>{progress.error} — resuming picks up where it stopped.</p>
      )}
      {progress.state === 'cancelled' && (
        <p className={styles.ephemerisStatus}>
          cancelled · what downloaded was kept, so resuming continues rather than restarting
        </p>
      )}

      {downloading ? (
        <button
          type="button"
          id="ephemeris-cancel"
          className={styles.ephemerisButton}
          onClick={() => {
            void window.terraPulse.ephemeris.cancel();
          }}
        >
          Cancel
        </button>
      ) : (
        <button
          type="button"
          id="ephemeris-start"
          className={styles.ephemerisButton}
          onClick={() => {
            void window.terraPulse.ephemeris.start();
          }}
        >
          {progress.downloadedBytes > 0 ? 'Resume download' : 'Download'}
        </button>
      )}
    </div>
  );
}
