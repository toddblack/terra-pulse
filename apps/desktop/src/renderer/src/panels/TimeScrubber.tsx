import { memo, useMemo } from 'react';
import { playbackSpeedLabel, playbackSpeedsForWindow } from '@terra-pulse/schema';
import {
  useEarthquakeStore,
  windowStartMs,
} from '../state/useEarthquakeStore';
import { useEarthquakesUpToPlayhead } from '../globe/useVisibleEarthquakes';
import { useNow } from '../globe/useNow';
import { SpaceWeatherTrack } from './SpaceWeatherTrack';
import styles from './TimeScrubber.module.css';
import { formatAgo, formatPlayhead } from './time-labels';

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

  const shownCount = useEarthquakesUpToPlayhead().length;

  const nowMs = useNow();
  const range = useMemo(
    () => ({ startMs: windowStartMs(windowHours, nowMs), endMs: nowMs }),
    [windowHours, nowMs],
  );

  const isLive = playheadMs === null;
  const position = playheadMs ?? range.endMs;

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
});
