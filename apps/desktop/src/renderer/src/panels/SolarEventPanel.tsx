import type { CmeArrival, SolarFlare } from '@terra-pulse/schema';
import { isDirectImpact } from '@terra-pulse/schema';
import { useGlobeStore } from '../state/useGlobeStore';
import { useNow } from '../globe/useNow';
import { formatAgoFrom } from './time-labels';
import styles from './SolarEventPanel.module.css';

function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/**
 * Everything known about one clicked flare or CME-arrival marker.
 *
 * Deliberately not folded into `LocationPanel`: these markers sit at the
 * subsolar point, not at a place a reader pointed at — see
 * `SolarEventSelection`'s own doc in `useGlobeStore.ts` for why that rules out
 * reusing the coordinate-driven panel (it would run a fault/recurrence lookup
 * against wherever the Sun happened to be overhead, which answers nothing).
 *
 * No link out to DONKI's own record — `main/ipc/external-links.ts`'s
 * allowlist covers `api.nasa.gov`, but the `link` field these payloads carry
 * points at `webtools.ccmc.gsfc.nasa.gov`, a different host. Widening the
 * allowlist for one field in a brand-new panel is its own decision; left out
 * rather than shipping a button that silently does nothing.
 */
export function SolarEventPanel() {
  const selection = useGlobeStore((state) => state.selectedSolarEvent);
  const selectSolarEvent = useGlobeStore((state) => state.selectSolarEvent);
  const nowMs = useNow();

  if (selection === null) return null;

  const close = () => {
    selectSolarEvent(null);
  };

  return (
    <aside className={styles.panel} aria-labelledby="solar-event-heading">
      <header className={styles.header}>
        <h2 id="solar-event-heading" className={styles.kind}>
          {selection.kind === 'flare' ? 'Solar flare' : 'CME arrival'}
        </h2>
        <button type="button" className={styles.closeButton} onClick={close} aria-label="Close">
          ×
        </button>
      </header>

      <div className={styles.body}>
        {selection.kind === 'flare' ? (
          <FlareDetail flare={selection.flare} nowMs={nowMs} />
        ) : (
          <CmeArrivalDetail arrival={selection.arrival} nowMs={nowMs} />
        )}
      </div>
    </aside>
  );
}

function FlareDetail({ flare, nowMs }: { flare: SolarFlare; nowMs: number }) {
  const age = formatAgoFrom(flare.peakTimeUtc, nowMs);

  return (
    <section className={styles.section}>
      <p className={styles.name}>{flare.classType} flare</p>

      <dl className={styles.fields}>
        <div className={styles.field}>
          <dt className={styles.term}>Peak time</dt>
          <dd className={styles.value}>
            {formatUtc(flare.peakTimeUtc)}
            {age !== null && <span className={styles.sub}>{age}</span>}
          </dd>
        </div>
        {flare.activeRegionNumber !== null && (
          <div className={styles.field}>
            <dt className={styles.term}>Active region</dt>
            <dd className={styles.value}>AR{flare.activeRegionNumber}</dd>
          </div>
        )}
        {flare.sourceLocation !== null && (
          <div className={styles.field}>
            <dt className={styles.term}>Source location</dt>
            <dd className={styles.value}>{flare.sourceLocation}</dd>
          </div>
        )}
      </dl>

      <p className={styles.footnote}>
        Marked at the subsolar point at peak time — where the Sun was directly overhead, not a
        location on the ground. NASA DONKI /FLR.
      </p>
    </section>
  );
}

function CmeArrivalDetail({ arrival, nowMs }: { arrival: CmeArrival; nowMs: number }) {
  const age = formatAgoFrom(arrival.arrivalTimeUtc, nowMs);
  const kind = isDirectImpact(arrival)
    ? 'Direct impact'
    : arrival.minorImpact
      ? 'Minor impact'
      : 'Glancing blow';

  return (
    <section className={styles.section}>
      <p className={styles.name}>{kind}</p>

      <dl className={styles.fields}>
        <div className={styles.field}>
          <dt className={styles.term}>Predicted arrival</dt>
          <dd className={styles.value}>
            {formatUtc(arrival.arrivalTimeUtc)}
            {age !== null && <span className={styles.sub}>{age}</span>}
          </dd>
        </div>
        <div className={styles.field}>
          <dt className={styles.term}>Predicted Kp</dt>
          {/* Null means the model run produced no estimate at all, not that it
              predicted zero — stated in words rather than as "Kp 0". */}
          <dd className={styles.value}>
            {arrival.predictedKp === null ? 'not estimated' : arrival.predictedKp}
          </dd>
        </div>
      </dl>

      <p className={styles.footnote}>
        A WSA-ENLIL model run, not an observation, marked at the subsolar point at the predicted
        arrival time. NASA DONKI /WSAEnlilSimulations.
      </p>
    </section>
  );
}
