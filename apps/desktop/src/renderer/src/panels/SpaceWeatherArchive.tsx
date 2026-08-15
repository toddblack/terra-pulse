import { useEffect, useState } from 'react';
import {
  DST_START_YEAR,
  KP_START_YEAR,
  type SpaceWeatherProgress,
} from '@terra-pulse/schema';
import styles from './ArchivePanel.module.css';

/**
 * Stated before the click, like the earthquake archive's cost.
 *
 * Effectively all of it is Dst: sixty-three OMNI year-files at ~2.9 MB each.
 * Kp is one 5.5 MB request for ninety-four years, which is why the phases are
 * named separately below rather than shown as one bar.
 */
const EXPECTED_SIZE = '~184 MB';

const IDLE: SpaceWeatherProgress = {
  state: 'idle',
  phase: null,
  kpComplete: false,
  completedYears: 0,
  totalYears: 0,
  storedSamples: 0,
  currentYear: null,
  error: null,
};

/** Whether anything at all is stored, and therefore Download versus Resume. */
function isEmpty(progress: SpaceWeatherProgress): boolean {
  return !progress.kpComplete && progress.completedYears === 0;
}

function describe(progress: SpaceWeatherProgress): string {
  if (progress.state === 'running') {
    // The Kp phase has no year to report — it is a single request covering the
    // whole record — so it names itself instead of showing a stalled counter.
    if (progress.phase === 'kp') return `Kp ${String(KP_START_YEAR)}–present…`;
    return progress.currentYear === null
      ? 'starting…'
      : `Dst ${String(progress.currentYear)} · ${String(progress.completedYears)}/${String(progress.totalYears)} years`;
  }
  if (isEmpty(progress)) {
    return `Kp from ${String(KP_START_YEAR)}, Dst from ${String(DST_START_YEAR)}`;
  }
  // Kp and Dst reach back different distances, so a single "from YYYY" would be
  // wrong about one of them. Says what is actually held.
  const held = progress.kpComplete
    ? `Kp from ${String(KP_START_YEAR)}`
    : `Dst only, from ${String(DST_START_YEAR)}`;
  return `${progress.storedSamples.toLocaleString()} hours · ${held}`;
}

/**
 * The Kp/Dst backfill control.
 *
 * A sibling of the earthquake archive rather than part of it: they are separate
 * downloads with separate costs, and someone who wants a century of earthquakes
 * does not necessarily want 184 MB of space weather. Reuses the archive panel's
 * stylesheet because it is the same idiom, and a second visual language for the
 * same interaction would be noise.
 *
 * **The last week of Kp needs none of this** — it arrives from the rolling poll
 * and the track shows it immediately. This is only for the deep record.
 */
export function SpaceWeatherArchive() {
  const [progress, setProgress] = useState<SpaceWeatherProgress>(IDLE);

  useEffect(() => {
    let cancelled = false;

    void window.terraPulse.spaceWeather.status().then(
      (initial) => {
        if (!cancelled) setProgress(initial);
      },
      (error: unknown) => {
        console.error('Failed to read space-weather status', error);
      },
    );

    const unsubscribe = window.terraPulse.spaceWeather.onProgress(setProgress);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const running = progress.state === 'running';
  const percent =
    progress.totalYears === 0
      ? 0
      : Math.round((progress.completedYears / progress.totalYears) * 100);

  return (
    <div id="space-weather-archive" className={styles.panel}>
      <h2 className={styles.heading}>Geomagnetic history</h2>
      <p className={styles.status}>{describe(progress)}</p>

      {running && (
        <div
          className={styles.track}
          role="progressbar"
          aria-label="Geomagnetic history download progress"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={styles.fill} style={{ width: `${String(percent)}%` }} />
        </div>
      )}

      {!running && isEmpty(progress) && (
        <p className={styles.note}>
          {/* Solar wind rides the same OMNI files as Dst, so it adds nothing to
              the download — but it is worth naming, because it is the only
              reason someone with a complete Dst archive would run this again. */}
          hourly Kp from {KP_START_YEAR}, Dst and solar wind from {DST_START_YEAR} ·{' '}
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
          <button
            type="button"
            id="space-weather-cancel"
            className={styles.button}
            onClick={() => {
              void window.terraPulse.spaceWeather.cancel();
            }}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            id="space-weather-start"
            className={`${styles.button} ${styles.buttonPrimary}`}
            onClick={() => {
              void window.terraPulse.spaceWeather.start();
            }}
          >
            {isEmpty(progress) ? 'Download' : 'Resume'}
          </button>
        )}
      </div>
    </div>
  );
}
