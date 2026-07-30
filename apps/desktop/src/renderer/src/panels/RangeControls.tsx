import {
  COVERAGE_TIERS,
  magnitudeFloorsForWindow,
  minMagnitudeForWindow,
  nextMagnitudeFloorAbove,
} from '@terra-pulse/schema';
import { useEarthquakeStore } from '../state/useEarthquakeStore';
import styles from './RangeControls.module.css';

/**
 * What each magnitude floor actually means for coverage.
 *
 * Measured on the USGS + EMSC merge, US share by floor: M1+ 35% · M2.5+ ~15% ·
 * M4.5+ ~3%. Adding EMSC's national-agency aggregation transformed this — USGS
 * alone was 86% at M1+ and 6% at M4+.
 *
 * The residual caveat is no longer "this is a US map". It is that small events
 * are only recorded where instrument networks are dense: an M2 in the mid-
 * Pacific is detected by nobody, and no aggregator fixes that. Completeness
 * becomes genuinely global around M4.5 — measured, USGS misses ~70% of what
 * EMSC reports between M4.0 and M4.5. M5.5 is the only floor whose global count
 * has held steady since 1970, which is why it's here at all.
 *
 * Without the note, switching floors transforms the map with no explanation
 * and invites the wrong conclusion. See PROJECT_PLAN §5.3 and §10.
 */
const COVERAGE_NOTES: Record<number, string> = {
  1: 'instrumented regions only',
  2.5: 'instrumented regions only',
  4.5: 'globally complete',
  5.5: 'globally complete · steady since 1970',
};

/** "M4.5" rather than "M4.5000000001" — floors include half steps. */
function formatMagnitude(magnitude: number): string {
  return `M${Number.isInteger(magnitude) ? magnitude : magnitude.toFixed(1)}`;
}

/** "M4.5+" for a floor, "M1–2.5" for an isolated band. */
export function formatRange(minMagnitude: number, isolateBand: boolean): string {
  const ceiling = isolateBand ? nextMagnitudeFloorAbove(minMagnitude) : null;
  if (ceiling === null) return `${formatMagnitude(minMagnitude)}+`;
  return `${formatMagnitude(minMagnitude)}–${ceiling.toFixed(1)}`;
}

export function RangeControls() {
  const minMagnitude = useEarthquakeStore((state) => state.minMagnitude);
  const setMinMagnitude = useEarthquakeStore((state) => state.setMinMagnitude);
  const windowHours = useEarthquakeStore((state) => state.windowHours);
  const setWindowHours = useEarthquakeStore((state) => state.setWindowHours);

  const isolateBand = useEarthquakeStore((state) => state.isolateBand);
  const setIsolateBand = useEarthquakeStore((state) => state.setIsolateBand);

  const activeNote = COVERAGE_NOTES[minMagnitude];
  const bandCeiling = nextMagnitudeFloorAbove(minMagnitude);
  // Only the floors this span was actually ingested at. Offering more would
  // mean offering an empty globe that looks like a quiet month.
  const availableFloors = magnitudeFloorsForWindow(windowHours);
  const spanFloor = minMagnitudeForWindow(windowHours);

  return (
    <div id="range-controls" className={styles.panel}>
      <div className={styles.group}>
        <h2 className={styles.heading}>Magnitude</h2>
        <div className={styles.buttonRow} role="group" aria-label="Minimum magnitude">
          {availableFloors.map((floor) => (
            <button
              key={floor}
              id={`magnitude-option-${floor}`}
              type="button"
              aria-pressed={minMagnitude === floor}
              onClick={() => setMinMagnitude(floor)}
              className={
                minMagnitude === floor
                  ? `${styles.button} ${styles.buttonActive}`
                  : styles.button
              }
            >
              {formatMagnitude(floor)}+
            </button>
          ))}
        </div>

        {/* Only offered where there is something above to hide. At the top
            floor the control would be a no-op that looks like it does something. */}
        {bandCeiling !== null && (
          <label className={styles.toggle}>
            <input
              id="isolate-band"
              type="checkbox"
              className={styles.checkbox}
              checked={isolateBand}
              onChange={(event) => setIsolateBand(event.target.checked)}
            />
            <span>
              only {formatRange(minMagnitude, true)}
            </span>
          </label>
        )}

        {activeNote && <p className={styles.note}>coverage: {activeNote}</p>}
        {/* Hiding the largest events is exactly the sort of thing that should
            never be quietly in effect — say so while it is. */}
        {isolateBand && bandCeiling !== null && (
          <p className={styles.warning}>
            hiding {formatMagnitude(bandCeiling)}+
          </p>
        )}
        {/* Say why the smaller floors vanished, or their disappearance reads as
            a bug rather than a limit of what was fetched. */}
        {spanFloor > 1 && (
          <p className={styles.note}>
            below {formatMagnitude(spanFloor)}+ not stored this far back
          </p>
        )}
      </div>

      <div className={styles.group}>
        <h2 className={styles.heading}>Window</h2>
        <div className={styles.buttonRow} role="group" aria-label="Time window">
          {COVERAGE_TIERS.map((tier) => (
            <button
              key={tier.windowHours}
              id={`window-option-${tier.windowHours}`}
              type="button"
              aria-pressed={windowHours === tier.windowHours}
              onClick={() => setWindowHours(tier.windowHours)}
              className={
                windowHours === tier.windowHours
                  ? `${styles.button} ${styles.buttonActive}`
                  : styles.button
              }
            >
              {tier.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
