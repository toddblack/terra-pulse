import { useGlobeStore } from '../state/useGlobeStore';
import { useEarthquakeStore } from '../state/useEarthquakeStore';
import {
  DEPTH_BINS,
  EMPHASIS_MAGNITUDE_THRESHOLD,
  depthLegendColors,
  emphasisRingColorHex,
  magnitudePixelSize,
} from '../layers/earthquake-encoding';
import styles from './DepthLegend.module.css';

// Sample magnitudes for the size ramp — spans the range the scale actually
// covers, so the reader can eyeball a mark on the globe against it.
const MAGNITUDE_SAMPLES = [3, 5, 7];

export function DepthLegend() {
  const activeBasemap = useGlobeStore((state) => state.activeBasemap);
  const eventCount = useEarthquakeStore((state) => state.events.length);
  const status = useEarthquakeStore((state) => state.status);
  const colors = depthLegendColors(activeBasemap);

  return (
    <div id="depth-legend" className={styles.legend}>
      <div className={styles.section}>
        <h2 className={styles.heading}>Depth</h2>
        <ul className={styles.binList}>
          {DEPTH_BINS.map((bin, index) => (
            <li key={bin.label} className={styles.binRow}>
              <span
                className={styles.swatch}
                style={{ backgroundColor: colors[index] }}
                aria-hidden="true"
              />
              <span className={styles.binLabel}>{bin.label}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className={styles.section}>
        <h2 className={styles.heading}>Magnitude</h2>
        <ul className={styles.magnitudeList}>
          {MAGNITUDE_SAMPLES.map((magnitude) => (
            <li key={magnitude} className={styles.magnitudeRow}>
              <span className={styles.magnitudeDotCell} aria-hidden="true">
                <span
                  className={styles.magnitudeDot}
                  style={{
                    width: `${magnitudePixelSize(magnitude)}px`,
                    height: `${magnitudePixelSize(magnitude)}px`,
                  }}
                />
              </span>
              <span className={styles.binLabel}>M{magnitude}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className={styles.section}>
        <ul className={styles.magnitudeList}>
          <li className={styles.magnitudeRow}>
            <span className={styles.magnitudeDotCell} aria-hidden="true">
              <span
                className={styles.emphasisRing}
                style={{ borderColor: emphasisRingColorHex(activeBasemap) }}
              />
            </span>
            <span className={styles.binLabel}>M{EMPHASIS_MAGNITUDE_THRESHOLD}+</span>
          </li>
        </ul>
      </div>

      <p className={styles.footnote}>
        {status === 'loading'
          ? 'Loading…'
          : status === 'error'
            ? 'Failed to load'
            : `${eventCount} events · last 72h · M2.5+`}
      </p>
    </div>
  );
}
