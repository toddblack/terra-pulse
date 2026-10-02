import { useGlobeStore } from '../state/useGlobeStore';
import {
  BASEMAP_REGISTRATIONS,
  OVERLAY_REGISTRATIONS,
  isOverlayVisible,
} from '../layers/registry';
import { GEOMAGNETIC_FIELD_LAYER_ID } from '../layers/geomagnetic-field';
import { FIELD_SCALES } from '../layers/field-encoding';
import type { FieldQuantity } from '../layers/igrf';
import { LayerGuideButton } from './LayerGuideModal';
import styles from './LayerPanel.module.css';

/**
 * Driven entirely off the registry — adding a layer needs no edit here.
 *
 * Two sections because the two groups behave differently (PROJECT_PLAN §4):
 * basemaps are mutually exclusive, so they get a segmented control; everything
 * else is independent, so it gets checkboxes.
 */
/**
 * Short forms for the quantity buttons.
 *
 * `FIELD_SCALES` carries the full names ("Total intensity"), which are right in
 * a legend and too wide for three buttons in a panel whose width is already set
 * by its longest label.
 */
const SHORT_LABELS: Record<FieldQuantity, string> = {
  intensity: 'Strength',
  declination: 'Declination',
  inclination: 'Dip',
};

export function LayerPanel() {
  const activeBasemapId = useGlobeStore((state) => state.activeBasemapId);
  const setActiveBasemap = useGlobeStore((state) => state.setActiveBasemap);
  const layerVisibility = useGlobeStore((state) => state.layerVisibility);
  const toggleLayer = useGlobeStore((state) => state.toggleLayer);
  const fieldQuantity = useGlobeStore((state) => state.fieldQuantity);
  const setFieldQuantity = useGlobeStore((state) => state.setFieldQuantity);

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
                <span className={styles.overlayLabel}>{entry.label}</span>
                {/* Inside the label so it sits on the row, with its own click
                    handler stopped — otherwise asking what a layer is would
                    also switch it on. */}
                <LayerGuideButton layerId={entry.id} />
              </label>

              {/* The field layer's three views. Shown only while the layer is
                  on, because the control means nothing otherwise — and because
                  three extra buttons in a permanently visible list would read
                  as three more layers. */}
              {entry.id === GEOMAGNETIC_FIELD_LAYER_ID &&
                isOverlayVisible(entry, layerVisibility) && (
                  <div
                    className={styles.subGroup}
                    role="group"
                    aria-label="Magnetic field quantity"
                  >
                    {(Object.keys(FIELD_SCALES) as FieldQuantity[]).map((quantity) => (
                      <button
                        key={quantity}
                        id={`field-quantity-${quantity}`}
                        type="button"
                        aria-pressed={fieldQuantity === quantity}
                        onClick={() => setFieldQuantity(quantity)}
                        className={
                          fieldQuantity === quantity
                            ? `${styles.subButton} ${styles.subButtonActive}`
                            : styles.subButton
                        }
                      >
                        {SHORT_LABELS[quantity]}
                      </button>
                    ))}
                  </div>
                )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
