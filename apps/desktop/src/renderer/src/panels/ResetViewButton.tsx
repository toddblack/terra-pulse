import { useGlobeStore } from '../state/useGlobeStore';
import styles from './ResetViewButton.module.css';

/** A house: the one mark everyone already reads as "take me back". */
function HomeIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.25 7.75 8 2.5l5.75 5.25" />
      <path d="M3.75 6.6v6.65h3.1V9.6h2.3v3.65h3.1V6.6" />
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
 * place.
 *
 * **That place is the mode switch, between Explore and Analyze — the user's
 * call (2026-10-11).** It shipped first as a globe icon beside "Probe a
 * location", and he took a minute to find it: a small unlabelled icon at the
 * foot of a column of controls is not where anyone looks for the way back.
 * Top-centre is. It is also a house now rather than a globe, because "home"
 * is the word he reached for.
 *
 * It moves the camera and nothing else — the selection, the window and the
 * layers all stay. It works in Analyze too, where the globe shows either side
 * of the panel.
 */
export function ResetViewButton() {
  const requestHomeView = useGlobeStore((state) => state.requestHomeView);
  return (
    <button
      id="reset-view"
      type="button"
      className={styles.button}
      onClick={requestHomeView}
      title="Home: the whole globe, level, as the app opened"
      aria-label="Reset the view to the whole globe"
    >
      <HomeIcon />
    </button>
  );
}
