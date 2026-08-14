import { useEarthquakeStore } from '../state/useEarthquakeStore';
import { useNow } from '../globe/useNow';
import styles from './LargeEventBanner.module.css';
import { formatAgoFrom } from './time-labels';

/**
 * Announces a large earthquake that has just arrived — PROJECT_PLAN §5.8.
 *
 * **Notification, not warning.** It reports something that already happened and
 * makes no forward claim. Early warning is impossible from this data source and
 * is recorded as rejected in §11.
 */

/** Coarse, because the poll runs every few minutes and precision would lie. */
function formatAge(timeUtc: string, nowMs: number): string {
  return formatAgoFrom(timeUtc, nowMs) ?? '';
}

export function LargeEventBanner() {
  const alert = useEarthquakeStore((state) => state.activeAlert);
  const dismissAlert = useEarthquakeStore((state) => state.dismissAlert);
  const select = useEarthquakeStore((state) => state.select);
  const nowMs = useNow();

  if (!alert) return null;

  return (
    <div id="large-event-banner" className={styles.banner} role="status" aria-live="polite">
      {/*
        Click to fly, rather than flying on arrival. The `focusRequest` nonce is
        the only thing that moves the camera, and an alert that yanked the view
        mid-investigation would break that — the M6 that lands while you are
        examining something else is exactly when it would hurt most.
      */}
      <button
        type="button"
        id="large-event-focus"
        className={styles.details}
        onClick={() => {
          select(alert.id);
          dismissAlert();
        }}
      >
        <span className={styles.magnitude}>M{alert.magnitude.toFixed(1)}</span>
        <span className={styles.place}>{alert.place}</span>
        <span className={styles.age}>{formatAge(alert.timeUtc, nowMs)}</span>
        <span className={styles.hint}>Show</span>
      </button>

      <button
        type="button"
        id="large-event-dismiss"
        className={styles.dismiss}
        aria-label="Dismiss alert"
        onClick={dismissAlert}
      >
        ×
      </button>
    </div>
  );
}
