import { useGlobeStore } from '../state/useGlobeStore';
import styles from './ResetViewButton.module.css';

/** A globe with a meridian and the equator — "the whole planet again". */
function GlobeIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" />
      <ellipse cx="8" cy="8" rx="2.6" ry="6.25" />
      <path d="M1.75 8h12.5" />
    </svg>
  );
}

/**
 * Flies the camera back to the view the app opened on: the whole globe, level,
 * facing the reader's side of the planet.
 *
 * Cesium's own home button stays off — it sat under the event list and looked
 * like nothing else here. This is the reset that note said would be wanted
 * once zoom was kept across selections, in our own chrome where we choose the
 * place: beside the probe toggle, the other control that is about the globe
 * itself rather than about what is drawn on it.
 *
 * An icon, not a word, because the left column is as wide as its widest child
 * and the probe toggle's armed label is already the longest thing in this row.
 *
 * It moves the camera and nothing else — the selection, the window and the
 * layers all stay.
 */
export function ResetViewButton() {
  const requestHomeView = useGlobeStore((state) => state.requestHomeView);
  return (
    <button
      id="reset-view"
      type="button"
      className={styles.button}
      onClick={requestHomeView}
      title="Reset the view: the whole globe, level, as the app opened"
      aria-label="Reset the view to the whole globe"
    >
      <GlobeIcon />
    </button>
  );
}
