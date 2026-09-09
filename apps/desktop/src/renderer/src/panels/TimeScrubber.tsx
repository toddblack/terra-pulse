import { useCallback, useMemo } from 'react';
import { playbackSpeedLabel, playbackSpeedsForWindow } from '@terra-pulse/schema';
import {
  useEarthquakeStore,
  windowStartMs,
} from '../state/useEarthquakeStore';
import { useEarthquakesUpToPlayhead } from '../globe/useVisibleEarthquakes';
import { useNow } from '../globe/useNow';
import { SpaceWeatherTrack } from './SpaceWeatherTrack';
import styles from './TimeScrubber.module.css';
import { formatAgo } from './time-labels';

/**
 * Playhead label. Shows a clock time plus how far back that is, because
 * "14:20" alone doesn't say which of the last four days it belongs to.
 */
function formatPlayhead(playheadMs: number, nowMs: number): string {
  const clock = new Date(playheadMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  const elapsed = nowMs - playheadMs;
  if (elapsed <= 0) return `${clock} · now`;

  // Past a week the clock time stops meaning anything — nobody is tracking
  // 14:20 on a day in 1974 — so the date replaces it.
  if (elapsed >= 7 * 24 * 60 * 60 * 1000) {
    const date = new Date(playheadMs).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    return `${date} · ${formatAgo(elapsed)}`;
  }

  return `${clock} · ${formatAgo(elapsed)}`;
}

/**
 * The CSS custom property this panel publishes its own height into.
 *
 * ## Why a measurement and not a constant
 *
 * The inspector is centred, so it has to clear whatever sits at the bottom of
 * the window — and it did that with a hand-maintained `calc(100vh - 37rem)`
 * whose own comment admitted the last two increases had never been checked
 * against the running app. That constant was wrong the moment a track row was
 * added or removed, and §5.5's per-row toggles make the height change *at
 * runtime*, which no constant can follow.
 *
 * It is also exactly what `App.module.css`'s panel-placement note already warns
 * about: "any `top` offset or `max-height` on a neighbour is a guess that goes
 * wrong on the next toggle or resize." The columns solved that for the side
 * panels by letting flexbox do it; the inspector cannot, because it is pinned
 * beside the selected mark rather than docked in a column. Publishing the real
 * height is the next best thing — one measurement, one reader, nothing to keep
 * in step by hand.
 *
 * Set on the document element rather than passed through React because the
 * reader is a CSS module belonging to a different, unrelated component that is
 * often not even mounted.
 */
const SCRUBBER_HEIGHT_PROPERTY = '--scrubber-height';

export function TimeScrubber() {
  const windowHours = useEarthquakeStore((state) => state.windowHours);
  const playheadMs = useEarthquakeStore((state) => state.playheadMs);
  const isPlaying = useEarthquakeStore((state) => state.isPlaying);
  const playbackSpeed = useEarthquakeStore((state) => state.playbackSpeed);
  const play = useEarthquakeStore((state) => state.play);
  const pause = useEarthquakeStore((state) => state.pause);
  const seek = useEarthquakeStore((state) => state.seek);
  const goLive = useEarthquakeStore((state) => state.goLive);
  const setPlaybackSpeed = useEarthquakeStore((state) => state.setPlaybackSpeed);

  const shownCount = useEarthquakesUpToPlayhead().length;

  const nowMs = useNow();
  const range = useMemo(
    () => ({ startMs: windowStartMs(windowHours, nowMs), endMs: nowMs }),
    [windowHours, nowMs],
  );

  const isLive = playheadMs === null;
  const position = playheadMs ?? range.endMs;

  /**
   * Publishes this panel's height for the inspector to clear.
   *
   * A ref callback rather than an effect, for the reason this codebase has
   * already shipped a bug over: an effect keyed on a conditionally rendered
   * element leaves the observer watching a detached node. The property is
   * cleared on unmount — `ExploreShell` goes away entirely when Analyze is
   * selected, and a stale height left behind would reserve space for a panel
   * that is not on screen.
   */
  const registerScrubber = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;

    const publish = (height: number) => {
      if (height > 0) {
        document.documentElement.style.setProperty(
          SCRUBBER_HEIGHT_PROPERTY,
          `${String(height)}px`,
        );
      }
    };

    publish(node.getBoundingClientRect().height);
    // Measured off the node rather than from `entry.contentRect`, which
    // excludes padding — this panel has 0.625rem of it top and bottom, so the
    // two disagree by ~20px and the first publish would not match the second.
    // What the inspector needs to clear is the box on screen, borders and all.
    const observer = new ResizeObserver(() => {
      publish(node.getBoundingClientRect().height);
    });
    observer.observe(node);

    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty(SCRUBBER_HEIGHT_PROPERTY);
    };
  }, []);

  return (
    <div id="time-scrubber" className={styles.scrubber} ref={registerScrubber}>
      {/* Shares this panel's width so its time axis is the scrubber's. */}
      <SpaceWeatherTrack />

      <div className={styles.controls}>
        <button
          type="button"
          id="playback-toggle"
          className={styles.playButton}
          onClick={() => (isPlaying ? pause() : play())}
          aria-label={isPlaying ? 'Pause playback' : 'Play the window from the start'}
        >
          {/* Glyphs rather than an icon font — nothing to load, nothing to
              fall back to under the CSP. */}
          <span aria-hidden="true">{isPlaying ? '❚❚' : '▶'}</span>
        </button>

        <div className={styles.readout}>
          <span className={styles.playhead}>
            {isLive ? 'Live' : formatPlayhead(position, range.endMs)}
          </span>
          <span className={styles.count}>{shownCount} shown</span>
        </div>

        <div className={styles.speeds} role="group" aria-label="Playback speed">
          {playbackSpeedsForWindow(windowHours).map((speed) => (
            <button
              key={speed}
              type="button"
              id={`playback-speed-${speed}`}
              className={
                speed === playbackSpeed
                  ? `${styles.speedButton} ${styles.speedButtonActive}`
                  : styles.speedButton
              }
              onClick={() => setPlaybackSpeed(speed)}
              aria-pressed={speed === playbackSpeed}
              title={`${speed} simulated hours per second — crosses this window in ${Math.round(
                windowHours / speed,
              ).toString()}s`}
            >
              {playbackSpeedLabel(speed)}
            </button>
          ))}
        </div>

        <button
          type="button"
          id="playback-live"
          className={styles.liveButton}
          onClick={goLive}
          disabled={isLive}
        >
          Live
        </button>
      </div>

      {/* A range input rather than a custom-dragged div: keyboard and screen
          reader support come for free, and arrow keys make a genuinely useful
          frame-step. */}
      <input
        type="range"
        id="playhead-slider"
        className={styles.track}
        min={range.startMs}
        max={range.endMs}
        step={60 * 1000}
        value={position}
        onChange={(event) => {
          const next = Number(event.target.value);
          // Dragging to the very end means "catch up and stay caught up".
          if (next >= range.endMs) goLive();
          else seek(next);
        }}
        aria-label="Playhead"
        aria-valuetext={isLive ? 'Live' : formatPlayhead(position, range.endMs)}
      />

      <div className={styles.axis}>
        <span>{formatAgo(windowHours * 60 * 60 * 1000)}</span>
        <span>now</span>
      </div>
    </div>
  );
}
