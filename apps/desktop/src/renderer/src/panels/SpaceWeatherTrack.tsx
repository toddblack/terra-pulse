import { useCallback, useMemo, useRef, useState } from 'react';
import {
  downsampleSpaceWeather,
  DST_STORM_THRESHOLD,
  FAST_WIND_THRESHOLD,
  KP_MAX,
  KP_STORM_THRESHOLD,
  WIND_SPEED_MAX,
  type SpaceWeatherSample,
} from '@terra-pulse/schema';
import { useEarthquakeStore } from '../state/useEarthquakeStore';
import { useNow } from '../globe/useNow';
import { displayWindow } from '../globe/display-window';
import { useSpaceWeather } from './useSpaceWeather';
import {
  bucketsForWidth,
  COVERAGE_CAPTION_BELOW,
  GEOMAGNETIC_SPEC,
  layoutTrack,
  measuredFraction,
  nearestBarIndex,
  peakOf,
  SOLAR_WIND_SPEC,
  ticksForWidth,
  trackTicks,
  type TrackBar,
} from './space-weather-track';
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
  unit: string,
  digits: number,
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
    parts.push(`${unit} —`);
  } else if (bar.peak !== null && bar.peak > bar.typical) {
    parts.push(`${unit} ${bar.typical.toFixed(digits)}, peak ${bar.peak.toFixed(digits)}`);
  } else {
    parts.push(`${unit} ${bar.typical.toFixed(digits)}`);
  }

  if (bar.secondary !== null) parts.push(secondary(bar.secondary));

  return parts.join(' · ');
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
  const [hovered, setHovered] = useState(NO_BAR);
  const plotRef = useRef<HTMLDivElement | null>(null);

  const windowHours = useEarthquakeStore((state) => state.windowHours);
  const playheadMs = useEarthquakeStore((state) => state.playheadMs);
  const trailingWindow = useEarthquakeStore((state) => state.trailingWindow);
  const nowMs = useNow();

  const { startMs, endMs } = useMemo(
    () => displayWindow(windowHours, playheadMs, trailingWindow, nowMs),
    [windowHours, playheadMs, trailingWindow, nowMs],
  );

  const state = useSpaceWeather(startMs, endMs);
  const samples = state.status === 'ready' ? state.samples : NO_SAMPLES;

  // Bucketed once and laid out twice: the two rows must land on identical x
  // positions or reading down a column would compare different hours.
  const { geomagnetic, solarWind } = useMemo(() => {
    const count = bucketsForWidth(width);
    const reduced = downsampleSpaceWeather(samples, count);
    const barWidth = 1 / Math.max(count, 1);
    return {
      geomagnetic: layoutTrack(reduced, startMs, endMs, barWidth, GEOMAGNETIC_SPEC),
      solarWind: layoutTrack(reduced, startMs, endMs, barWidth, SOLAR_WIND_SPEC),
    };
  }, [samples, startMs, endMs, width]);

  const ticks = useMemo(
    () => trackTicks(startMs, endMs, ticksForWidth(width)),
    [startMs, endMs, width],
  );

  const peak = useMemo(() => peakOf(samples), [samples]);

  const track = useCallback(
    (clientX: number) => {
      const node = plotRef.current;
      if (!node) return;
      const box = node.getBoundingClientRect();
      if (box.width <= 0) return;
      setHovered(nearestBarIndex(geomagnetic, (clientX - box.left) / box.width));
    },
    [geomagnetic],
  );

  /**
   * Measures the first row and keeps the reference the hover lookup needs.
   *
   * Only one row is measured because both are the same width, and bound with a
   * ref callback rather than an effect: an effect keyed on a conditionally
   * rendered element leaves the observer watching a detached node, which is a
   * bug this project has already shipped once.
   */
  const registerPlot = useCallback((node: HTMLDivElement | null) => {
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
  // Reported beside the peak when the row saw materially less than the window:
  // a peak drawn from a third of the hours is a different claim from one drawn
  // from all of them, and nothing else on screen tells them apart.
  const windCoverage = measuredFraction(solarWind);
  const geoCoverage = measuredFraction(geomagnetic);

  /** Shared by both rows: pointer, keyboard and the resize observer. */
  const plotHandlers = {
    onPointerMove: (event: React.PointerEvent) => {
      track(event.clientX);
    },
    onPointerLeave: () => {
      setHovered(NO_BAR);
    },
    tabIndex: 0,
    onFocus: () => {
      if (hovered === NO_BAR && geomagnetic.length > 0) setHovered(geomagnetic.length - 1);
    },
    onBlur: () => {
      setHovered(NO_BAR);
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (geomagnetic.length === 0) return;
      const from = hovered === NO_BAR ? geomagnetic.length - 1 : hovered;
      if (event.key === 'ArrowLeft') setHovered(Math.max(0, from - 1));
      else if (event.key === 'ArrowRight') setHovered(Math.min(geomagnetic.length - 1, from + 1));
      else if (event.key === 'Home') setHovered(0);
      else if (event.key === 'End') setHovered(geomagnetic.length - 1);
      else return;
      event.preventDefault();
    },
  };

  return (
    <div className={styles.track} id="space-weather-track">
      <Row
        label="Geomagnetic"
        bars={geomagnetic}
        hovered={hovered}
        ticks={ticks}
        thresholdFraction={KP_STORM_THRESHOLD / KP_MAX}
        plotRef={registerPlot}
        handlers={plotHandlers}
        ariaLabel="Geomagnetic activity over the visible window"
        readout={
          hovered >= 0 && geomagnetic[hovered]
            ? describeBar(geomagnetic[hovered], 'Kp', 1, (v) => `Dst ${String(Math.round(v))} nT`, true)
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

      <Row
        label="Solar wind"
        bars={solarWind}
        hovered={hovered}
        ticks={ticks}
        thresholdFraction={FAST_WIND_THRESHOLD / WIND_SPEED_MAX}
        handlers={plotHandlers}
        ariaLabel="Solar wind speed over the visible window"
        readout={
          hovered >= 0 && solarWind[hovered]
            ? describeBar(solarWind[hovered], 'km/s', 0, (v) => `Bz ${v.toFixed(1)} nT`, false)
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

interface RowProps {
  label: string;
  bars: TrackBar[];
  hovered: number;
  ticks: { x: number; timeUtc: string }[];
  /** Where the reference line sits, 0-1 up the row. */
  thresholdFraction: number;
  /** Only the first row is measured; both are the same width. */
  plotRef?: (node: HTMLDivElement | null) => (() => void) | void;
  handlers: Record<string, unknown>;
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
  bars,
  hovered,
  ticks,
  thresholdFraction,
  plotRef,
  handlers,
  ariaLabel,
  readout,
  caption,
}: RowProps) {
  const hoveredBar = hovered >= 0 ? bars[hovered] : undefined;

  return (
    <div className={styles.row}>
      <div className={styles.header}>
        <span className={styles.title}>{label}</span>
        {readout !== null ? (
          <span className={styles.readout}>{readout}</span>
        ) : (
          <span className={styles.peak}>{caption}</span>
        )}
      </div>

      {/* Bound with a ref callback, not an effect: an effect keyed on a
          conditionally-rendered element leaves the observer watching a detached
          node, which is a bug this project has already shipped once. */}
      <div
        className={styles.plot}
        ref={plotRef}
        role="group"
        aria-label={ariaLabel}
        {...handlers}
      >
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
