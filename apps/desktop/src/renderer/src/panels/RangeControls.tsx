import { useEarthquakeStore } from '../state/useEarthquakeStore';
import styles from './RangeControls.module.css';

/**
 * Magnitude floors, annotated by what the merged catalogue actually contains.
 *
 * Measured on the USGS + EMSC merge (4-day sample), US share by floor:
 * M1+ 35% · M2+ 20% · M3+ 7% · M4+ 3%. Adding EMSC's national-agency
 * aggregation transformed this — USGS alone was 86% / 69% / 31% / 6%.
 *
 * The residual caveat is no longer "this is a US map". It is that small events
 * are only recorded where instrument networks are dense: an M2 in the mid-
 * Pacific is detected by nobody, and no aggregator fixes that. Completeness
 * becomes genuinely global around M4.5 — measured, USGS misses ~70% of what
 * EMSC reports between M4.0 and M4.5.
 *
 * Without the note, switching floors transforms the map with no explanation
 * and invites the wrong conclusion. See PROJECT_PLAN §5.3 and §10.
 */
const MAGNITUDE_OPTIONS: { value: number; label: string; note?: string }[] = [
  { value: 1, label: 'M1+', note: 'instrumented regions only' },
  { value: 2, label: 'M2+', note: 'instrumented regions only' },
  { value: 3, label: 'M3+', note: 'near-global' },
  { value: 4, label: 'M4+', note: 'near-global' },
  { value: 5, label: 'M5+', note: 'globally complete' },
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
