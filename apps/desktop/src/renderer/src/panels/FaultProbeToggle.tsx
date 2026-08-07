import { useGlobeStore } from '../state/useGlobeStore';
import styles from './FaultProbeToggle.module.css';

/**
 * Arms "click anywhere to ask about that point".
 *
 * All that remains of the old fault-probe panel: its readout moved into
 * `LocationPanel`, which now serves clicked faults, clicked boundaries and
 * probed points alike. Only the mode switch is left.
 *
 * **The mode exists because a bare-globe click already means "deselect".** That
 * is a rule worth keeping — it is how you dismiss the inspector — so probing an
 * arbitrary point needs its own state rather than overloading the same gesture.
 */
export function FaultProbeToggle() {
  const active = useGlobeStore((state) => state.faultProbeActive);
  const toggle = useGlobeStore((state) => state.toggleFaultProbe);

  return (
    <button
      id="fault-probe-toggle"
      type="button"
      aria-pressed={active}
      className={active ? `${styles.toggle} ${styles.toggleActive}` : styles.toggle}
      onClick={toggle}
      title="Click anywhere on the globe to see what is mapped there"
    >
      {active ? 'Probing — click the globe' : 'Probe a location'}
    </button>
  );
}
