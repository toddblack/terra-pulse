import { faultStrikeDeg, type FaultRecord } from '../layers/fault-association';
import { resolvedShearPa } from '../layers/tidal-stress';
import { tidalBodies } from '../layers/tides';
import { useEarthquakeStore } from '../state/useEarthquakeStore';
import { useNow } from '../globe/useNow';
import { displayWindow, instantOnScreen } from '../globe/display-window';
import styles from './TidalShear.module.css';

/**
 * The current lunisolar tidal shear stress on one mapped fault, as a row in a
 * panel's field list.
 *
 * ## Why this is its own component and not inlined twice
 *
 * Three paths reach a fault: the earthquake inspector (nearest to the selected
 * event), the location panel in probe mode (nearest to a clicked point), and
 * the location panel on a clicked trace (that fault itself). The first two go
 * through `NearestFaultBody` and the third through `LocationPanel`'s own
 * `FaultDetail` — and it shipped with the readout on the first two only.
 *
 * Copying the field into `FaultDetail` would have re-created exactly what
 * `LocationPanel`'s own header comment records happening once already: a probe
 * and an inspector that "repeated each other", drifting until they were merged.
 * What must not drift here is the wording — the label, the unit, the
 * magnitude-only caveat and the absent case are each load-bearing, so they get
 * one definition.
 *
 * ## Clicking a trace is the cleanest case of the three
 *
 * There the distance is zero by construction, so none of `NearestFaultBody`'s
 * "is this fault even related to the event" caveats apply: the fault under the
 * pointer is the fault the number describes.
 *
 * ## What it does not claim
 *
 * Informational, not H6 — H6 resolves stress onto Global CMT focal mechanisms,
 * never onto a GEM trace, and this is a different and smaller question. See
 * `tidal-stress.ts` for the physics and the two simplifications it inherits
 * (no ocean loading, free-surface stress at any depth).
 */
export function TidalShearField({
  fault,
  point,
}: {
  fault: FaultRecord;
  /** Where the reader actually pointed — never the trace's centroid, since
   * strike is read from the segment nearest this point. */
  point: { latitude: number; longitude: number };
}) {
  // Same display-window-plus-clamp shape every other "state of the world right
  // now" reading uses (`magnetopause-layer.ts`, `tide-layer.ts`): the raw
  // window end sits an hour into the future in live mode, and this asks what
  // the tide is doing *now*, not what it will be doing.
  //
  // The clock lives down here rather than in either parent so that the 30 s
  // `useNow` tick re-renders one row instead of a whole panel — the inspector
  // note in CLAUDE.md flags adding `useNow` to a panel as a question worth
  // asking, and this is the answer to it.
  const windowHours = useEarthquakeStore((state) => state.windowHours);
  const playheadMs = useEarthquakeStore((state) => state.playheadMs);
  const trailingWindow = useEarthquakeStore((state) => state.trailingWindow);
  const nowMs = useNow();
  const { endMs } = displayWindow(windowHours, playheadMs, trailingWindow, nowMs);
  const instant = new Date(instantOnScreen(endMs, nowMs));

  const shearKPa = resolvedShearKPa(fault, point, instant);

  return (
    <div className={styles.field}>
      <dt className={styles.term}>Tidal shear stress</dt>
      <dd className={styles.value}>
        {shearKPa !== null ? (
          <>
            {shearKPa < 0.01 ? '<0.01' : shearKPa.toFixed(2)} kPa
            <span className={styles.sub}>magnitude only — direction not resolved</span>
          </>
        ) : (
          /* Present on 21.7% of GEM faults (measured at vendor time), so
             absence is the common case rather than a fault in the data — it
             gets the same explicit treatment `unnamed fault` gets, instead of
             vanishing the way an absent slip rate does. */
          <span className={styles.absent}>dip not reported for this fault</span>
        )}
      </dd>
    </div>
  );
}

/**
 * Magnitude of the resolved shear, kPa, or null when GEM measured no dip and
 * rake for this trace.
 *
 * **Magnitude, not the signed value `resolvedShearPa` returns.** The sign
 * depends on strike being read in the same sense GEM's own dip and rake were
 * measured against, and `faultStrikeDeg` derives strike from the trace's
 * arbitrary digitisation order instead — so the sign from this pipeline is not
 * trustworthy while the magnitude is. Both functions' doc comments carry the
 * long form.
 */
function resolvedShearKPa(
  fault: FaultRecord,
  point: { latitude: number; longitude: number },
  instant: Date,
): number | null {
  if (fault.d === undefined || fault.r === undefined) return null;

  const strikeDeg = faultStrikeDeg(fault, point);
  if (strikeDeg === null) return null;

  const shearPa = resolvedShearPa(
    tidalBodies(instant),
    point.latitude,
    point.longitude,
    strikeDeg,
    fault.d,
    fault.r,
  );
  return Math.abs(shearPa) / 1000;
}
