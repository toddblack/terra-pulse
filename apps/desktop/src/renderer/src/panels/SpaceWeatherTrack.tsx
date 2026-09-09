import { useCallback, useMemo, useRef, useState } from 'react';
import {
  downsampleSpaceWeather,
  DST_STORM_THRESHOLD,
  FAST_WIND_THRESHOLD,
  KP_MAX,
  KP_STORM_THRESHOLD,
  WIND_SPEED_MAX,
  XRAY_EMPHASIS_FLUX,
  XRAY_FLUX_MAX,
  XRAY_FLUX_MIN,
  STATION_DISTURBED_NT,
  type SpaceWeatherSample,
} from '@terra-pulse/schema';
import { useEarthquakeStore, selectEventById } from '../state/useEarthquakeStore';
import { useNow } from '../globe/useNow';
import { displayWindow } from '../globe/display-window';
import { useEarthquakesUpToPlayhead } from '../globe/useVisibleEarthquakes';
import { useSpaceWeather } from './useSpaceWeather';
import {
  bucketsForWidth,
  COVERAGE_CAPTION_BELOW,
  fluxToClassLabel,
  GEOMAGNETIC_SPEC,
  heightOf,
  layoutTrack,
  measuredFraction,
  nearestBarIndex,
  peakOf,
  SOLAR_WIND_SPEC,
  ticksForWidth,
  trackTicks,
  XRAY_SPEC,
  type TrackBar,
} from './space-weather-track';
import {
  EARTHQUAKE_MAGNITUDE_MAX,
  layoutEarthquakeTrack,
  peakEarthquake,
  type EarthquakeBar,
} from './earthquake-track';
import {
  nearestPointIndex,
  polylinePoints,
  sampleTidalStress,
  TIDAL_PERIOD_HOURS,
  TIDAL_TRACK_MAX_WINDOW_HOURS,
  type TidalStressSeries,
} from './tidal-stress-track';
import { useTidalStressPlane, type TidalPlaneState } from './useTidalStressPlane';
import {
  layoutMagnetometerTrack,
  MAGNETOMETER_MAX_WINDOW_HOURS,
  MAGNETOMETER_RANGE_MAX_NT,
  MAGNETOMETER_RANGE_MIN_NT,
  peakMagnetometer,
  type MagnetometerBar,
} from './magnetometer-track';
import { useMagnetometerRow, type MagnetometerRowState } from './useMagnetometerSeries';
import { isTrackVisible, TRACK_ROWS, trackGuideIdFor } from './track-rows';
import { useGlobeStore } from '../state/useGlobeStore';
import { LayerGuideButton } from './LayerGuideModal';
import styles from './SpaceWeatherTrack.module.css';

/** Assumed track width until the element measures itself. */
const FALLBACK_WIDTH = 480;

/** Nothing hovered. */
const NO_BAR = -1;

/**
 * Stable empty series.
 *
 * A fresh `[]` while loading is a new identity every render, which would
 * re-run the layout memo continuously — the same trap `EMPTY_HITS` exists for
 * in the viewer.
 */
const NO_SAMPLES: readonly SpaceWeatherSample[] = [];

/** `12 Aug 14:00`, which is as much as a readout needs beside a labelled axis. */
function formatBarTime(timeUtc: string): string {
  return timeUtc.slice(0, 16).replace('T', ' ');
}

/**
 * One row's readout for the hovered interval.
 *
 * Values lead and labels follow — the reader has the time from the axis and
 * wants the numbers. The peak is named only when it differs from the typical,
 * because at short windows a bucket is a single hour and "450, peak 450" is
 * noise dressed as information.
 */
function describeBar(
  bar: TrackBar,
  format: (value: number) => string,
  secondary: (value: number) => string,
  withTime: boolean,
): string {
  const parts: string[] = [];
  // Only the top row names the hour. The rows are read as one block and always
  // show the same instant, so repeating it is redundancy, not clarity.
  if (withTime) parts.push(formatBarTime(bar.timeUtc));
  if (bar.hours > 1) parts.push(`${String(bar.hours)} h`);

  if (bar.unmeasured) {
    // Explicitly, rather than an em dash that reads as "zero" at a glance.
    parts.push('not measured');
  } else if (bar.typical === null) {
    parts.push('—');
  } else if (bar.peak !== null && bar.peak > bar.typical) {
    parts.push(`${format(bar.typical)}, peak ${format(bar.peak)}`);
  } else {
    parts.push(format(bar.typical));
  }

  if (bar.secondary !== null) parts.push(secondary(bar.secondary));

  return parts.join(' · ');
}

/** The earthquake row's readout — magnitude and count, not a bar/cap pair. */
function describeEarthquakeBar(bar: EarthquakeBar): string {
  if (bar.magnitude === null) return 'no events';
  const events = bar.count === 1 ? '1 event' : `${String(bar.count)} events`;
  return `M${bar.magnitude.toFixed(1)} · ${events}`;
}

/**
 * The tidal row's readout and caption use **kPa, matching `TidalShear.tsx`** —
 * the same quantity printed two places in this app must not carry two units.
 * A magnitude, again matching that panel: the curve is what carries the sign,
 * and a single number cannot (see `tidal-stress-track.ts`).
 */
function formatShear(shearPa: number): string {
  const kPa = Math.abs(shearPa) / 1000;
  return `${kPa < 0.01 ? '<0.01' : kPa.toFixed(2)} kPa`;
}

/** 3px at nothing recorded up to 9px at the fixed magnitude ceiling. */
const MIN_DOT_PX = 3;
const MAX_DOT_PX = 9;
function earthquakeDotPx(magnitude: number): number {
  const t = Math.min(Math.max(magnitude, 0), EARTHQUAKE_MAGNITUDE_MAX) / EARTHQUAKE_MAGNITUDE_MAX;
  return MIN_DOT_PX + t * (MAX_DOT_PX - MIN_DOT_PX);
}

/**
 * Kp, Dst and the solar wind on the same time axis as the globe.
 *
 * ## Why it shares `displayWindow`
 *
 * The whole value of the track is that a spike lines up with the earthquakes on
 * screen. It therefore has to use the *same* definition of the visible span as
 * the globe and the event list, not a second expression that happens to agree —
 * which is exactly the drift `displayWindow` was extracted to prevent.
 *
 * ## Two rows, one axis, one hover
 *
 * Kp runs 0-9, wind speed 250-900 km/s and Dst 0 to -600 nT. Two of those
 * cannot share a y-axis without one of them lying, so they get a row each and
 * share the x — which is what makes "did the wind arrive before the storm?" a
 * question you can answer by looking straight down the column.
 *
 * The hover index is deliberately **shared**: pointing at an hour reads out
 * every row at that hour, rather than making the reader hunt for the same
 * moment twice.
 *
 * ## Why the primary quantity sizes the bars and the secondary only marks them
 *
 * Kp is bounded 0-9 and speed is effectively bounded, so fixed scales are
 * honest and a bar means the same thing in every view. Dst is unbounded below
 * and Bz swings both ways: a single -589 nT hour would flatten every other bar
 * in the record, and that hour is precisely what you want to see *in context*.
 */
export function SpaceWeatherTrack() {
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  // A fraction of the track (0-1), not a bar index. Bucket *counts* genuinely
  // differ between rows — `downsampleSpaceWeather` caps its output at
  // `Math.min(count, samples.length)`, so a live window with fewer hourly
  // samples than the pixel-derived bucket count gives the Kp/wind/flux rows
  // *fewer* bars than the earthquake row's `layoutEarthquakeTrack`, which
  // always makes exactly `count`. Sharing one raw index across arrays of
  // different lengths was the actual bug this replaced: at the live edge,
  // the shared index (valid against the shorter geomagnetic array) pointed
  // at roughly a third of the way into the longer earthquake array — found
  // in the field, not by a test. A fraction means the same position no
  // matter how many bars a row ended up with; each row resolves its own
  // nearest bar from it below.
  const [hoveredFraction, setHoveredFraction] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);

  const windowHours = useEarthquakeStore((state) => state.windowHours);
  const playheadMs = useEarthquakeStore((state) => state.playheadMs);
  const trailingWindow = useEarthquakeStore((state) => state.trailingWindow);
  const nowMs = useNow();

  const visibleTracks = useGlobeStore((state) => state.visibleTracks);
  const showGeomagnetic = isTrackVisible('geomagnetic', visibleTracks);
  const showSolarWind = isTrackVisible('solar-wind', visibleTracks);
  const showXray = isTrackVisible('xray-flux', visibleTracks);
  const showEarthquakes = isTrackVisible('earthquakes', visibleTracks);
  const showTidalStress = isTrackVisible('tidal-stress', visibleTracks);
  const showMagnetometer = isTrackVisible('magnetometer', visibleTracks);

  const { startMs, endMs } = useMemo(
    () => displayWindow(windowHours, playheadMs, trailingWindow, nowMs),
    [windowHours, playheadMs, trailingWindow, nowMs],
  );

  const state = useSpaceWeather(startMs, endMs);
  const samples = state.status === 'ready' ? state.samples : NO_SAMPLES;

  // Same projection the globe, the event list and the legend's count use —
  // "what's actually on screen right now" — so this row cannot show an
  // earthquake the globe itself is hiding, or vice versa.
  const earthquakeEvents = useEarthquakesUpToPlayhead();

  // The *nominal* bucket count for the pixel width — not the number of bars
  // any given row actually ends up with. `downsampleSpaceWeather` caps its
  // output at `Math.min(bucketCount, samples.length)`, so a row backed by
  // sparse data can have fewer. Used directly only for the earthquake row
  // (which always makes exactly this many) and for sizing a keyboard step.
  const bucketCount = useMemo(() => bucketsForWidth(width), [width]);

  // Bucketed once and laid out three times: all three space-weather rows
  // must land on identical x positions or reading down a column would
  // compare different hours. The earthquake row uses `bucketCount` directly
  // rather than `downsampleSpaceWeather`'s index-based scheme — see
  // `earthquake-track.ts` for why an irregular point series needs bins cut
  // from the window itself.
  const { geomagnetic, solarWind, xray, earthquakes } = useMemo(() => {
    const reduced = downsampleSpaceWeather(samples, bucketCount);
    const barWidth = 1 / Math.max(bucketCount, 1);
    return {
      geomagnetic: layoutTrack(reduced, startMs, endMs, barWidth, GEOMAGNETIC_SPEC),
      solarWind: layoutTrack(reduced, startMs, endMs, barWidth, SOLAR_WIND_SPEC),
      xray: layoutTrack(reduced, startMs, endMs, barWidth, XRAY_SPEC),
      earthquakes: layoutEarthquakeTrack(earthquakeEvents, startMs, endMs, bucketCount),
    };
  }, [samples, startMs, endMs, bucketCount, earthquakeEvents]);

  const ticks = useMemo(
    () => trackTicks(startMs, endMs, ticksForWidth(width)),
    [startMs, endMs, width],
  );

  const peak = useMemo(() => peakOf(samples), [samples]);
  const earthquakePeak = useMemo(() => peakEarthquake(earthquakes), [earthquakes]);

  // The tidal row resolves stress onto whichever fault the current selection
  // points at — see `useTidalStressPlane`. Both this and the sampling below are
  // gated on the row's visibility, so a switched-off row costs nothing: the
  // fault sweep is ~1.1 ms and the series is up to 1,200 ephemeris evaluations.
  const tidalPlane = useTidalStressPlane(showTidalStress);
  const tidalSeries = useMemo<TidalStressSeries | null>(() => {
    if (!showTidalStress || tidalPlane.kind !== 'ready') return null;
    return sampleTidalStress(tidalPlane.plane, startMs, endMs);
  }, [showTidalStress, tidalPlane, startMs, endMs]);

  // Same shape as the tidal row: gated on visibility, so a switched-off row
  // never reaches the network. Its bars share the earthquake row's bucketing
  // rather than `downsampleSpaceWeather`'s, because a magnetometer trace has
  // real gaps and index slicing would stop being equal-time.
  const magnetometerRow = useMagnetometerRow(showMagnetometer, startMs, endMs);
  const magnetometerBars = useMemo<MagnetometerBar[]>(
    () =>
      magnetometerRow.kind === 'ready'
        ? layoutMagnetometerTrack(
            magnetometerRow.series.samples,
            startMs,
            endMs,
            bucketCount,
            STATION_DISTURBED_NT,
          )
        : [],
    [magnetometerRow, startMs, endMs, bucketCount],
  );
  const magnetometerPeak = useMemo(
    () => peakMagnetometer(magnetometerBars),
    [magnetometerBars],
  );
  const magnetometerHovered = useMemo(
    () =>
      hoveredFraction === null ? NO_BAR : nearestBarIndex(magnetometerBars, hoveredFraction),
    [magnetometerBars, hoveredFraction],
  );

  const tidalHovered = useMemo(
    () =>
      hoveredFraction === null || tidalSeries === null
        ? NO_BAR
        : nearestPointIndex(tidalSeries.points, hoveredFraction),
    [tidalSeries, hoveredFraction],
  );

  // Each row resolves the shared fraction against its *own* bars — see the
  // note on `hoveredFraction` above for why this can't be one shared index.
  const geoHovered = useMemo(
    () => (hoveredFraction === null ? NO_BAR : nearestBarIndex(geomagnetic, hoveredFraction)),
    [geomagnetic, hoveredFraction],
  );
  const windHovered = useMemo(
    () => (hoveredFraction === null ? NO_BAR : nearestBarIndex(solarWind, hoveredFraction)),
    [solarWind, hoveredFraction],
  );
  const xrayHovered = useMemo(
    () => (hoveredFraction === null ? NO_BAR : nearestBarIndex(xray, hoveredFraction)),
    [xray, hoveredFraction],
  );
  const quakeHovered = useMemo(
    () => (hoveredFraction === null ? NO_BAR : nearestBarIndex(earthquakes, hoveredFraction)),
    [earthquakes, hoveredFraction],
  );

  // §5.5: "click any quake → the timeline centers on it." The window never
  // actually needs to move to satisfy that — a quake is only clickable while
  // its dot is shown, which means its time already fell inside the currently
  // displayed window — so "centering" is a persistent guide line at its exact
  // position rather than a change to windowHours/playheadMs. Moving the
  // window instead would risk hiding *other* events between the clicked one
  // and now, in live mode, for a feature whose whole point is orientation.
  const selectedEventId = useEarthquakeStore((state) => state.selectedEventId);
  const selectedEvent = useEarthquakeStore((state) => selectEventById(state, selectedEventId));
  const selectedFraction = useMemo(() => {
    if (selectedEvent === null) return null;
    const eventMs = Date.parse(selectedEvent.timeUtc);
    if (!Number.isFinite(eventMs) || endMs <= startMs) return null;
    const fraction = (eventMs - startMs) / (endMs - startMs);
    // Not clamped — out of [0,1] means the selection is a stale one whose
    // window has since moved on, and drawing it off-track would be wrong in
    // a way clamping it to an edge would only hide.
    return fraction >= 0 && fraction <= 1 ? fraction : null;
  }, [selectedEvent, startMs, endMs]);

  const track = useCallback((clientX: number) => {
    const node = plotRef.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    if (box.width <= 0) return;
    setHoveredFraction((clientX - box.left) / box.width);
  }, []);

  /**
   * Measures the track and keeps the reference the hover lookup needs.
   *
   * **Bound to the container, not to the first row.** It used to be the
   * geomagnetic row's plot, on the reasoning that every row is the same width —
   * which was true and became a trap the moment rows could be switched off: with
   * that row hidden the observer never binds, the width stays at the 480px
   * fallback forever, and bucket and tick counts silently stop adapting. The
   * container is always mounted, and it is the same width and left edge as every
   * plot inside it, so it serves the hover lookup identically.
   *
   * A ref callback rather than an effect: an effect keyed on a conditionally
   * rendered element leaves the observer watching a detached node, which is a
   * bug this project has already shipped once.
   */
  const registerTrack = useCallback((node: HTMLDivElement | null) => {
    plotRef.current = node;
    if (!node) return;

    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0;
      if (measured > 0) setWidth(measured);
    });
    observer.observe(node);

    return () => {
      observer.disconnect();
      plotRef.current = null;
    };
  }, []);

  if (state.status === 'loading') return null;

  const hasData = samples.length > 0;
  const hasWind = solarWind.some((bar) => bar.typical !== null);
  const hasFlux = xray.some((bar) => bar.typical !== null);
  // Reported beside the peak when the row saw materially less than the window:
  // a peak drawn from a third of the hours is a different claim from one drawn
  // from all of them, and nothing else on screen tells them apart.
  const windCoverage = measuredFraction(solarWind);
  const geoCoverage = measuredFraction(geomagnetic);
  const fluxCoverage = measuredFraction(xray);

  /** Shared by every row: pointer, keyboard and the resize observer. */
  const plotHandlers = {
    onPointerMove: (event: React.PointerEvent) => {
      track(event.clientX);
    },
    onPointerLeave: () => {
      setHoveredFraction(null);
    },
    tabIndex: 0,
    onFocus: () => {
      // Starts at the live edge, same as before — 1 is "now" on a 0-1 track.
      if (hoveredFraction === null) setHoveredFraction(1);
    },
    onBlur: () => {
      setHoveredFraction(null);
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (bucketCount === 0) return;
      // One nominal bucket's width — the same step size regardless of which
      // row happens to have fewer bars than that due to sparse data.
      const step = 1 / bucketCount;
      const from = hoveredFraction ?? 1;
      if (event.key === 'ArrowLeft') setHoveredFraction(Math.max(0, from - step));
      else if (event.key === 'ArrowRight') setHoveredFraction(Math.min(1, from + step));
      else if (event.key === 'Home') setHoveredFraction(0);
      else if (event.key === 'End') setHoveredFraction(1);
      else return;
      event.preventDefault();
    },
  };

  return (
    <div className={styles.track} id="space-weather-track" ref={registerTrack}>
      <TrackToggles />

      {showGeomagnetic && (
      <Row
        label="Geomagnetic"
        guideId="track-geomagnetic"
        bars={geomagnetic}
        hovered={geoHovered}
        ticks={ticks}
        thresholdFraction={KP_STORM_THRESHOLD / KP_MAX}
        handlers={plotHandlers}
        selectedFraction={selectedFraction}
        ariaLabel="Geomagnetic activity over the visible window"
        readout={
          geoHovered >= 0 && geomagnetic[geoHovered]
            ? describeBar(
                geomagnetic[geoHovered],
                (v) => `Kp ${v.toFixed(1)}`,
                (v) => `Dst ${String(Math.round(v))} nT`,
                true,
              )
            : null
        }
        caption={
          hasData ? (
            <>
              peak Kp {peak.kp === null ? '—' : peak.kp.toFixed(1)}
              {peak.dst !== null && (
                <span className={peak.dst <= DST_STORM_THRESHOLD ? styles.stormText : undefined}>
                  {' '}
                  · Dst {Math.round(peak.dst)} nT
                </span>
              )}
              {geoCoverage < COVERAGE_CAPTION_BELOW && (
                <span className={styles.coverage}>
                  {' '}
                  · {Math.round(geoCoverage * 100)}% measured
                </span>
              )}
            </>
          ) : (
            // Distinguishes "no storms" from "no data", which look identical on
            // an empty track and mean completely different things.
            'no data for this window'
          )
        }
      />
      )}

      {showSolarWind && (
      <Row
        label="Solar wind"
        guideId="track-solar-wind"
        bars={solarWind}
        hovered={windHovered}
        ticks={ticks}
        thresholdFraction={FAST_WIND_THRESHOLD / WIND_SPEED_MAX}
        handlers={plotHandlers}
        selectedFraction={selectedFraction}
        ariaLabel="Solar wind speed over the visible window"
        readout={
          windHovered >= 0 && solarWind[windHovered]
            ? describeBar(
                solarWind[windHovered],
                (v) => `km/s ${v.toFixed(0)}`,
                (v) => `Bz ${v.toFixed(1)} nT`,
                false,
              )
            : null
        }
        caption={
          hasWind ? (
            <>
              peak {peak.windSpeed === null ? '—' : Math.round(peak.windSpeed)} km/s
              {peak.bzGsm !== null && <> · Bz {peak.bzGsm.toFixed(1)} nT</>}
              {windCoverage < COVERAGE_CAPTION_BELOW && (
                <span className={styles.coverage}>
                  {' '}
                  · {Math.round(windCoverage * 100)}% measured
                </span>
              )}
            </>
          ) : (
            // The common case until the archive is downloaded, and a genuine
            // one before 1963 — said plainly rather than drawn as calm wind.
            'not measured in this window'
          )
        }
      />
      )}

      {showXray && (
      <Row
        label="X-ray flux"
        guideId="track-xray-flux"
        bars={xray}
        hovered={xrayHovered}
        ticks={ticks}
        // Log-scaled, unlike Kp's and wind's linear thresholds — a naive
        // emphasisAt/scaleMax division would put M-class near the very
        // bottom of a row where the ordinary range spans nine decades.
        thresholdFraction={heightOf(XRAY_EMPHASIS_FLUX, XRAY_FLUX_MAX, XRAY_FLUX_MIN)}
        handlers={plotHandlers}
        selectedFraction={selectedFraction}
        ariaLabel="GOES X-ray flux over the visible window"
        readout={
          xrayHovered >= 0 && xray[xrayHovered]
            ? describeBar(xray[xrayHovered], fluxToClassLabel, () => '', false)
            : null
        }
        caption={
          hasFlux ? (
            <>
              peak {peak.xrayFlux === null ? '—' : fluxToClassLabel(peak.xrayFlux)}
              {fluxCoverage < COVERAGE_CAPTION_BELOW && (
                <span className={styles.coverage}>
                  {' '}
                  · {Math.round(fluxCoverage * 100)}% measured
                </span>
              )}
            </>
          ) : (
            // Live poll only, no historical archive — the common case for any
            // window that reaches back further than the last few days.
            'not measured in this window'
          )
        }
      />
      )}

      {showEarthquakes && (
      <EarthquakeRow
        bars={earthquakes}
        hovered={quakeHovered}
        ticks={ticks}
        handlers={plotHandlers}
        selectedFraction={selectedFraction}
        readout={
          quakeHovered >= 0 && earthquakes[quakeHovered]
            ? describeEarthquakeBar(earthquakes[quakeHovered])
            : null
        }
        caption={
          earthquakePeak.count > 0 ? (
            <>
              peak M{earthquakePeak.magnitude?.toFixed(1) ?? '—'} · {earthquakePeak.count.toLocaleString()}{' '}
              events
            </>
          ) : (
            'no events in this window'
          )
        }
      />
      )}

      {showTidalStress && (
        <TidalStressRow
          plane={tidalPlane}
          series={tidalSeries}
          hovered={tidalHovered}
          ticks={ticks}
          handlers={plotHandlers}
          selectedFraction={selectedFraction}
        />
      )}

      {showMagnetometer && (
        <MagnetometerRow
          state={magnetometerRow}
          bars={magnetometerBars}
          peak={magnetometerPeak}
          hovered={magnetometerHovered}
          ticks={ticks}
          handlers={plotHandlers}
          selectedFraction={selectedFraction}
        />
      )}

      <div className={styles.axis} aria-hidden="true">
        {ticks.map((tick) => (
          <span
            key={tick.timeUtc}
            className={styles.tick}
            style={{
              left: `${String(tick.x * 100)}%`,
              // Centred except at the ends, where a centred label would hang
              // off the track. See `TrackTick.anchor`.
              transform:
                tick.anchor === 'start'
                  ? 'none'
                  : tick.anchor === 'end'
                    ? 'translateX(-100%)'
                    : 'translateX(-50%)',
            }}
          >
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * §5.5's "each independently toggleable", finally built.
 *
 * ## Why the chips are here and not in `LayerPanel`
 *
 * That panel is driven entirely off the layer registry — its own doc comment
 * says adding a layer needs no edit there — and a track row is not a layer. It
 * has no `GlobeLayer`, nothing to mount, nothing to destroy. Putting timeline
 * rows in the layer list would mean hand-written entries in a component whose
 * whole point is that it has none, and would file a control for the panel at
 * the bottom of the screen inside the panel at the top left.
 *
 * ## What the line costs, and why it still pays
 *
 * About 1.3rem — and because the inspector is centred, roughly 2.6rem of its
 * clearance. It buys back far more than that: switching off two rows reclaims
 * ~5.6rem, and the clearance is measured now rather than a hardcoded constant
 * (see `TimeScrubber.tsx`), so turning a row off genuinely gives the inspector
 * the room back instead of merely leaving a gap.
 */
function TrackToggles() {
  const visibleTracks = useGlobeStore((state) => state.visibleTracks);
  const toggleTrack = useGlobeStore((state) => state.toggleTrack);

  return (
    <div className={styles.toggles} role="group" aria-label="Timeline rows">
      {TRACK_ROWS.map((row) => {
        const visible = isTrackVisible(row.id, visibleTracks);
        return (
          <button
            key={row.id}
            type="button"
            id={`track-toggle-${row.id}`}
            className={visible ? `${styles.chip} ${styles.chipOn}` : styles.chip}
            aria-pressed={visible}
            onClick={() => {
              toggleTrack(row.id);
            }}
          >
            {row.label}
          </button>
        );
      })}
    </div>
  );
}

interface TidalStressRowProps {
  plane: TidalPlaneState;
  series: TidalStressSeries | null;
  hovered: number;
  ticks: { x: number; timeUtc: string }[];
  handlers: Record<string, unknown>;
  selectedFraction: number | null;
}

/**
 * §5.5's fifth row: lunisolar tidal shear on one mapped fault, as a curve.
 *
 * **Deliberately neither a `Row` nor an `EarthquakeRow`.** Those draw a bucketed
 * measurement and a binned point series respectively; this is a continuous
 * analytic function with no median/peak pair, no missing-data state, and no
 * reason for its fidelity to depend on the pixel width. See
 * `tidal-stress-track.ts`.
 *
 * The curve is **signed**, with zero at the midline, while the readout beside it
 * is a **magnitude** — matching `TidalShear.tsx`, so one quantity does not carry
 * two meanings in two panels. That split is the honest one: the waveform's shape
 * survives the strike-sign ambiguity because the ambiguity is one constant flip
 * per fault, whereas a single signed number does not survive it at all.
 */
function TidalStressRow({
  plane,
  series,
  hovered,
  ticks,
  handlers,
  selectedFraction,
}: TidalStressRowProps) {
  const hoveredPoint = series && hovered >= 0 ? series.points[hovered] : undefined;

  /** The header's right-hand text: the hovered value, else what the row can say. */
  const caption = (() => {
    if (plane.kind === 'none') {
      // An invitation, not an error. The row is off by default precisely so
      // this state is something you opted into rather than met unannounced.
      return 'select an earthquake or fault';
    }
    if (plane.kind === 'too-far') {
      return `nearest mapped fault is ${Math.round(plane.distanceKm)} km away`;
    }
    if (plane.kind === 'no-plane') {
      // The common case, at 78.3% of GEM traces — said plainly rather than
      // drawn as a flat line, which would read as "no tidal stress here".
      return `${plane.fault.n ?? 'unnamed fault'} — dip not reported`;
    }
    if (series?.tooLong === true) {
      // Names both the limit and the reason for it: a reader who has just
      // scrubbed to the 130-year archive should be able to tell this from a
      // fault that simply has no data.
      return `over ${String(TIDAL_TRACK_MAX_WINDOW_HOURS / 24)} days — the ${String(
        TIDAL_PERIOD_HOURS,
      )} h tide cannot be drawn`;
    }
    const name = plane.fault.n ?? 'unnamed fault';
    return series ? `${name} · peak ${formatShear(series.peakPa)}` : name;
  })();

  return (
    <div className={styles.row}>
      <div className={styles.header}>
        <span className={styles.titleGroup}>
          <span className={styles.title}>Tidal stress</span>
          <LayerGuideButton layerId={trackGuideIdFor('tidal-stress')} />
        </span>
        {hoveredPoint ? (
          <span className={styles.readout}>
            {formatBarTime(new Date(hoveredPoint.timeMs).toISOString())} ·{' '}
            {formatShear(hoveredPoint.shearPa)}
          </span>
        ) : (
          <span className={styles.peak}>{caption}</span>
        )}
      </div>

      <div
        className={styles.plot}
        role="group"
        aria-label="Lunisolar tidal shear stress on the selected fault"
        {...handlers}
      >
        {/* Zero, not a threshold: this row is signed and its midline is a real
            value rather than an annotation to measure against. Solid and
            centred so the curve is read as swinging about it. */}
        <span className={styles.zeroLine} aria-hidden="true" />

        {ticks.map((tick) => (
          <span
            key={tick.timeUtc}
            className={styles.tickLine}
            style={{ left: `${String(tick.x * 100)}%` }}
            aria-hidden="true"
          />
        ))}

        {hoveredPoint && (
          <span
            className={styles.guide}
            style={{ left: `${String(hoveredPoint.x * 100)}%` }}
            aria-hidden="true"
          />
        )}

        {selectedFraction !== null && (
          <span
            className={styles.selectionGuide}
            style={{ left: `${String(selectedFraction * 100)}%` }}
            aria-hidden="true"
          />
        )}

        {series && series.points.length > 0 && (
          /* `preserveAspectRatio="none"` stretches a square viewBox to the
             row's real shape, which is what lets the curve use the same 0-1
             coordinate space every other row's CSS percentages use. It also
             stretches the stroke, hence `vectorEffect` — without it the line
             is drawn several times thicker horizontally than vertically. */
          <svg
            className={styles.curve}
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polyline points={polylinePoints(series.points)} vectorEffect="non-scaling-stroke" />
          </svg>
        )}
      </div>
    </div>
  );
}

interface MagnetometerRowProps {
  state: MagnetometerRowState;
  bars: MagnetometerBar[];
  peak: { rangeNt: number | null; measuredFraction: number };
  hovered: number;
  ticks: { x: number; timeUtc: string }[];
  handlers: Record<string, unknown>;
  selectedFraction: number | null;
}

/**
 * §5.5's sixth row: the ground field's disturbance at the station nearest the
 * selection.
 *
 * A bar row like Kp and X-ray rather than a curve like the tide, because this
 * *is* a bucketed statistic of a sampled measurement — each bar is that
 * interval's peak-to-peak range, the same quantity the globe marker shows. Log
 * scaled, for the reason `magnetometer-track.ts` measures out: quiet buckets
 * are single-digit nT and storm buckets reach two thousand.
 *
 * **The distance to the station is always printed**, and that is the honest
 * part. The USGS network is thin and heavily northern — 10 of 31 stations below
 * 45 degrees — so "nearest" is often over a thousand kilometres from the
 * selected event, and a disturbance measured that far away says much less about
 * the ground under the epicentre than the row's mere presence implies.
 */
function MagnetometerRow({
  state,
  bars,
  peak,
  hovered,
  ticks,
  handlers,
  selectedFraction,
}: MagnetometerRowProps) {
  const hoveredBar = hovered >= 0 ? bars[hovered] : undefined;

  const caption = (() => {
    switch (state.kind) {
      case 'no-selection':
        return 'select an earthquake or place';
      case 'no-stations':
        // Before the first poll, or with no network — distinct from a station
        // list that exists and simply has nothing nearby.
        return 'no station list yet';
      case 'window-too-long':
        return `over ${String(MAGNETOMETER_MAX_WINDOW_HOURS / 24)} days — only minute data is served`;
      case 'loading':
        return `${state.nearest.station.name} · loading`;
      case 'no-coverage':
        // The common case before 1987 and in the holes between USGS's four
        // products — said plainly, never drawn as a quiet station.
        return `${state.nearest.station.name} · no data for this window`;
      case 'ready': {
        const km = Math.round(state.nearest.distanceKm).toLocaleString();
        const level = peak.rangeNt === null ? '—' : `${Math.round(peak.rangeNt).toString()} nT`;
        return `${state.nearest.station.code} ${km} km · peak ${level}`;
      }
    }
  })();

  return (
    <div className={styles.row}>
      <div className={styles.header}>
        <span className={styles.titleGroup}>
          <span className={styles.title}>Magnetometer</span>
          <LayerGuideButton layerId={trackGuideIdFor('magnetometer')} />
        </span>
        {hoveredBar ? (
          <span className={styles.readout}>
            {formatBarTime(hoveredBar.timeUtc)} ·{' '}
            {hoveredBar.rangeNt === null
              ? 'not measured'
              : `${hoveredBar.rangeNt.toFixed(1)} nT range`}
          </span>
        ) : (
          <span className={styles.peak}>{caption}</span>
        )}
      </div>

      <div
        className={styles.plot}
        role="group"
        aria-label="Ground magnetometer disturbance over the visible window"
        {...handlers}
      >
        {/* The app's existing station-disturbance emphasis level. Display only
            — H4b, which registered a per-station trigger, was withdrawn unrun,
            so there is no registered constant for this to be confused with. */}
        <span
          className={styles.stormLine}
          style={{
            bottom: `${String(
              heightOf(STATION_DISTURBED_NT, MAGNETOMETER_RANGE_MAX_NT, MAGNETOMETER_RANGE_MIN_NT) *
                100,
            )}%`,
          }}
          aria-hidden="true"
        />

        {ticks.map((tick) => (
          <span
            key={tick.timeUtc}
            className={styles.tickLine}
            style={{ left: `${String(tick.x * 100)}%` }}
            aria-hidden="true"
          />
        ))}

        {hoveredBar && (
          <span
            className={styles.guide}
            style={{ left: `${String((hoveredBar.x + hoveredBar.width / 2) * 100)}%` }}
            aria-hidden="true"
          />
        )}

        {selectedFraction !== null && (
          <span
            className={styles.selectionGuide}
            style={{ left: `${String(selectedFraction * 100)}%` }}
            aria-hidden="true"
          />
        )}

        {bars.map((bar, index) => {
          const left = `${String(bar.x * 100)}%`;
          const barWidth = `${String(Math.max(bar.width * 100, 0.15))}%`;
          const isHovered = index === hovered;

          if (bar.rangeNt === null) {
            // An absence, drawn — a station dropping out mid-storm is exactly
            // the bucket a reader must not mistake for a calm one.
            return (
              <span
                key={bar.timeUtc}
                className={isHovered ? `${styles.absent} ${styles.absentHovered}` : styles.absent}
                style={{ left, width: barWidth }}
              />
            );
          }

          const height = heightOf(
            bar.rangeNt,
            MAGNETOMETER_RANGE_MAX_NT,
            MAGNETOMETER_RANGE_MIN_NT,
          );
          return (
            <span
              key={bar.timeUtc}
              className={[
                styles.bar,
                bar.disturbed ? styles.barStormy : '',
                isHovered ? styles.barHovered : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ left, width: barWidth, height: `${String(Math.max(height * 100, 2))}%` }}
            />
          );
        })}
      </div>
    </div>
  );
}

interface RowProps {
  label: string;
  /** Looked up in track-guides.ts for the row's `?` button. */
  guideId: string;
  bars: TrackBar[];
  hovered: number;
  ticks: { x: number; timeUtc: string }[];
  /** Where the reference line sits, 0-1 up the row. */
  thresholdFraction: number;
  handlers: Record<string, unknown>;
  /** Where the selected earthquake sits, 0-1, or null when nothing is selected. */
  selectedFraction: number | null;
  ariaLabel: string;
  readout: string | null;
  caption: React.ReactNode;
}

/**
 * One plotted quantity: a header, a plot, no axis of its own.
 *
 * The axis belongs to the stack, not the row — two of them stacked would draw
 * the same labels twice and cost the panel a line of height for nothing.
 */
function Row({
  label,
  guideId,
  bars,
  hovered,
  ticks,
  thresholdFraction,
  handlers,
  selectedFraction,
  ariaLabel,
  readout,
  caption,
}: RowProps) {
  const hoveredBar = hovered >= 0 ? bars[hovered] : undefined;

  return (
    <div className={styles.row}>
      <div className={styles.header}>
        <span className={styles.titleGroup}>
          <span className={styles.title}>{label}</span>
          <LayerGuideButton layerId={guideId} />
        </span>
        {readout !== null ? (
          <span className={styles.readout}>{readout}</span>
        ) : (
          <span className={styles.peak}>{caption}</span>
        )}
      </div>

      <div className={styles.plot} role="group" aria-label={ariaLabel} {...handlers}>
        <span
          className={styles.stormLine}
          style={{ bottom: `${String(thresholdFraction * 100)}%` }}
          aria-hidden="true"
        />

        {ticks.map((tick) => (
          <span
            key={tick.timeUtc}
            className={styles.tickLine}
            style={{ left: `${String(tick.x * 100)}%` }}
            aria-hidden="true"
          />
        ))}

        {hoveredBar && (
          <span
            className={styles.guide}
            style={{ left: `${String((hoveredBar.x + hoveredBar.width / 2) * 100)}%` }}
            aria-hidden="true"
          />
        )}

        {/* §5.5's "click a quake, the timeline centers on it" — a persistent
            marker at the selected event's own position, distinct from the
            transient hover guide above (dashed vs. solid) so the two don't
            get mistaken for each other when both are on screen at once. */}
        {selectedFraction !== null && (
          <span
            className={styles.selectionGuide}
            style={{ left: `${String(selectedFraction * 100)}%` }}
            aria-hidden="true"
          />
        )}

        {bars.map((bar, index) => {
          const left = `${String(bar.x * 100)}%`;
          const barWidth = `${String(Math.max(bar.width * 100, 0.15))}%`;
          const isHovered = index === hovered;

          if (bar.unmeasured) {
            // An absence, drawn. Left blank it is indistinguishable from a low
            // value — and the hours this happens in are the least ordinary in
            // the record: ACE goes blind during the biggest storms, and no
            // spacecraft sat at L1 at all between 1985 and 1994. Contiguous
            // gaps merge into a dotted baseline; isolated ones read as dashes.
            return (
              <span
                key={bar.timeUtc}
                className={isHovered ? `${styles.absent} ${styles.absentHovered}` : styles.absent}
                style={{ left, width: barWidth }}
              />
            );
          }

          return (
            <span key={bar.timeUtc}>
              {/* The typical level. */}
              <span
                className={[
                  styles.bar,
                  bar.typicalStormy ? styles.barStormy : '',
                  isHovered ? styles.barHovered : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{
                  left,
                  width: barWidth,
                  height: `${String(Math.max(bar.typicalHeight * 100, bar.typical === null ? 0 : 2))}%`,
                }}
              />
              {/* The worst hour in the interval, when it rose above the typical.
                  A cap rather than a taller bar: it adds a line's worth of ink
                  instead of a column's, so a track of brief storms doesn't read
                  as one long one. */}
              {bar.peakHeight > bar.typicalHeight && (
                <span
                  className={bar.peakStormy ? `${styles.cap} ${styles.capStormy}` : styles.cap}
                  style={{ left, width: barWidth, bottom: `${String(bar.peakHeight * 100)}%` }}
                />
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

interface EarthquakeRowProps {
  bars: EarthquakeBar[];
  hovered: number;
  ticks: { x: number; timeUtc: string }[];
  handlers: Record<string, unknown>;
  selectedFraction: number | null;
  readout: string | null;
  caption: React.ReactNode;
}

/**
 * §5.5's third row: a marker, sized by magnitude, for each bucket's largest
 * event.
 *
 * **Deliberately not a `Row`.** That component's whole shape — bars, caps,
 * an "unmeasured" gap state, a threshold line — describes a *measured*
 * continuous quantity, and Kp/wind genuinely are ones. An earthquake bucket
 * either had a largest event or it didn't; there is no "instrument was
 * down" state to distinguish from a real quiet stretch, and no reference
 * threshold to draw a dashed line at. A short, honest markup for what this
 * actually is, rather than bending three unrelated flags on `TrackBar` to
 * mean something they were never built to mean.
 *
 * **Deliberately shorter than the other two rows.** A dot conveys magnitude
 * through its own size, not through how far up the row it sits, so it never
 * needed a full-height plot — and the panel is centred, so every rem this
 * row costs is paid twice over in the inspector's clearance (see
 * `EarthquakeInspector.module.css`). `styles.markerPlot` is about half
 * `styles.plot`'s height for exactly that reason.
 */
function EarthquakeRow({
  bars,
  hovered,
  ticks,
  handlers,
  selectedFraction,
  readout,
  caption,
}: EarthquakeRowProps) {
  return (
    <div className={styles.row}>
      <div className={styles.header}>
        <span className={styles.titleGroup}>
          <span className={styles.title}>Earthquakes</span>
          <LayerGuideButton layerId="track-earthquakes" />
        </span>
        {readout !== null ? (
          <span className={styles.readout}>{readout}</span>
        ) : (
          <span className={styles.peak}>{caption}</span>
        )}
      </div>

      <div
        className={styles.markerPlot}
        role="group"
        aria-label="Earthquakes over the visible window, sized by magnitude"
        {...handlers}
      >
        {ticks.map((tick) => (
          <span
            key={tick.timeUtc}
            className={styles.tickLine}
            style={{ left: `${String(tick.x * 100)}%` }}
            aria-hidden="true"
          />
        ))}

        {hovered >= 0 && bars[hovered] && (
          <span
            className={styles.guide}
            style={{ left: `${String((bars[hovered].x + bars[hovered].width / 2) * 100)}%` }}
            aria-hidden="true"
          />
        )}

        {selectedFraction !== null && (
          <span
            className={styles.selectionGuide}
            style={{ left: `${String(selectedFraction * 100)}%` }}
            aria-hidden="true"
          />
        )}

        {bars.map((bar, index) => {
          if (bar.magnitude === null) return null;
          const sizePx = earthquakeDotPx(bar.magnitude);
          const isHovered = index === hovered;

          return (
            <span
              key={bar.timeUtc}
              className={[
                styles.dot,
                bar.emphasized ? styles.dotEmphasized : '',
                isHovered ? styles.dotHovered : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{
                left: `${String((bar.x + bar.width / 2) * 100)}%`,
                width: `${String(sizePx)}px`,
                height: `${String(sizePx)}px`,
                marginLeft: `${String(-sizePx / 2)}px`,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
