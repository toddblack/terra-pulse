import { useCallback, useMemo, useRef, useState } from 'react';
import {
  downsampleSpaceWeather,
  DST_STORM_THRESHOLD,
  type SpaceWeatherSample,
} from '@terra-pulse/schema';
import { useEarthquakeStore } from '../state/useEarthquakeStore';
import { useNow } from '../globe/useNow';
import { displayWindow } from '../globe/display-window';
import { useSpaceWeather } from './useSpaceWeather';
import {
  bucketsForWidth,
  layoutTrack,
  nearestBarIndex,
  peakOf,
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
 * What the hovered interval says.
 *
 * Values lead and labels follow — the reader already has the time from the
 * axis and wants the numbers. The peak is named only when it differs from the
 * typical, because at short windows a bucket is a single hour and "Kp 2.3, peak
 * 2.3" is noise dressed as information.
 */
function describeBar(bar: TrackBar): string {
  const parts = [formatBarTime(bar.timeUtc)];
  if (bar.hours > 1) parts.push(`${String(bar.hours)} h`);

  if (bar.typicalKp === null) {
    parts.push('Kp —');
  } else if (bar.peakKp !== null && bar.peakKp > bar.typicalKp) {
    parts.push(`Kp ${bar.typicalKp.toFixed(1)}, peak ${bar.peakKp.toFixed(1)}`);
  } else {
    parts.push(`Kp ${bar.typicalKp.toFixed(1)}`);
  }

  if (bar.peakDst !== null) parts.push(`Dst ${String(Math.round(bar.peakDst))} nT`);

  return parts.join(' · ');
}

/**
 * Kp and Dst on the same time axis as the globe.
 *
 * ## Why it shares `displayWindow`
 *
 * The whole value of the track is that a spike lines up with the earthquakes on
 * screen. It therefore has to use the *same* definition of the visible span as
 * the globe and the event list, not a second expression that happens to agree —
 * which is exactly the drift `displayWindow` was extracted to prevent.
 *
 * ## Why Kp sizes the bars and Dst only marks them
 *
 * Kp is bounded 0-9, so a fixed scale is honest and a bar's height means the
 * same thing in every view. Dst is unbounded below: a single -589 nT hour would
 * flatten every other bar in the record to nothing, and that hour is precisely
 * what you want to see *in context*. So Dst marks the bar instead of sizing it.
 *
 * ## Why each interval draws twice
 *
 * The bar is the typical level, the cap is the worst hour. See `layoutTrack` —
 * with the peak alone, which is what this drew before, a decade of quiet years
 * with one storm each is indistinguishable from a decade of continuous
 * disturbance.
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

  const bars = useMemo(() => {
    const buckets = bucketsForWidth(width);
    const reduced = downsampleSpaceWeather(samples, buckets);
    return layoutTrack(reduced, startMs, endMs, 1 / Math.max(buckets, 1));
  }, [samples, startMs, endMs, width]);

  const ticks = useMemo(
    () => trackTicks(startMs, endMs, ticksForWidth(width)),
    [startMs, endMs, width],
  );

  const peak = useMemo(() => peakOf(samples), [samples]);

  const track = useCallback((clientX: number) => {
    const node = plotRef.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    if (box.width <= 0) return;
    setHovered(nearestBarIndex(bars, (clientX - box.left) / box.width));
  }, [bars]);

  if (state.status === 'loading') return null;

  const hoveredBar = hovered >= 0 ? bars[hovered] : undefined;

  return (
    <div className={styles.track} id="space-weather-track">
      <div className={styles.header}>
        <span className={styles.title}>Geomagnetic activity</span>
        {hoveredBar ? (
          <span className={styles.readout}>{describeBar(hoveredBar)}</span>
        ) : samples.length > 0 ? (
          <span className={styles.peak}>
            peak Kp {peak.kp === null ? '—' : peak.kp.toFixed(1)}
            {peak.dst !== null && (
              <span className={peak.dst <= DST_STORM_THRESHOLD ? styles.stormText : undefined}>
                {' '}
                · Dst {Math.round(peak.dst)} nT
              </span>
            )}
          </span>
        ) : (
          // Distinguishes "no storms" from "no data", which look identical on an
          // empty track and mean completely different things.
          <span className={styles.peak}>no data for this window</span>
        )}
      </div>

      {/* Bound with a ref callback, not an effect: an effect keyed on a
          conditionally-rendered element leaves the observer watching a detached
          node, which is a bug this project has already shipped once. */}
      <div
        className={styles.plot}
        ref={(node) => {
          plotRef.current = node;
          if (!node) return;
          const observer = new ResizeObserver((entries) => {
            const measured = entries[0]?.contentRect.width ?? 0;
            if (measured > 0) setWidth(measured);
          });
          observer.observe(node);
          return () => {
            observer.disconnect();
            // Released with the observer, so the ref cannot outlive the element
            // it points at and retain a detached node.
            plotRef.current = null;
          };
        }}
        // A nearest-x lookup on the whole plot rather than per-bar hit testing:
        // a bar is 2px wide, so requiring the pointer to land on one leaves
        // most of the track dead to the reader.
        onPointerMove={(event) => {
          track(event.clientX);
        }}
        onPointerLeave={() => {
          setHovered(NO_BAR);
        }}
        // The same values on keyboard focus as on hover. Stepping bar by bar is
        // impractical at 200 of them, so the arrows move by one and the ends
        // jump — enough to read any interval without a pointer.
        tabIndex={0}
        role="group"
        aria-label="Geomagnetic activity over the visible window"
        onFocus={() => {
          if (hovered === NO_BAR && bars.length > 0) setHovered(bars.length - 1);
        }}
        onBlur={() => {
          setHovered(NO_BAR);
        }}
        onKeyDown={(event) => {
          if (bars.length === 0) return;
          const from = hovered === NO_BAR ? bars.length - 1 : hovered;
          if (event.key === 'ArrowLeft') setHovered(Math.max(0, from - 1));
          else if (event.key === 'ArrowRight') setHovered(Math.min(bars.length - 1, from + 1));
          else if (event.key === 'Home') setHovered(0);
          else if (event.key === 'End') setHovered(bars.length - 1);
          else return;
          event.preventDefault();
        }}
      >
        {/* Kp 5, where NOAA calls it a storm. Drawn so a bar's height can be
            read against something rather than guessed at. */}
        <span className={styles.stormLine} aria-hidden="true" />

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
                  height: `${String(Math.max(bar.typicalHeight * 100, 2))}%`,
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
