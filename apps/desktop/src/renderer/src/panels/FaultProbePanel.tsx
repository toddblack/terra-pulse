import { useGlobeStore } from '../state/useGlobeStore';
import { formatLatLon } from '../layers/antipode';
import { NearestFaultSection } from './NearestFault';
import styles from './FaultProbePanel.module.css';

/**
 * "What fault is here?" for any point on the globe — PROJECT_PLAN §5.10.
 *
 * The counterpart to the inspector's fault section: that one answers for a
 * selected earthquake, this one for anywhere, which is the more general
 * question. Asking whether Seattle sits near a mapped fault should not require
 * an earthquake there to click on.
 *
 * The toggle stays visible when the mode is off, because a mode with no visible
 * control is a mode nobody finds.
 */
export function FaultProbePanel() {
  const active = useGlobeStore((state) => state.faultProbeActive);
  const probePoint = useGlobeStore((state) => state.probePoint);
  const toggle = useGlobeStore((state) => state.toggleFaultProbe);

  return (
    <aside className={styles.panel}>
      <button
        id="fault-probe-toggle"
        type="button"
        aria-pressed={active}
        className={active ? `${styles.toggle} ${styles.toggleActive}` : styles.toggle}
        onClick={toggle}
      >
        Fault probe
      </button>

      {active && (
        <div className={styles.body}>
          {probePoint === null ? (
            <p className={styles.hint}>click the globe to see what&rsquo;s mapped there</p>
          ) : (
            <>
              <p className={styles.coordinate}>{formatLatLon(probePoint)}</p>
              {/* No depth: a point on the globe has no rupture depth, so the
                  deep-event caveat is not applicable and must not be implied. */}
              <NearestFaultSection point={probePoint} heading="Nearest mapped fault" />
            </>
          )}
        </div>
      )}
    </aside>
  );
}
