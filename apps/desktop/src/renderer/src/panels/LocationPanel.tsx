import { useGlobeStore } from '../state/useGlobeStore';
import { formatLatLon } from '../layers/antipode';
import { formatSlipRate, formatSlipType } from '../layers/fault-association';
import { plateBoundaryLabel, plateClassLabel } from '../layers/plate-association';
import { NearestFaultSection } from './NearestFault';
import { RegionalRecurrenceSection } from './RegionalRecurrence';
import styles from './LocationPanel.module.css';

/**
 * Everything known about one place — PROJECT_PLAN §5.10, §5.11.
 *
 * ## Why this is one panel and not two
 *
 * A fault probe and a geology inspector shipped separately and repeated each
 * other: both showed a fault's name, kinematics and slip rate, differing only in
 * whether the fault had been clicked directly or found as the nearest one. They
 * were also answering the same underlying question — "what is going on at this
 * point" — from two different entry points.
 *
 * Now there is one panel and one store slot. `kind` selects the sourced detail
 * at the top; the coordinate drives the recurrence section below it in every
 * case. Three ways in:
 *
 * - click a fault trace → that fault's record
 * - click a plate boundary → that boundary's pair and class
 * - probe mode, click anywhere → nearest fault to the point
 *
 * **Probe mode is kept precisely because the other two need a drawn line.**
 * Asking "how often do M6+ happen near Seattle" must not require an earthquake
 * or a mapped fault to be sitting under the pointer.
 */
export function LocationPanel() {
  const location = useGlobeStore((state) => state.location);
  const selectLocation = useGlobeStore((state) => state.selectLocation);

  if (location === null) return null;

  const close = () => {
    selectLocation(null);
  };

  return (
    <aside className={styles.panel} aria-labelledby="location-heading">
      <header className={styles.header}>
        <div>
          <h2 id="location-heading" className={styles.kind}>
            {location.kind === 'fault'
              ? 'Active fault'
              : location.kind === 'boundary'
                ? 'Plate boundary'
                : 'Location'}
          </h2>
          <p className={styles.coordinate}>{formatLatLon(location)}</p>
        </div>
        <button
          id="location-close"
          type="button"
          className={styles.closeButton}
          onClick={close}
          aria-label="Close"
        >
          ×
        </button>
      </header>

      <div className={styles.body}>
        {location.kind === 'fault' && <FaultDetail fault={location.fault} />}
        {location.kind === 'boundary' && (
          <BoundaryDetail pair={location.pair} boundaryClass={location.boundaryClass} />
        )}
        {/* Only for a bare point. Having clicked a trace directly, "the nearest
            fault" is the one you clicked, and repeating it with a distance of
            zero would be noise. */}
        {location.kind === 'point' && <NearestFaultSection point={location} />}

        <RegionalRecurrenceSection point={location} />
      </div>
    </aside>
  );
}

function FaultDetail({
  fault,
}: {
  fault: { n?: string; t?: string; c?: string; s?: number; sl?: number; sh?: number };
}) {
  const kinematics = formatSlipType(fault.t);
  const slipRate = formatSlipRate(fault as Parameters<typeof formatSlipRate>[0]);

  return (
    <section className={styles.section}>
      {/* Unnamed is the majority case — 55% of GEM traces — so it is stated
          rather than left as an empty heading. */}
      <p className={styles.name}>
        {fault.n ?? <span className={styles.unnamed}>unnamed fault</span>}
      </p>

      <dl className={styles.fields}>
        {kinematics && (
          <div className={styles.field}>
            <dt className={styles.term}>Kinematics</dt>
            <dd className={styles.value}>{kinematics}</dd>
          </div>
        )}
        {/* Slip rate is shown, recurrence is never derived from it: that needs a
            characteristic slip per event and therefore magnitude-scaling
            relations, which is model output and belongs in Analyze (§5.10). */}
        {slipRate && (
          <div className={styles.field}>
            <dt className={styles.term}>Slip rate</dt>
            <dd className={styles.value}>
              {slipRate}
              <span className={styles.sub}>long-term geologic average</span>
            </dd>
          </div>
        )}
        {fault.c && (
          <div className={styles.field}>
            <dt className={styles.term}>Source</dt>
            <dd className={styles.value}>{fault.c}</dd>
          </div>
        )}
      </dl>

      <p className={styles.footnote}>
        GEM Global Active Faults. Traces are mapped at the surface; ruptures happen at depth.
      </p>
    </section>
  );
}

function BoundaryDetail({ pair, boundaryClass }: { pair: string; boundaryClass: string }) {
  return (
    <section className={styles.section}>
      <p className={styles.name}>{plateBoundaryLabel(pair)}</p>

      <dl className={styles.fields}>
        <div className={styles.field}>
          <dt className={styles.term}>Type</dt>
          <dd className={styles.value}>{plateClassLabel(boundaryClass)}</dd>
        </div>
        <div className={styles.field}>
          <dt className={styles.term}>PB2002 code</dt>
          {/* The raw pair is the stable identity — the readable label is derived
              from it, and this is what you would search Bird's paper for. */}
          <dd className={styles.value}>{pair}</dd>
        </div>
      </dl>

      <p className={styles.footnote}>
        Bird (2003) PB2002. The pair is listed without stating which plate underthrusts.
      </p>
    </section>
  );
}
