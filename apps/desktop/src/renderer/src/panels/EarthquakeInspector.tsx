import { antipodeOf, formatLatLon } from '../layers/antipode';
import { useEarthquakeStore, selectEventById } from '../state/useEarthquakeStore';
import { useGlobeStore, selectBackdropTone } from '../state/useGlobeStore';
import { depthClass, depthColorHex } from '../layers/earthquake-encoding';
import { AftershockSequenceSection } from './AftershockSequence';
import { NearestFaultSection } from './NearestFault';
import { RegionalRecurrenceSection } from './RegionalRecurrence';
import { hasSequencePanel } from './useAftershockSequence';
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
  const showAntipode = useEarthquakeStore((state) => state.showAntipode);
  const hideAntipode = useEarthquakeStore((state) => state.hideAntipode);
  const antipodeEventId = useEarthquakeStore((state) => state.antipodeEventId);
  const antipodeActive = event !== null && antipodeEventId === event.id;

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
            {/* Said outright rather than shown as a blank or a zero. This is
                the one place the reader can find out *why* a mark is grey, and
                "0.0 km" would be a claim the catalogue never made. */}
            <dd className={styles.value}>
              {event.depthKm === null ? (
                <>
                  not reported
                  <span className={styles.subValue}>depth unknown for this event</span>
                </>
              ) : (
                <>
                  {event.depthKm.toFixed(1)} km
                  <span className={styles.subValue}>{depthClass(event.depthKm)}</span>
                </>
              )}
            </dd>
          </div>

          <div className={styles.field}>
            <dt className={styles.term}>Coordinates</dt>
            <dd className={styles.value}>
              {formatCoordinate(event.latitude, 'N', 'S')},{' '}
              {formatCoordinate(event.longitude, 'E', 'W')}
            </dd>
          </div>

          {event.significance !== null && (
            <div className={styles.field}>
              <dt className={styles.term}>Significance</dt>
              <dd className={styles.value}>{event.significance}</dd>
            </div>
          )}

          {event.status !== null && (
            <div className={styles.field}>
              <dt className={styles.term}>Review status</dt>
              <dd className={styles.value}>{event.status}</dd>
            </div>
          )}

          <div className={styles.field}>
            <dt className={styles.term}>Source</dt>
            <dd className={styles.value}>
              {event.source === 'usgs' ? 'USGS' : 'EMSC'}
              <span className={styles.subValue}>
                {event.source === 'usgs' ? 'global network' : 'national agencies'}
              </span>
            </dd>
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

        {/* Observation, not forecast: what the catalogue actually recorded
            after this event. Offered from M5 up (§5.9) — below that the
            Gardner-Knopoff window is smaller than the catalogue's own floor can
            usefully fill. */}
        {hasSequencePanel(event) && <AftershockSequenceSection event={event} />}

        {/* What's mapped where this happened. Reports the nearest trace and its
            distance; it does not claim the event was on it — see the note in
            NearestFault.tsx for why that distinction is load-bearing. */}
        <NearestFaultSection point={event} depthKm={event.depthKm} />

        {/* How often this happens around here, from the catalogue. Descriptive
            only — it never says a region is due. See RegionalRecurrence.tsx. */}
        <RegionalRecurrenceSection point={event} />


        {/* The antipode is pure geometry — the point opposite on a sphere — so
            it is offered for any event and stated as a coordinate, not as a
            finding. Whether antipodal focusing does anything is a Phase 4
            question that needs a completeness map (PROJECT_PLAN §5.3). */}
        {antipodeActive && (
          <p className={styles.antipodeNote}>
            antipode:{' '}
            {formatLatLon(antipodeOf({ latitude: event.latitude, longitude: event.longitude }))}
          </p>
        )}

        <div className={styles.actions}>
          <button
            id="inspector-antipode"
            type="button"
            aria-pressed={antipodeActive}
            className={
              antipodeActive
                ? `${styles.actionButton} ${styles.actionButtonActive}`
                : styles.actionButton
            }
            onClick={() => {
              if (antipodeActive) hideAntipode();
              else showAntipode(event.id);
            }}
          >
            {antipodeActive ? 'Exit antipode' : 'Antipode'}
          </button>
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
          {event.source === 'usgs' && (
            <button
              id="inspector-usgs-link"
              type="button"
              className={styles.actionButton}
              onClick={openUsgsPage}
            >
              USGS page ↗
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
