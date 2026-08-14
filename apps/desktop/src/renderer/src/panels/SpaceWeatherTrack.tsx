import { useMemo, useState } from 'react';
import {
  downsampleSpaceWeather,
  DST_STORM_THRESHOLD,
  type SpaceWeatherSample,
} from '@terra-pulse/schema';
import { useEarthquakeStore } from '../state/useEarthquakeStore';
import { useNow } from '../globe/useNow';
import { displayWindow } from '../globe/display-window';
import { useSpaceWeather } from './useSpaceWeather';
import { bucketsForWidth, layoutTrack, peakOf } from './space-weather-track';
import styles from './SpaceWeatherTrack.module.css';

/** Assumed track width until the element measures itself. */
const FALLBACK_WIDTH = 480;

/**
 * Stable empty series.
 *
 * A fresh `[]` while loading is a new identity every render, which would
 * re-run the layout memo continuously — the same trap `EMPTY_HITS` exists for
 * in the viewer.
 */
const NO_SAMPLES: readonly SpaceWeatherSample[] = [];

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
 * ## Why Kp sizes the bars and Dst only colours them
 *
 * Kp is bounded 0-9, so a fixed scale is honest and a bar's height means the
 * same thing in every view. Dst is unbounded below: a single -589 nT hour would
 * flatten every other bar in the record to nothing, and that hour is precisely
 * what you want to see *in context*. So Dst marks the bar instead of sizing it.
 */
export function SpaceWeatherTrack() {
  const [width, setWidth] = useState(FALLBACK_WIDTH);

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

  const peak = useMemo(() => peakOf(samples), [samples]);

  if (state.status === 'loading') return null;

  return (
    <div className={styles.track} id="space-weather-track">
      <div className={styles.header}>
        <span className={styles.title}>Geomagnetic activity</span>
        {samples.length > 0 ? (
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
          if (!node) return;
          const observer = new ResizeObserver((entries) => {
            const measured = entries[0]?.contentRect.width ?? 0;
            if (measured > 0) setWidth(measured);
          });
          observer.observe(node);
          return () => {
            observer.disconnect();
          };
        }}
      >
        {/* Kp 5, where NOAA calls it a storm. Drawn so a bar's height can be
            read against something rather than guessed at. */}
        <span className={styles.stormLine} aria-hidden="true" />

        {bars.map((bar) => (
          <span
            key={bar.timeUtc}
            className={bar.stormy ? `${styles.bar} ${styles.barStormy}` : styles.bar}
            style={{
              left: `${String(bar.x * 100)}%`,
              width: `${String(Math.max(bar.width * 100, 0.15))}%`,
              height: `${String(Math.max(bar.height * 100, 2))}%`,
            }}
            title={`${bar.timeUtc.slice(0, 16).replace('T', ' ')} UTC · Kp ${
              bar.kp === null ? '—' : bar.kp.toFixed(1)
            }${bar.dst === null ? '' : ` · Dst ${String(Math.round(bar.dst))} nT`}`}
          />
        ))}
      </div>
    </div>
  );
}
