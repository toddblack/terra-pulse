import { useState } from 'react';
import type { BackdropTone } from '@terra-pulse/schema';
import { useNow } from '../globe/useNow';
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
import { GEOMAGNETIC_FIELD_LAYER_ID } from '../layers/geomagnetic-field';
import { AURORA_LAYER_ID } from '../layers/aurora-layer';
import { MAGNETOPAUSE_LAYER_ID } from '../layers/magnetopause-layer';
import { TEC_LAYER_ID } from '../layers/tec-layer';
import { LayerGuideButton } from './LayerGuideModal';
import { TEC_SCALES, tecLegendStops } from '../layers/tec-encoding';
import { tecIsStale, tecPeak, type TecQuantity } from '@terra-pulse/schema';
import {
  dynamicPressureNPa,
  GEOSYNCHRONOUS_RE,
  magnetopauseStandoff,
} from '../layers/magnetopause';
import { useSolarWindAt } from './useSpaceWeather';
import { displayWindow } from '../globe/display-window';
import { auroraLegendStops } from '../layers/aurora-encoding';
import { AURORA_MAX_PROBABILITY, auroraIsStale, auroraPeak } from '@terra-pulse/schema';
import { FIELD_SCALES, fieldLegendStops } from '../layers/field-encoding';
import { IGRF_FIRST_YEAR, IGRF_LAST_YEAR, decimalYear, igrfCoverage } from '../layers/igrf';
import styles from './DepthLegend.module.css';
import { formatAgoFrom, formatDuration } from './time-labels';

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
  return formatAgoFrom(lastSyncedAt, Date.now()) ?? 'not yet synced';
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
  const fieldVisible = isLayerOn(GEOMAGNETIC_FIELD_LAYER_ID);
  const auroraVisible = isLayerOn(AURORA_LAYER_ID);
  const magnetopauseVisible = isLayerOn(MAGNETOPAUSE_LAYER_ID);
  const tecVisible = isLayerOn(TEC_LAYER_ID);

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

      {fieldVisible && <FieldKey tone={backdropTone} />}

      {auroraVisible && <AuroraKey />}

      {tecVisible && <TecKey tone={backdropTone} />}

      {magnetopauseVisible && <MagnetopauseKey />}

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

/**
 * The magnetic field key.
 *
 * Exists because the layer was unreadable without it — a blue wash with no
 * units, no scale and no indication of *when* it was. Three things it has to
 * say, in order of how badly they were missed:
 *
 * 1. **Which year is drawn.** The layer follows the playhead, and over the
 *    default 72-hour window the field moves 1.1 nT against a 50,000 nT scale —
 *    invisible, so the scrubber reads as broken. Naming the year makes the
 *    layer's behaviour legible, and the note says where change is actually
 *    visible.
 * 2. **What the colours mean**, with units.
 * 3. **Where the scale stops.** Declination's ramp is clamped at 30 degrees, so
 *    its ends are a floor and a ceiling rather than measurements, and the
 *    labels carry the sign.
 */
function FieldKey({ tone }: { tone: BackdropTone }) {
  const quantity = useGlobeStore((state) => state.fieldQuantity);
  const playheadMs = useEarthquakeStore((state) => state.playheadMs);
  const nowMs = useNow();

  const scale = FIELD_SCALES[quantity];
  const stops = fieldLegendStops(quantity, tone, 5);

  const year = decimalYear(new Date(playheadMs ?? nowMs));
  const { covered, clampedYear } = igrfCoverage(year);

  const format = (value: number): string =>
    quantity === 'intensity'
      ? `${Math.round(value / 1000).toString()}k`
      : `${value > 0 ? '+' : ''}${Math.round(value).toString()}`;

  const first = stops[0];
  const last = stops[stops.length - 1];

  return (
    <div className={styles.section}>
      <h2 className={styles.heading}>
        Magnetic field · {Math.floor(clampedYear)}
        <LayerGuideButton layerId={GEOMAGNETIC_FIELD_LAYER_ID} />
      </h2>

      <div className={styles.fieldRamp} aria-hidden="true">
        {stops.map((stop) => (
          <span
            key={stop.value}
            className={styles.fieldRampStep}
            style={{ backgroundColor: stop.color }}
          />
        ))}
      </div>

      <div className={styles.fieldScaleRow}>
        <span>
          {scale.clamped ? '≤' : ''}
          {format(first?.value ?? 0)}
        </span>
        <span>{scale.unit}</span>
        <span>
          {scale.clamped ? '≥' : ''}
          {format(last?.value ?? 0)}
        </span>
      </div>

      <p className={styles.note}>
        {scale.label}
        {scale.diverging ? (
          <>
            {' '}· neutral band is{' '}
            {quantity === 'declination' ? 'where a compass points true north' : 'the magnetic equator'}
          </>
        ) : null}
      </p>

      {/* The answer to "why does the scrubber do nothing". */}
      <p className={styles.note}>
        {covered
          ? 'changes over decades — scrub a History span to see it move'
          : `outside ${IGRF_FIRST_YEAR.toString()}–${IGRF_LAST_YEAR.toString()}; showing ${Math.floor(clampedYear).toString()}`}
      </p>
    </div>
  );
}

/**
 * The aurora key.
 *
 * Three things it has to carry, and the last two are the point:
 *
 * 1. What the greens mean — probability of visible aurora.
 * 2. **When the reading is from.** This is the only live layer in the app.
 *    Everything else is a catalogue that is true whenever you look at it; this
 *    is a forecast of a transient, and one twenty minutes old may describe a
 *    storm that has already moved.
 * 3. **That it does not follow the playhead.** There is no archive of past
 *    grids, so scrubbing to 1975 cannot show the aurora of 1975 — and leaving
 *    the current oval on screen while the playhead sits in the past, unlabelled,
 *    would be a straightforward lie about what is being drawn.
 */
function AuroraKey() {
  const grid = useGlobeStore((state) => state.auroraGrid);
  const playheadMs = useEarthquakeStore((state) => state.playheadMs);
  const nowMs = useNow();

  if (!grid) {
    return (
      <div className={styles.section}>
        <h2 className={styles.heading}>Aurora</h2>
        {/* Not cached to disk — it is a forecast of a transient, superseded
            every five minutes. Offline this stays empty rather than showing an
            oval from whenever the app last had a connection. */}
        <p className={styles.note}>waiting for the first reading from NOAA SWPC</p>
      </div>
    );
  }

  const stale = auroraIsStale(grid, nowMs);
  const peak = auroraPeak(grid);
  const observed = new Date(grid.observedAtUtc);

  return (
    <div className={styles.section}>
      <h2 className={styles.heading}>Aurora · peak {peak}%</h2>

      <div className={styles.fieldRamp} aria-hidden="true">
        {auroraLegendStops().map((stop) => (
          <span
            key={stop.value}
            className={styles.fieldRampStep}
            style={{ backgroundColor: stop.color }}
          />
        ))}
      </div>

      <div className={styles.fieldScaleRow}>
        <span>low</span>
        <span>chance of visible aurora</span>
        <span>{AURORA_MAX_PROBABILITY}%+</span>
      </div>

      <p className={styles.note}>
        {stale
          ? `reading is ${formatDuration(nowMs - observed.getTime())} old — may be out of date`
          : `observed ${formatDuration(nowMs - observed.getTime())} ago · forecast for ${new Date(
              grid.forecastForUtc,
            ).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`}
      </p>

      {/* Only worth saying while the playhead is actually elsewhere. */}
      {playheadMs !== null && (
        <p className={styles.note}>live only — does not follow the scrubber</p>
      )}
    </div>
  );
}

/**
 * The magnetopause key.
 *
 * Four things, and three of them are caveats — which is what a layer drawing
 * model output has to carry.
 *
 * 1. **Where the boundary is**, in Earth radii, so the drawing has a number.
 * 2. **That it is a model**, not a measurement. Everything else on this globe
 *    is an observation or a mapped feature.
 * 3. **When it is extrapolating.** Shue et al. fitted roughly 0.5-8.5 nPa and
 *    Bz -18 to +15 nT. 3.8% of the stored record falls outside that, and it is
 *    disproportionately the large storms — the exact hours a reader zooms in
 *    on. Extrapolating silently there would be the layer's worst failure.
 * 4. **When it cannot be computed at all**, which is common: the solar wind is
 *    32-42% present across 1985-1994 and absent entirely before 1963. Nothing
 *    is drawn then, and this says why rather than leaving an empty sky.
 *
 * The shape is recomputed here from the same pure functions the layer uses, on
 * the same inputs, rather than read back off the layer instance. They cannot
 * disagree — and reaching into a mounted Cesium layer for a number would be a
 * second channel to keep in sync.
 */
function MagnetopauseKey() {
  const windowHours = useEarthquakeStore((state) => state.windowHours);
  const playheadMs = useEarthquakeStore((state) => state.playheadMs);
  const trailingWindow = useEarthquakeStore((state) => state.trailingWindow);
  const nowMs = useNow();
  const { endMs } = displayWindow(windowHours, playheadMs, trailingWindow, nowMs);
  const wind = useSolarWindAt(endMs);

  if (wind?.windSpeed == null || wind.density == null || wind.bzGsm == null) {
    return (
      <div className={styles.section}>
        <h2 className={styles.heading}>
          Magnetopause
          <LayerGuideButton layerId={MAGNETOPAUSE_LAYER_ID} />
        </h2>
        <p className={styles.note}>
          no solar wind measured at this hour — the boundary is not drawn rather
          than estimated
        </p>
      </div>
    );
  }

  const pressure = dynamicPressureNPa(wind.density, wind.windSpeed);
  const shape = magnetopauseStandoff(wind.bzGsm, pressure);

  return (
    <div className={styles.section}>
      <h2 className={styles.heading}>
        Magnetopause · {shape.standoffRe.toFixed(1)} R<sub>E</sub>
        <LayerGuideButton layerId={MAGNETOPAUSE_LAYER_ID} />
      </h2>

      <p className={styles.note}>
        {wind.windSpeed.toFixed(0)} km/s · {wind.density.toFixed(1)} cm⁻³ · Bz{' '}
        {wind.bzGsm.toFixed(1)} nT → {pressure.toFixed(1)} nPa
      </p>

      {shape.insideGeosynchronous && (
        <p className={styles.note}>
          inside geosynchronous orbit ({GEOSYNCHRONOUS_RE} R<sub>E</sub>) — satellites
          there are in unshielded solar wind
        </p>
      )}

      {/* Not a footnote: outside the fitted range the number is an
          extrapolation, and that is most likely exactly when someone is
          looking. */}
      {shape.extrapolated && (
        <p className={styles.note}>
          beyond the range Shue et al. fitted — extrapolated, treat as indicative
        </p>
      )}

      <p className={styles.note}>
        modelled boundary (Shue et al. 1998), not an observation
      </p>
    </div>
  );
}

/**
 * The ionosphere key.
 *
 * Carries four things, and the last two are why it exists at all:
 *
 * 1. What the ramp means, and which quantity is being drawn.
 * 2. **The quantity toggle.** The anomaly is the analytically useful view and
 *    raw TEC is the intuitive one — raw content is dominated by local time, so a
 *    plain TEC map mostly draws the day/night terminator. Both are one click
 *    apart rather than one of them being unreachable.
 * 3. **When the map is from.** Live, superseded every ten minutes, and about
 *    half an hour behind real time in normal operation.
 * 4. **That it does not follow the scrubber.** SWPC indexes a month of past maps
 *    but nothing here stores them, so scrubbing cannot show the ionosphere of
 *    then — and leaving the current map up unlabelled while the playhead sits in
 *    the past would misrepresent what is drawn.
 */
function TecKey({ tone }: { tone: BackdropTone }) {
  const grid = useGlobeStore((state) => state.tecGrid);
  const quantity = useGlobeStore((state) => state.tecQuantity);
  const setTecQuantity = useGlobeStore((state) => state.setTecQuantity);
  const playheadMs = useEarthquakeStore((state) => state.playheadMs);
  const nowMs = useNow();

  const scale = TEC_SCALES[quantity];
  const stops = tecLegendStops(quantity, tone, 5);
  const first = stops[0];
  const last = stops[stops.length - 1];

  const options: { id: TecQuantity; label: string }[] = [
    { id: 'tec', label: 'total' },
    { id: 'anomaly', label: 'vs expected' },
  ];

  if (!grid) {
    return (
      <div className={styles.section}>
        <h2 className={styles.heading}>
          Ionosphere
          <LayerGuideButton layerId={TEC_LAYER_ID} />
        </h2>
        {/* Fetched on demand rather than polled — a map is 2.4 MB, so nothing
            moves until this layer is on. */}
        <p className={styles.note}>fetching the latest map from NOAA SWPC…</p>
      </div>
    );
  }

  const peak = tecPeak(grid);
  const stale = tecIsStale(grid, nowMs);
  const observed = Date.parse(grid.observedAtUtc);

  return (
    <div className={styles.section}>
      <h2 className={styles.heading}>
        Ionosphere{peak === null ? '' : ` · peak ${Math.round(peak).toString()} TECU`}
        <LayerGuideButton layerId={TEC_LAYER_ID} />
      </h2>

      <div className={styles.fieldRamp} aria-hidden="true">
        {stops.map((stop) => (
          <span
            key={stop.value}
            className={styles.fieldRampStep}
            style={{ backgroundColor: stop.color }}
          />
        ))}
      </div>

      <div className={styles.fieldScaleRow}>
        <span>
          {scale.clamped && quantity === 'anomaly' ? '≤' : ''}
          {Math.round(first?.value ?? 0).toString()}
        </span>
        <span>{scale.unit}</span>
        <span>
          {scale.clamped ? '≥' : ''}
          {Math.round(last?.value ?? 0).toString()}
        </span>
      </div>

      <div className={styles.quantityRow}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={
              option.id === quantity
                ? `${styles.quantityButton} ${styles.quantityButtonActive}`
                : styles.quantityButton
            }
            onClick={() => setTecQuantity(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <p className={styles.note}>
        {quantity === 'anomaly'
          ? 'departure from the quiet-time expectation — neutral means as expected'
          : 'electrons in a column overhead · highest in the two equatorial crests'}
      </p>

      <p className={styles.note}>
        {stale
          ? `map is ${formatDuration(nowMs - observed)} old — the feed may have stopped`
          : `map for ${formatDuration(nowMs - observed)} ago`}
      </p>

      {playheadMs !== null && (
        <p className={styles.note}>live only — does not follow the scrubber</p>
      )}
    </div>
  );
}
