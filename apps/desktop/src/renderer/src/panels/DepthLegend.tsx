import { useGlobeStore, selectBackdropTone } from '../state/useGlobeStore';
import { useEarthquakeStore } from '../state/useEarthquakeStore';
import { useVisibleEarthquakes } from '../globe/useVisibleEarthquakes';
import {
  KINEMATIC_GROUPS,
  KINEMATIC_LABELS,
  kinematicColorHex,
} from '../layers/plate-kinematics';
import { faultColorHex } from '../layers/fault-encoding';
import { OVERLAY_REGISTRATIONS, isOverlayVisible } from '../layers/registry';
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

/** Matches the labels on RangeControls so the two can't disagree. */
function formatWindow(hours: number): string {
  return hours % 24 === 0 && hours > 24 ? `${hours / 24}d` : `${hours}h`;
}

/**
 * Relative freshness. Deliberately coarse — the background poll runs every few
 * minutes, so second-level precision would imply an accuracy the data doesn't
 * have. The Refresh button beside it is the answer to "but I want it *now*".
 */
function formatFreshness(lastSyncedAt: string | null): string {
  if (lastSyncedAt === null) return 'not yet synced';

  const ageMs = Date.now() - new Date(lastSyncedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'just now';

  const ageMinutes = Math.floor(ageMs / 60_000);
  if (ageMinutes < 1) return 'just now';
  if (ageMinutes === 1) return '1 min ago';
  if (ageMinutes < 60) return `${ageMinutes} min ago`;

  const ageHours = Math.floor(ageMinutes / 60);
  return ageHours === 1 ? '1 hr ago' : `${ageHours} hr ago`;
}

export function DepthLegend() {
  const backdropTone = useGlobeStore(selectBackdropTone);
  const status = useEarthquakeStore((state) => state.status);
  const lastSyncedAt = useEarthquakeStore((state) => state.lastSyncedAt);
  const refresh = useEarthquakeStore((state) => state.refresh);
  const minMagnitude = useEarthquakeStore((state) => state.minMagnitude);
  const windowHours = useEarthquakeStore((state) => state.windowHours);
  const visibleCount = useVisibleEarthquakes().length;
  const colors = depthLegendColors(backdropTone);

  // The boundary key only earns its space while that layer is actually on.
  const layerVisibility = useGlobeStore((state) => state.layerVisibility);
  const isLayerOn = (id: string): boolean => {
    const entry = OVERLAY_REGISTRATIONS.find((e) => e.id === id);
    return entry !== undefined && isOverlayVisible(entry, layerVisibility);
  };
  const boundariesVisible = isLayerOn('plate-boundaries');
  const subductionVisible = isLayerOn('subduction-zones');
  const faultsVisible = isLayerOn('active-faults');

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
                style={{ borderColor: emphasisRingColorHex(backdropTone) }}
              />
            </span>
            <span className={styles.binLabel}>M{EMPHASIS_MAGNITUDE_THRESHOLD}+</span>
          </li>
        </ul>
      </div>

      {boundariesVisible && (
        <div className={styles.section}>
          <h2 className={styles.heading}>Plate boundaries</h2>
          <ul className={styles.binList}>
            {KINEMATIC_GROUPS.map((group) => (
              <li key={group} className={styles.binRow}>
                <span
                  className={styles.lineSwatch}
                  style={{
                    backgroundColor: kinematicColorHex(group, backdropTone),
                    height: group === 'convergent' ? '3px' : '2px',
                  }}
                  aria-hidden="true"
                />
                <span className={styles.binLabel}>{KINEMATIC_LABELS[group]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {subductionVisible && (
        <div className={styles.section}>
          <h2 className={styles.heading}>Subduction</h2>
          <ul className={styles.binList}>
            <li className={styles.binRow}>
              <span className={styles.toothSwatch} aria-hidden="true">
                <svg viewBox="0 0 24 10" width="18" height="8">
                  <path
                    d="M0 9 H24 M4 9 L8 2 L12 9 M13 9 L17 2 L21 9"
                    fill={kinematicColorHex('convergent', backdropTone)}
                    stroke={kinematicColorHex('convergent', backdropTone)}
                    strokeWidth="1.5"
                  />
                </svg>
              </span>
              <span className={styles.binLabel}>teeth point down-dip</span>
            </li>
          </ul>
        </div>
      )}

      {faultsVisible && (
        <div className={styles.section}>
          <h2 className={styles.heading}>Faults</h2>
          <ul className={styles.binList}>
            <li className={styles.binRow}>
              <span
                className={styles.lineSwatch}
                style={{ backgroundColor: faultColorHex(backdropTone), height: '1px' }}
                aria-hidden="true"
              />
              <span className={styles.binLabel}>active fault</span>
            </li>
          </ul>
          {/* Without this, a sparse region reads as "no faults here" when it
              actually means "not zoomed in far enough yet". */}
          <p className={styles.note}>shorter faults appear as you zoom in</p>
        </div>
      )}

      <p className={styles.footnote}>
        {status === 'loading'
          ? 'Loading…'
          : status === 'error'
            ? 'Failed to load'
            : `${visibleCount} events · ${formatWindow(windowHours)} · M${minMagnitude}+`}
        {status !== 'loading' && (
          <span className={styles.freshness}>
            updated {formatFreshness(lastSyncedAt)}
            {/* On-demand freshness, so the background poll can stay slow
                enough not to interrupt a rotation. */}
            <button
              type="button"
              id="earthquake-refresh"
              className={styles.refreshButton}
              onClick={() => void refresh()}
            >
              Refresh
            </button>
          </span>
        )}
        {/* ODC-BY makes the Bird credit a licence condition, not a courtesy.
            Slab2 is CC0 and needs no attribution at all — it's cited because
            citing your sources is right, not because we're obliged to. */}
        {boundariesVisible && (
          <span className={styles.attribution}>
            Plates: Bird (2003) · Ahlenius/Nordpil · ODC-BY
          </span>
        )}
        {subductionVisible && (
          <span className={styles.attribution}>
            Slabs: Hayes et al. (2018) · USGS Slab2 · CC0
          </span>
        )}
        {/* CC-BY-SA makes this credit mandatory, like the Bird one. */}
        {faultsVisible && (
          <span className={styles.attribution}>
            Faults: GEM Global Active Faults · Styron &amp; Pagani (2020) · CC-BY-SA 4.0
          </span>
        )}
      </p>
    </div>
  );
}
