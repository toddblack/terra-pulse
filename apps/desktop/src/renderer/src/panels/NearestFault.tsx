import { useMemo } from 'react';
import { ACTIVE_FAULTS } from '../layers/fault-data';
import { formatSlipRate, formatSlipType, nearestFault } from '../layers/fault-association';
import styles from './NearestFault.module.css';

/**
 * Beyond this, naming a "nearest" fault stops meaning anything.
 *
 * Measured against the real catalogue: the median M6+ event is 42.9 km from any
 * mapped trace and the p90 is 144.9 km, while a mid-Pacific point is ~1,170 km
 * from the nearest. Printing a fault name next to four digits of distance would
 * be technically true and read as an association. 150 km keeps roughly the
 * populated nine-tenths and refuses the rest outright.
 */
const MAX_MEANINGFUL_KM = 150;

/**
 * Below this, the trace is close enough that the reader can reasonably wonder
 * whether the event was on it. Above it the panel keeps the distance prominent
 * instead of the name.
 *
 * Only 20% of M6+ events fall inside this, which is the honest headline of the
 * whole feature: most earthquakes are not near a mapped fault.
 */
const PLAUSIBLE_KM = 15;

/**
 * Depth past which a surface trace stops describing the earthquake.
 *
 * Subduction geometry puts a 200 km-deep event a long way inboard of where the
 * plate boundary reaches the surface, so the horizontal distance to a mapped
 * trace is not a statement about the rupture. Measured: deep events sit a median
 * 78.1 km from the nearest fault against 39.2 km for shallow ones — that gap is
 * geometry, not a different tectonic setting.
 *
 * 70 km is the shallow/intermediate boundary the depth ramp already uses.
 */
const DEEP_KM = 70;

/**
 * What is mapped at a point on the globe — PROJECT_PLAN §5.10.
 *
 * Shared by the inspector (for a selected event) and the fault probe (for a
 * clicked point), because the honest wording is fiddly enough that two copies
 * would drift.
 *
 * ## What this does not claim
 *
 * It reports the nearest mapped trace and how far away it is. It does **not**
 * say the earthquake happened on that fault. Epicentres carry real location
 * error, GEM maps surface traces while ruptures happen at depth, and most events
 * are nowhere near anything mapped. The distance leads, and the wording changes
 * with it, so the reader is never handed an association the data doesn't support.
 */
/**
 * The framed form, for the location panel — which is not collapsible and owns
 * its own layout.
 *
 * The inspector uses `NearestFaultBody` inside a `CollapsibleSection` instead,
 * so the two share the content and differ only in the frame around it.
 */
export function NearestFaultSection({
  point,
  depthKm,
  heading = 'Nearest mapped fault',
}: {
  point: { latitude: number; longitude: number };
  depthKm?: number | null;
  heading?: string;
}) {
  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>{heading}</h3>
      <NearestFaultBody point={point} depthKm={depthKm} />
    </section>
  );
}

export function NearestFaultBody({
  point,
  depthKm,
}: {
  point: { latitude: number; longitude: number };
  /** Event depth, when there is one. Drives the deep-event caveat. */
  depthKm?: number | null;
}) {
  // Keyed on the coordinates rather than the object, so an event re-arriving
  // from a poll with identical geometry doesn't re-run a 144,000-segment sweep.
  // Destructured first because the exhaustive-deps rule can't see through a
  // member expression in the array, and it is right to insist: `[point]` would
  // silently do the work again on every poll.
  const { latitude, longitude } = point;
  const match = useMemo(
    () => nearestFault({ latitude, longitude }, ACTIVE_FAULTS),
    [latitude, longitude],
  );

  if (match === null || match.distanceKm > MAX_MEANINGFUL_KM) {
    return (
      <p className={styles.none}>
        none mapped within {MAX_MEANINGFUL_KM} km
        <span className={styles.sub}>
          GEM maps active faults, not every structure — many earthquakes occur away from them
        </span>
      </p>
    );
  }

  const { fault, distanceKm } = match;
  const slipRate = formatSlipRate(fault);
  const slipType = formatSlipType(fault.t);
  const plausible = distanceKm <= PLAUSIBLE_KM;
  const deep = depthKm !== null && depthKm !== undefined && depthKm >= DEEP_KM;

  return (
    <>
      {/* Unnamed is the common case — only 44.6% of GEM faults carry a name,
          and just 21% of the traces nearest to real M6+ events do. Saying so
          plainly beats an empty line where a name should be. */}
      <p className={styles.name}>
        {fault.n ?? <span className={styles.unnamed}>unnamed fault</span>}
      </p>

      <dl className={styles.fields}>
        <div className={styles.field}>
          <dt className={styles.term}>Distance</dt>
          <dd className={styles.value}>
            {distanceKm < 1 ? '<1' : Math.round(distanceKm)} km
            {!plausible && <span className={styles.sub}>too far to attribute the event</span>}
          </dd>
        </div>

        {slipType && (
          <div className={styles.field}>
            <dt className={styles.term}>Kinematics</dt>
            <dd className={styles.value}>{slipType}</dd>
          </div>
        )}

        {/* The measurement that speaks to "how often" — but on its own, not
            converted into a recurrence interval. Turning slip rate into years
            needs a characteristic slip per event, which needs magnitude-scaling
            relations: that is a model with assumptions, and model output does
            not belong beside observations in Explore (non-negotiable #1). */}
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

      {deep && (
        <p className={styles.caveat}>
          This event is {Math.round(depthKm)} km deep. A surface trace says little about a rupture
          that far down — the distance above is horizontal only.
        </p>
      )}
    </>
  );
}
