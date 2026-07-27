import { useEarthquakeStore, selectEventById } from '../state/useEarthquakeStore';
import { useGlobeStore, selectBackdropTone } from '../state/useGlobeStore';
import { depthClass, depthColorHex } from '../layers/earthquake-encoding';
import styles from './EarthquakeInspector.module.css';

function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

function formatLocal(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { timeZoneName: 'short' });
}

function formatCoordinate(value: number, positive: string, negative: string): string {
  return `${Math.abs(value).toFixed(4)}° ${value >= 0 ? positive : negative}`;
}

export function EarthquakeInspector() {
  const backdropTone = useGlobeStore(selectBackdropTone);
  const selectedEventId = useEarthquakeStore((state) => state.selectedEventId);
  const event = useEarthquakeStore((state) => selectEventById(state, state.selectedEventId));
  const select = useEarthquakeStore((state) => state.select);
  const requestFocus = useEarthquakeStore((state) => state.requestFocus);

  if (selectedEventId === null || event === null) return null;

  const openUsgsPage = () => {
    void window.terraPulse.shell.openExternal(event.url);
  };

  return (
    <aside id="earthquake-inspector" className={styles.inspector}>
      <div className={styles.scrollArea}>
        <header className={styles.header}>
          <div className={styles.magnitudeBlock}>
            <span
              className={styles.depthSwatch}
              style={{ backgroundColor: depthColorHex(event.depthKm, backdropTone) }}
              aria-hidden="true"
            />
            <span className={styles.magnitude}>M{event.magnitude.toFixed(1)}</span>
            {/* Magnitude types are not interchangeable — mb, mww, ml and md
                are measured differently, so the panel always says which. */}
            <span className={styles.magnitudeType}>{event.magnitudeType}</span>
          </div>
          <button
            id="inspector-close"
            type="button"
            className={styles.closeButton}
            onClick={() => select(null)}
            aria-label="Close inspector"
          >
            ×
          </button>
        </header>

        <p className={styles.place}>{event.place}</p>

        <dl className={styles.fieldList}>
          <div className={styles.field}>
            <dt className={styles.term}>Origin time</dt>
            <dd className={styles.value}>
              {formatUtc(event.timeUtc)}
              <span className={styles.subValue}>{formatLocal(event.timeUtc)}</span>
            </dd>
          </div>

          <div className={styles.field}>
            <dt className={styles.term}>Depth</dt>
            <dd className={styles.value}>
              {event.depthKm.toFixed(1)} km
              <span className={styles.subValue}>{depthClass(event.depthKm)}</span>
            </dd>
          </div>

          <div className={styles.field}>
            <dt className={styles.term}>Coordinates</dt>
            <dd className={styles.value}>
              {formatCoordinate(event.latitude, 'N', 'S')},{' '}
              {formatCoordinate(event.longitude, 'E', 'W')}
            </dd>
          </div>

          <div className={styles.field}>
            <dt className={styles.term}>Significance</dt>
            <dd className={styles.value}>{event.significance}</dd>
          </div>

          <div className={styles.field}>
            <dt className={styles.term}>Review status</dt>
            <dd className={styles.value}>{event.status}</dd>
          </div>

          {event.alertLevel !== null && (
            <div className={styles.field}>
              <dt className={styles.term}>PAGER alert</dt>
              <dd className={styles.value}>
                <span className={styles.alertLabel} data-alert={event.alertLevel}>
                  {event.alertLevel}
                </span>
                <span className={styles.subValue}>USGS modelled impact</span>
              </dd>
            </div>
          )}

          {event.tsunami && (
            <div className={styles.field}>
              <dt className={styles.term}>Tsunami</dt>
              <dd className={styles.value}>flagged by USGS</dd>
            </div>
          )}
        </dl>

        <div className={styles.actions}>
          <button
            id="inspector-recenter"
            type="button"
            className={styles.actionButton}
            onClick={() => requestFocus(event.id)}
          >
            Recenter
          </button>
          {/* Not an <a href> — that would navigate the Electron window itself.
              Goes through main, which validates the URL and hands it to the OS. */}
          <button
            id="inspector-usgs-link"
            type="button"
            className={styles.actionButton}
            onClick={openUsgsPage}
          >
            USGS page ↗
          </button>
        </div>
      </div>
    </aside>
  );
}
