import {
  MIN_INTERVALS_FOR_SUMMARY,
  RECURRENCE_FLOORS,
  RECURRENCE_RADII_KM,
  type RegionalRecurrence as Recurrence,
} from '@terra-pulse/schema';
import { useMemo } from 'react';
import { boundaryBreakdown } from '../layers/plate-association';
import { useGlobeStore } from '../state/useGlobeStore';
import { useRecurrence } from './useRecurrence';
import styles from './RegionalRecurrence.module.css';

/** Years, at a precision that doesn't overstate what a few decades can know. */
function years(value: number): string {
  if (value < 1) {
    const months = value * 12;
    return months < 1 ? `${Math.round(value * 365.25)} d` : `${months.toFixed(1)} mo`;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} y`;
}

/**
 * How often independent earthquakes have occurred near a point — PROJECT_PLAN
 * §5.11.
 *
 * ## What this says, and what it refuses to
 *
 * It reports gaps the catalogue actually recorded, from whenever it became
 * complete at the chosen floor — 1970 below M7.5, 1900 at or above it, which is
 * why the panel prints its epoch. It does **not** forecast, and it never says a
 * region is "due" or "overdue". That claim needs paleoseismology — trenching a
 * fault to read ruptures across millennia — and neither 57 nor 126 years can
 * substitute for it.
 *
 * Every number here is descriptive, which is what keeps it in Explore under
 * non-negotiable #1. Declustering is applied first, because a recurrence
 * interval is a rate claim and non-negotiable #2 requires it: raw counts near
 * Tokyo give a 0.06 y median gap against 0.32 y declustered, and the raw figure
 * is not a noisier version of the right answer — it answers a different question.
 */
/**
 * The framed form, for the location panel — which is not collapsible.
 *
 * The inspector uses `RegionalRecurrenceBody` inside a `CollapsibleSection`, so
 * the two share the content and differ only in the frame.
 */
export function RegionalRecurrenceSection({
  point,
  heading = 'How often here',
}: {
  point: { latitude: number; longitude: number };
  heading?: string;
}) {
  return (
    <section className={styles.section} aria-labelledby="recurrence-heading">
      <h3 id="recurrence-heading" className={styles.heading}>
        {heading}
      </h3>
      <RegionalRecurrenceBody point={point} />
    </section>
  );
}

export function RegionalRecurrenceBody({
  point,
}: {
  point: { latitude: number; longitude: number };
}) {
  const radiusKm = useGlobeStore((state) => state.recurrenceRadiusKm);
  const minMagnitude = useGlobeStore((state) => state.recurrenceFloor);
  const setRadius = useGlobeStore((state) => state.setRecurrenceRadiusKm);
  const setFloor = useGlobeStore((state) => state.setRecurrenceFloor);

  const state = useRecurrence({
    latitude: point.latitude,
    longitude: point.longitude,
    radiusKm,
    minMagnitude,
  });

  return (
    <>
      <div className={styles.controls}>
        <div className={styles.controlRow} role="group" aria-label="Region radius">
          {RECURRENCE_RADII_KM.map((km) => (
            <button
              key={km}
              type="button"
              aria-pressed={km === radiusKm}
              className={km === radiusKm ? `${styles.chip} ${styles.chipActive}` : styles.chip}
              onClick={() => setRadius(km)}
            >
              {km}km
            </button>
          ))}
        </div>
        <div className={styles.controlRow} role="group" aria-label="Magnitude floor">
          {RECURRENCE_FLOORS.map((floor) => (
            <button
              key={floor}
              type="button"
              aria-pressed={floor === minMagnitude}
              className={
                floor === minMagnitude ? `${styles.chip} ${styles.chipActive}` : styles.chip
              }
              onClick={() => setFloor(floor)}
            >
              M{floor}
            </button>
          ))}
        </div>
      </div>

      {state.status === 'loading' && <p className={styles.note}>reading catalogue…</p>}
      {state.status === 'error' && <p className={styles.note}>couldn&rsquo;t read this region</p>}
      {state.status === 'ready' && <Body recurrence={state.recurrence} />}
    </>
  );
}

/**
 * Which plate boundaries this region's earthquakes actually sit on.
 *
 * **Context, not a filter, and that distinction is measured rather than
 * stylistic.** Restricting the query to the boundary nearest the click cuts
 * Tokyo's 17 M7.5+ events to 3, because Tokyo is a triple junction and the
 * closest boundary is not the seismogenic one — ten of those events are on the
 * Japan Trench, which is a different plate pair. Wellington loses all three.
 * Reporting the breakdown answers "what tectonic setting is this?" at no cost to
 * the sample. See `plate-association.ts`.
 */
function BoundaryContext({ recurrence }: { recurrence: Recurrence }) {
  const shares = useMemo(
    () => boundaryBreakdown(recurrence.independent),
    [recurrence.independent],
  );
  if (shares.length === 0) return null;

  const total = shares.reduce((sum, share) => sum + share.count, 0);
  const dominant = shares[0];

  return (
    <p className={styles.value}>
      <span className={styles.sub} style={{ marginTop: 0 }}>
        on these plate boundaries:
      </span>
      {shares.slice(0, 4).map((share) => (
        <span key={share.pair} className={styles.boundaryRow}>
          <span className={styles.boundaryName}>{share.label}</span>
          <span className={styles.boundaryCount}>{share.count}</span>
        </span>
      ))}
      {shares.length > 4 && (
        <span className={styles.sub}>and {shares.length - 4} more</span>
      )}
      {dominant !== undefined && dominant.count / total >= 0.5 && (
        <span className={styles.sub}>
          mostly a {dominant.classLabel}
        </span>
      )}
    </p>
  );
}

function Body({ recurrence }: { recurrence: Recurrence }) {
  const { summary, archiveComplete } = recurrence;
  const { independentCount, rawCount, intervalsYears, medianYears } = summary;

  if (!archiveComplete) {
    // Refusing outright rather than summarising. A hole in the record merges two
    // real gaps into one longer false gap — an error that always points toward
    // "rarer than it is", and which looks exactly like a complete answer.
    return (
      <p className={styles.blocked}>
        The historical archive isn&rsquo;t fully downloaded, so intervals here would be too long
        rather than merely uncertain. Download it from the archive panel to enable this.
      </p>
    );
  }

  if (independentCount === 0) {
    return (
      <p className={styles.value}>
        No independent M{summary.minMagnitude}+ earthquakes within {summary.radiusKm} km since{' '}
        {summary.epochYear}
        <span className={styles.sub}>
          a real answer about this region, not missing data
        </span>
      </p>
    );
  }

  return (
    <>
      {/* Both counts, always. Showing only the independent figure invites the
          reader to think the region is quieter than it is; the difference is
          the aftershock sequences, and it is often most of the catalogue. */}
      <p className={styles.value}>
        <span className={styles.big}>{independentCount}</span> independent
        {independentCount === 1 ? ' earthquake' : ' earthquakes'}
        <span className={styles.sub}>
          from {rawCount} recorded — the rest were aftershocks, removed before counting
        </span>
      </p>

      {medianYears !== null ? (
        <p className={styles.value}>
          <span className={styles.big}>{years(medianYears)}</span> typical gap
          <span className={styles.sub}>
            median of {intervalsYears.length} intervals · shortest {years(summary.shortestYears ?? 0)}
            , longest {years(summary.longestYears ?? 0)}
          </span>
        </p>
      ) : (
        /* Below the threshold the median is unstable enough to mislead —
           Kathmandu at M7+ gives two intervals whose mean is 4.85 y and whose
           median is 9.66. The raw gaps are honest at any count. */
        <p className={styles.value}>
          {intervalsYears.length === 0 ? (
            <>
              only one event — no interval to measure
              <span className={styles.sub}>a gap needs two</span>
            </>
          ) : (
            <>
              gaps: {intervalsYears.map((gap) => years(gap)).join(', ')}
              <span className={styles.sub}>
                too few for a typical value ({intervalsYears.length} of{' '}
                {MIN_INTERVALS_FOR_SUMMARY} needed) — widen the region or lower the magnitude
              </span>
            </>
          )}
        </p>
      )}

      {summary.sinceLastYears !== null && (
        <p className={styles.value}>
          <span className={styles.big}>{years(summary.sinceLastYears)}</span> since the last
          {/* The one place a reader will try to infer "so we're due". Said
              plainly rather than left to be inferred — earthquakes are not
              scheduled, and the catalogue cannot speak to what comes next. */}
          <span className={styles.sub}>
            elapsed time, not a countdown — intervals vary and nothing here predicts the next
          </span>
        </p>
      )}

      <BoundaryContext recurrence={recurrence} />

      {/* The epoch is stated because it moves with the floor: M7.5+ draws on
          1900 onward, everything else on 1970. A reader comparing two floors
          needs to know the denominator changed underneath them. */}
      <p className={styles.footnote}>
        Observed since {summary.epochYear}, declustered (Gardner-Knopoff). A{' '}
        {Math.round(summary.observedYears)}-year record still cannot measure recurrence on faults
        that rupture every few centuries.
      </p>
    </>
  );
}
