import { useGlobeFailureStore } from './useGlobeFailureStore';
import styles from './GlobeFailureNotice.module.css';

/**
 * Replaces Cesium's own "Rendering has stopped" panel for graphics failures.
 *
 * That panel is a modal with an OK button and a stack trace, and after OK the
 * globe stays blank with nothing to say why — which is exactly what the Store
 * reviewer saw. In the usual case this shows for a moment while the app
 * restarts off the graphics card. When there is nowhere left to go, it stays,
 * says the rest of the app still works, and keeps the error for anyone who
 * reports it.
 */
export function GlobeFailureNotice() {
  const failure = useGlobeFailureStore((state) => state.failure);
  if (failure === null) return null;

  return (
    <div id="globe-failure" className={styles.notice} role="alert">
      {failure.state === 'restarting' ? (
        <p className={styles.title}>
          The graphics driver could not draw the globe. Restarting with software rendering…
        </p>
      ) : (
        <>
          <p className={styles.title}>The globe could not be drawn on this PC.</p>
          <p className={styles.body}>
            Everything else still works: the timeline, the event list, the panels and Analyze.
            Updating the graphics driver may help.
          </p>
          <p className={styles.detail}>{failure.detail}</p>
        </>
      )}
    </div>
  );
}
