import { useGlobeStore } from '../state/useGlobeStore';
import {
  BASEMAP_REGISTRATIONS,
  OVERLAY_REGISTRATIONS,
  isOverlayVisible,
} from '../layers/registry';
import styles from './LayerPanel.module.css';

/**
 * Driven entirely off the registry — adding a layer needs no edit here.
 *
 * Two sections because the two groups behave differently (PROJECT_PLAN §4):
 * basemaps are mutually exclusive, so they get a segmented control; everything
 * else is independent, so it gets checkboxes.
 */
export function LayerPanel() {
  const activeBasemapId = useGlobeStore((state) => state.activeBasemapId);
  const setActiveBasemap = useGlobeStore((state) => state.setActiveBasemap);
  const layerVisibility = useGlobeStore((state) => state.layerVisibility);
  const toggleLayer = useGlobeStore((state) => state.toggleLayer);

  return (
    <div id="layer-panel" className={styles.panel}>
      <div className={styles.basemapGroup} role="group" aria-label="Basemap">
        {BASEMAP_REGISTRATIONS.map((entry) => (
          <button
            key={entry.id}
            id={`basemap-option-${entry.id}`}
            type="button"
            aria-pressed={activeBasemapId === entry.id}
            onClick={() => setActiveBasemap(entry.id)}
            className={
              activeBasemapId === entry.id
                ? `${styles.basemapButton} ${styles.basemapButtonActive}`
                : styles.basemapButton
            }
          >
            {entry.label}
          </button>
        ))}
      </div>

      {OVERLAY_REGISTRATIONS.length > 0 && (
        <ul className={styles.overlayList}>
          {OVERLAY_REGISTRATIONS.map((entry) => (
            <li key={entry.id}>
              <label className={styles.overlayRow}>
                <input
                  id={`layer-toggle-${entry.id}`}
                  type="checkbox"
                  className={styles.checkbox}
                  checked={isOverlayVisible(entry, layerVisibility)}
                  onChange={() => toggleLayer(entry.id)}
                />
                <span>{entry.label}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
