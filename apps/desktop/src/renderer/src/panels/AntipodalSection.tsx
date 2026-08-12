import {
  backgroundIntervalDays,
  type AntipodalWindow,
  type EarthquakeEvent,
} from '@terra-pulse/schema';
import { formatLatLon } from '../layers/antipode';
import { useAntipodal } from './useAntipodal';
import styles from './AntipodalSection.module.css';

export { hasAntipodalPanel } from './useAntipodal';

function hours(value: number): string {
  if (value < 1) return `${Math.round(value * 60)} min`;
  if (value < 48) return `${value.toFixed(1)} h`;
  return `${(value / 24).toFixed(1)} d`;
}

/**
 * What the catalogue recorded near this event's antipode — PROJECT_PLAN §5.3,
 * the observational half of hypothesis H5.
 *
 * ## The background rate is the point, not a footnote
 *
 * A bare list of "events near the antipode" is a coincidence generator. The case
 * that prompted this panel: a Colombia M7.4 followed 4.6 h later by a Sumatra
 * M5.1, only 197 km from its antipode. Striking — until you learn that patch of
 * Sumatra produces an M5+ **every 34 days regardless**, because South America
 * and Indonesia are both highly seismic *and* antipodal to one another.
 *
 * So the rate is displayed with equal weight to the finding. Anything less and
 * the panel argues for triggering by omission.
 *
 * No probability is printed. A rate is a description; "p = 0.03" would be a
 * significance claim, and Explore mode does not make those (non-negotiable #1).
 * The registered H5 test — declustered, completeness-weighted, KS against the
 * null — is an Analyze job and is not this.
 */
export function AntipodalBody({ event }: { event: EarthquakeEvent }) {
  const state = useAntipodal(event);
  // Same as the sequence panel: the inspector already gates on eligibility, so
  // this is defensive rather than a state anyone should see.
  if (state.status === 'idle') return null;

  return (
    <>
      {state.status === 'loading' && <p className={styles.note}>reading catalogue…</p>}
      {state.status === 'error' && <p className={styles.note}>couldn&rsquo;t read the antipode</p>}
      {state.status === 'ready' && <Body window={state.window} />}
    </>
  );
}

function Body({ window: result }: { window: AntipodalWindow }) {
  const interval = backgroundIntervalDays(result);
  const stillRunning = result.elapsedFraction < 1;

  return (
    <>
      <p className={styles.coordinate}>
        {formatLatLon(result.antipode)}
        <span className={styles.sub}>
          M{result.minMagnitude}+ within {result.searchKm} km, {result.windowHours} h after
        </span>
      </p>

      {/* Stated before the result, deliberately. A reader who sees the hit first
          has already formed an impression by the time they reach the rate. */}
      <p className={styles.background}>
        {result.backgroundSilent ? (
          <>
            No M{result.minMagnitude}+ has <em>ever</em> been recorded within {result.searchKm} km
            of here
            <span className={styles.sub}>
              so an absence below means very little — roughly a third of antipodes fall in
              seismically quiet ocean, where sparse coverage and real quiet look the same
            </span>
          </>
        ) : (
          <>
            This area produces one anyway about every{' '}
            <strong>{interval === null ? '—' : Math.round(interval).toLocaleString()} days</strong>
            <span className={styles.sub}>
              measured over {Math.round(result.backgroundYears)} years at the same radius and
              magnitude — the number to judge anything below against
            </span>
          </>
        )}
      </p>

      {result.events.length === 0 ? (
        <p className={styles.value}>nothing recorded in the window</p>
      ) : (
        <ul className={styles.list}>
          {result.events.map(({ event, distanceKm, delayHours }) => (
            <li key={event.id} className={styles.row}>
              <span className={styles.rowMag}>M{event.magnitude.toFixed(1)}</span>
              <span className={styles.rowDistance}>{Math.round(distanceKm)} km</span>
              <span className={styles.rowDelay}>+{hours(delayHours)}</span>
              <span className={styles.rowPlace}>{event.place}</span>
            </li>
          ))}
        </ul>
      )}

      {stillRunning && (
        <p className={styles.caveat}>
          Window still open — {Math.round(result.elapsedFraction * 100)}% of {result.windowHours} h
          elapsed.
        </p>
      )}

      {/* The rings are for reading a list, not for deciding anything. §5.3 keeps
          the registered test radius-free precisely so no constant has to be
          guessed, and repeating that here stops the 1000 km figure above
          hardening into a threshold in the reader's head. */}
      <p className={styles.footnote}>
        Observation only — proximity is not evidence of triggering. Hypothesis H5 tests this
        properly, with declustering and a completeness-weighted null; the radius above is for
        readability and carries no statistical meaning.
      </p>
    </>
  );
}
