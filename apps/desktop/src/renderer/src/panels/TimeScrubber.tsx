import { useMemo } from 'react';
import {
  PLAYBACK_SPEEDS_HOURS_PER_SECOND,
  useEarthquakeStore,
  windowStartMs,
} from '../state/useEarthquakeStore';
import { useEarthquakesUpToPlayhead } from '../globe/useVisibleEarthquakes';
import { useNow } from '../globe/useNow';
import styles from './TimeScrubber.module.css';

/**
 * Playhead label. Shows a clock time plus how far back that is, because
 * "14:20" alone doesn't say which of the last four days it belongs to.
 */
function formatPlayhead(playheadMs: number, nowMs: number): string {
  const clock = new Date(playheadMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  const hoursAgo = Math.round((nowMs - playheadMs) / (60 * 60 * 1000));

  if (hoursAgo <= 0) return `${clock} · now`;
  if (hoursAgo < 24) return `${clock} · ${hoursAgo}h ago`;

  const days = Math.floor(hoursAgo / 24);
  const hours = hoursAgo % 24;
  return `${clock} · ${days}d ${hours}h ago`;
}

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

  return (
    <div id="time-scrubber" className={styles.scrubber}>
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
          {PLAYBACK_SPEEDS_HOURS_PER_SECOND.map((speed) => (
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
              title={`${speed} simulated hours per second`}
            >
              {speed}h/s
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
        <span>{windowHours >= 24 ? `${Math.round(windowHours / 24)}d ago` : `${windowHours}h ago`}</span>
        <span>now</span>
      </div>
    </div>
  );
}
