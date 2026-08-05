import { useState } from 'react';
import { useGlobeStore, selectBackdropTone } from '../state/useGlobeStore';
import { useEarthquakeStore } from '../state/useEarthquakeStore';
import { useEarthquakesUpToPlayhead } from '../globe/useVisibleEarthquakes';
import { KINEMATIC_GROUPS, KINEMATIC_LABELS, kinematicColorHex } from '../layers/plate-kinematics';
import { faultColorHex } from '../layers/fault-encoding';
import { formatRange } from './RangeControls';
import { OVERLAY_REGISTRATIONS, isOverlayVisible } from '../layers/registry';
import {
  DEPTH_BINS,
  EMPHASIS_MAGNITUDE_THRESHOLD,
  RECENT_HALO_WIDTH,
  RECENT_WINDOW_HOURS,
  UNKNOWN_DEPTH_COLOR,
  depthLegendColors,
  emphasisRingColorHex,
  magnitudePixelSize,
  recentHaloColorHex,
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
  /**
   * Collapsed state is local rather than in the globe store.
   *
   * Nothing else needs to read it, and it isn't part of what the globe is
   * showing — putting it in shared state would make every legend toggle a
   * store write that other subscribers have to ignore.
   */
  const [collapsed, setCollapsed] = useState(false);
  const backdropTone = useGlobeStore(selectBackdropTone);
  const status = useEarthquakeStore((state) => state.status);
  const lastSyncedAt = useEarthquakeStore((state) => state.lastSyncedAt);
  const refresh = useEarthquakeStore((state) => state.refresh);
  const minMagnitude = useEarthquakeStore((state) => state.minMagnitude);
  const isolateBand = useEarthquakeStore((state) => state.isolateBand);
  const windowHours = useEarthquakeStore((state) => state.windowHours);
  // Counts what's on screen, which during playback is fewer than the window
  // holds — a footnote claiming 900 events while 40 are drawn would be wrong.
  const visible = useEarthquakesUpToPlayhead();
  const visibleCount = visible.length;
  const colors = depthLegendColors(backdropTone);

  // Only earns a row when one is actually on screen. Unknown depth is a
  // handful of pre-1980 events in a 295k archive, so a permanent swatch would
  // be clutter that implies the case is common.
  const hasUnknownDepth = visible.some((event) => event.depthKm === null);

  // The boundary key only earns its space while that layer is actually on.
  const layerVisibility = useGlobeStore((state) => state.layerVisibility);
  const isLayerOn = (id: string): boolean => {
    const entry = OVERLAY_REGISTRATIONS.find((e) => e.id === id);
    return entry !== undefined && isOverlayVisible(entry, layerVisibility);
  };
  const boundariesVisible = isLayerOn('plate-boundaries');
  const subductionVisible = isLayerOn('subduction-zones');
  const faultsVisible = isLayerOn('active-faults');

  if (collapsed) {
    return (
      <button
        type="button"
        id="depth-legend-open"
        className={styles.collapsedButton}
        aria-label="Show legend"
        aria-expanded={false}
        aria-controls="depth-legend"
        onClick={() => setCollapsed(false)}
      >
        {/* The depth ramp in miniature, from the same colours the swatches use. */}
        {colors.map((color, index) => (
          <span
            key={index}
            className={styles.iconSwatch}
            style={{ backgroundColor: color }}
            aria-hidden="true"
          />
        ))}
      </button>
    );
  }

  return (
    <div id="depth-legend" className={styles.legend}>
      <div className={styles.legendHeader}>
        <h2 className={styles.legendTitle}>Legend</h2>
        <button
          type="button"
          id="depth-legend-close"
          className={styles.closeButton}
          aria-label="Hide legend"
          aria-expanded
          aria-controls="depth-legend"
          onClick={() => setCollapsed(true)}
        >
          ×
        </button>
      </div>

      {/* Depth and Magnitude are both keys to the dot itself — colour and
          size — so they pair as columns, and the taller of the two sets the
          height instead of their sum. */}
      <div className={styles.columns}>
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
            {hasUnknownDepth && (
              <li className={styles.binRow}>
                <span
                  className={styles.swatch}
                  style={{ backgroundColor: UNKNOWN_DEPTH_COLOR }}
                  aria-hidden="true"
                />
                <span className={styles.binLabel}>not reported</span>
              </li>
            )}
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

            {/*
              The ring and the recency stroke live here rather than in a
              section of their own. Both are marks *on the dot*, like the sizes
              above them — floated off on their own they read as belonging to
              nothing, which is exactly how they looked.

              The separator is a hairline rather than a gap: these two are
              modifiers of a mark, not another scale, and a full section break
              would overstate the distance.
            */}
            <li className={`${styles.magnitudeRow} ${styles.rowGroupStart}`}>
              <span className={styles.magnitudeDotCell} aria-hidden="true">
                <span
                  className={styles.emphasisRing}
                  style={{ borderColor: emphasisRingColorHex(backdropTone) }}
                />
              </span>
              <span className={styles.binLabel}>M{EMPHASIS_MAGNITUDE_THRESHOLD}+</span>
            </li>
            {/* The two are independent: a recent large event shows both. */}
            <li className={styles.magnitudeRow}>
              <span className={styles.magnitudeDotCell} aria-hidden="true">
                <span
                  className={styles.magnitudeDot}
                  style={{
                    width: `${magnitudePixelSize(4)}px`,
                    height: `${magnitudePixelSize(4)}px`,
                    outline: `${RECENT_HALO_WIDTH}px solid ${recentHaloColorHex(backdropTone)}`,
                    outlineOffset: '-1px',
                  }}
                />
              </span>
              <span className={styles.binLabel}>past {RECENT_WINDOW_HOURS}h</span>
            </li>
          </ul>
        </div>
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
            : `${visibleCount} events · ${formatWindow(windowHours)} · ${formatRange(minMagnitude, isolateBand)}`}
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
          <span className={styles.attribution}>Slabs: Hayes et al. (2018) · USGS Slab2 · CC0</span>
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
