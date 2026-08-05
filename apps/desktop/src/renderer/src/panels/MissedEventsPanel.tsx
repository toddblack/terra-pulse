import { ALERT_MIN_MAGNITUDE } from '@terra-pulse/schema';
import { useEarthquakeStore } from '../state/useEarthquakeStore';
import { useNow } from '../globe/useNow';
import styles from './MissedEventsPanel.module.css';

/**
 * "What you missed" — the passive counterpart to the alert banner.
 *
 * Shown once per launch and dismissed for good. It makes no freshness claim:
 * these events are, by definition, ones that happened while nobody was looking.
 */

/** How long ago, at day resolution once past a day — precision would be noise. */
function formatWhen(timeUtc: string, nowMs: number): string {
  const ageMs = nowMs - Date.parse(timeUtc);
  if (!Number.isFinite(ageMs)) return '';

  const hours = Math.floor(ageMs / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${String(hours)}h ago`;

  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${String(days)} days ago`;
}

/** "since 3 days ago" reads better than an ISO timestamp nobody parses. */
function formatSince(sinceUtc: string, nowMs: number): string {
  return formatWhen(sinceUtc, nowMs).replace(' ago', '');
}

export function MissedEventsPanel() {
  const missed = useEarthquakeStore((state) => state.missedEvents);
  const dismiss = useEarthquakeStore((state) => state.dismissMissedEvents);
  const select = useEarthquakeStore((state) => state.select);
  const nowMs = useNow();

  if (!missed) return null;

  const trimmed = missed.totalCount - missed.events.length;

  return (
    <div id="missed-events" className={styles.panel}>
      <div className={styles.header}>
        <h2 className={styles.title}>
          While you were away · M{ALERT_MIN_MAGNITUDE}+ · last{' '}
          {formatSince(missed.sinceUtc, nowMs)}
        </h2>
        <button
          type="button"
          id="missed-events-close"
          className={styles.closeButton}
          aria-label="Dismiss"
          onClick={dismiss}
        >
          ×
        </button>
      </div>

      <ul className={styles.list}>
        {missed.events.map((event) => (
          <li key={event.id}>
            {/* Same click-to-fly contract as the alert banner: selecting parks a
                focusRequest, which is the only thing that moves the camera. */}
            <button
              type="button"
              className={styles.row}
              onClick={() => {
                select(event.id);
                dismiss();
              }}
            >
              <span className={styles.magnitude}>M{event.magnitude.toFixed(1)}</span>
              <span className={styles.place}>{event.place}</span>
              <span className={styles.when}>{formatWhen(event.timeUtc, nowMs)}</span>
            </button>
          </li>
        ))}
      </ul>

      {/* Ordered by magnitude, so what's trimmed is always the smallest — worth
          saying, or a reader might assume the list is chronological. */}
      {trimmed > 0 && (
        <p className={styles.note}>
          largest {String(missed.events.length)} of {String(missed.totalCount)} · {String(trimmed)}{' '}
          smaller not shown
        </p>
      )}
    </div>
  );
}
