import { memo, useMemo } from 'react';
import { playbackSpeedLabel, playbackSpeedsForWindow } from '@terra-pulse/schema';
import { useEarthquakeStore, viewStartMs } from '../state/useEarthquakeStore';
import { useEarthquakesUpToPlayhead } from '../globe/useVisibleEarthquakes';
import { useNow } from '../globe/useNow';
import { SpaceWeatherTrack } from './SpaceWeatherTrack';
import styles from './TimeScrubber.module.css';
import { formatAgo, formatPlayhead, formatRangePlayhead, formatUtcDay } from './time-labels';

/**
 * The timeline tab's content: the six-row track and the playhead controls.
 *
 * Placed by `BottomDock`, which also publishes the height the inspector
 * clears — this panel used to do both, back when it was the only thing at the
 * bottom of the window.
 *
 * **Memoised, and that matters.** It takes no props, so `memo` skips every
 * re-render the dock passes down — and the dock re-renders on each waveform
 * segment while the stream runs in the background, several times a second.
 */
export const TimeScrubber = memo(function TimeScrubber() {
  const windowHours = useEarthquakeStore((state) => state.windowHours);
  const playheadMs = useEarthquakeStore((state) => state.playheadMs);
  const isPlaying = useEarthquakeStore((state) => state.isPlaying);
  const playbackSpeed = useEarthquakeStore((state) => state.playbackSpeed);
  const play = useEarthquakeStore((state) => state.play);
  const pause = useEarthquakeStore((state) => state.pause);
  const seek = useEarthquakeStore((state) => state.seek);
  const goLive = useEarthquakeStore((state) => state.goLive);
  const setPlaybackSpeed = useEarthquakeStore((state) => state.setPlaybackSpeed);
  const dateRange = useEarthquakeStore((state) => state.dateRange);

  const shownCount = useEarthquakesUpToPlayhead().length;

  const nowMs = useNow();
  // A date range has its own two ends; every other view runs up to now.
  const range = useMemo(
    () => ({
      startMs: viewStartMs(windowHours, dateRange, nowMs),
      endMs: dateRange?.endMs ?? nowMs,
    }),
    [windowHours, dateRange, nowMs],
  );

  const isLive = playheadMs === null;
  const position = playheadMs ?? range.endMs;
  const playheadLabel =
    dateRange === null
      ? formatPlayhead(position, range.endMs)
      : formatRangePlayhead(position, range.startMs, range.endMs);

  return (
    <div id="time-scrubber" className={styles.scrubber}>
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
            {isLive ? 'Live' : playheadLabel}
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
          // From a date range this leaves the range: no part of it is "live",
          // and a way back to the present belongs next to the playhead.
          title={dateRange === null ? undefined : 'Leave these dates and return to the live view'}
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
          // Dragging to the very end means "catch up and stay caught up" —
          // except in a date range, where the end is an ordinary position and
          // `goLive` would throw the range away.
          if (next >= range.endMs && dateRange === null) goLive();
          else seek(next);
        }}
        aria-label="Playhead"
        aria-valuetext={isLive ? 'Live' : playheadLabel}
      />

      <div className={styles.axis}>
        {dateRange === null ? (
          <>
            <span>{formatAgo(windowHours * 60 * 60 * 1000)}</span>
            <span>now</span>
          </>
        ) : (
          <>
            <span>{formatUtcDay(range.startMs)}</span>
            {/* The last day in the range, not the instant it ends on — the
                end is the midnight after it. */}
            <span>{formatUtcDay(range.endMs - 1)}</span>
          </>
        )}
      </div>
    </div>
  );
});
