import { useEarthquakeStore } from '../state/useEarthquakeStore';
import styles from './RangeControls.module.css';

/**
 * Magnitude floors, annotated by what the catalogue actually contains there.
 *
 * Measured against the USGS global feed (14 days): 86% of M1+ events are in
 * the United States, 69% at M2+, 31% at M3+ — but only 6% at M4+. That isn't
 * geology, it's instrumentation: dense networks exist in the US, while an
 * identical M2 off Vanuatu is invisible to a global network and lands only in
 * a national catalogue this app doesn't ingest.
 *
 * Without the note, switching M3+ → M4+ transforms the map with no explanation
 * and invites exactly the wrong conclusion. See PROJECT_PLAN §5.3 and §10.
 */
const MAGNITUDE_OPTIONS: { value: number; label: string; note?: string }[] = [
  { value: 1, label: 'M1+', note: 'US networks' },
  { value: 2, label: 'M2+', note: 'US networks' },
  { value: 3, label: 'M3+', note: 'mostly US' },
  { value: 4, label: 'M4+', note: 'global' },
  { value: 5, label: 'M5+', note: 'global' },
];

const WINDOW_OPTIONS: { value: number; label: string }[] = [
  { value: 24, label: '24h' },
  { value: 48, label: '48h' },
  { value: 72, label: '72h' },
  { value: 96, label: '4d' },
];

export function RangeControls() {
  const minMagnitude = useEarthquakeStore((state) => state.minMagnitude);
  const setMinMagnitude = useEarthquakeStore((state) => state.setMinMagnitude);
  const windowHours = useEarthquakeStore((state) => state.windowHours);
  const setWindowHours = useEarthquakeStore((state) => state.setWindowHours);

  const activeNote = MAGNITUDE_OPTIONS.find((option) => option.value === minMagnitude)?.note;

  return (
    <div id="range-controls" className={styles.panel}>
      <div className={styles.group}>
        <h2 className={styles.heading}>Magnitude</h2>
        <div className={styles.buttonRow} role="group" aria-label="Minimum magnitude">
          {MAGNITUDE_OPTIONS.map((option) => (
            <button
              key={option.value}
              id={`magnitude-option-${option.value}`}
              type="button"
              aria-pressed={minMagnitude === option.value}
              onClick={() => setMinMagnitude(option.value)}
              className={
                minMagnitude === option.value
                  ? `${styles.button} ${styles.buttonActive}`
                  : styles.button
              }
            >
              {option.label}
            </button>
          ))}
        </div>
        {activeNote && <p className={styles.note}>coverage: {activeNote}</p>}
      </div>

      <div className={styles.group}>
        <h2 className={styles.heading}>Window</h2>
        <div className={styles.buttonRow} role="group" aria-label="Time window">
          {WINDOW_OPTIONS.map((option) => (
            <button
              key={option.value}
              id={`window-option-${option.value}`}
              type="button"
              aria-pressed={windowHours === option.value}
              onClick={() => setWindowHours(option.value)}
              className={
                windowHours === option.value
                  ? `${styles.button} ${styles.buttonActive}`
                  : styles.button
              }
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
