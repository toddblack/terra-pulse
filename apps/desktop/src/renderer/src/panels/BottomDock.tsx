import type { ReactNode } from 'react';
import { useEarthquakeStore } from '../state/useEarthquakeStore';
import { useGlobeStore } from '../state/useGlobeStore';
import { useNow } from '../globe/useNow';
import { WaveformPanel } from '../waveforms/WaveformPanel';
import { ReplayPanel } from '../waveforms/ReplayPanel';
import { selectReplayOpen, useReplayStore } from '../waveforms/useReplayStore';
import { useWaveformBackground } from '../waveforms/useWaveformBackground';
import type { WaveformStream } from '../waveforms/useWaveformStream';
import { isDockShowing, type DockTab } from './dock-state';
import { publishSize } from './published-size';
import { TimeScrubber } from './TimeScrubber';
import { formatPlayhead } from './time-labels';
import { useQuakeWatchStore } from '../watch/useQuakeWatchStore';
import { watchChipLabel, watchDetail, watchHealth } from '../watch/watch-labels';
import styles from './BottomDock.module.css';

/**
 * Publishes the dock's height for the inspector and the top-centre column to
 * clear. The inspector is centred, so it subtracts this twice; see
 * `EarthquakeInspector.module.css` and `published-size.ts`.
 */
const publishDockHeight = publishSize('--dock-height', 'height');

/** A small row of bars — the shape of the Kp track the tab opens onto. */
function TimelineIcon() {
  const bars = [3, 5, 4, 8, 6, 3, 7, 4];
  return (
    <svg className={styles.icon} viewBox="0 0 24 12" aria-hidden="true">
      {bars.map((height, index) => (
        <rect key={index} x={index * 3} y={12 - height} width={2} height={height} rx={0.4} />
      ))}
    </svg>
  );
}

/**
 * A tiny seismogram: quiet ground, a sharp P arrival, a bigger S, and a coda
 * that decays — the shape a reader should come to expect from the rows.
 */
function WaveformIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 24 12" aria-hidden="true">
      <polyline
        className={styles.trace}
        points="0,6 4,6 5,4.6 6,7.4 7,5.4 8,6.5 9,6 11,6 12,1 13,11 14,2 15,10 16,3.6 17,8.4 18,4.8 19,7.2 20,5.4 21,6.6 22,5.8 24,6"
      />
    </svg>
  );
}

type StreamHealth = 'idle' | 'running' | 'trouble';

/**
 * What the waveform tab's dot says while the tab isn't showing.
 *
 * Operational status, so colour and motion are allowed (the Analyze tabs set
 * that precedent): a background stream has no other visible trace once its
 * panel is put away. "Trouble" is a refused request or a connection that is
 * retrying — either way the buffer you will come back to is not filling.
 */
function streamHealth(started: boolean, stream: WaveformStream): StreamHealth {
  if (!started) return 'idle';
  if (stream.error !== null) return 'trouble';
  if (stream.status?.connected !== true && (stream.status?.retries ?? 0) > 0) return 'trouble';
  return 'running';
}

/**
 * Stands in for the scrubber whenever the timeline tab isn't showing.
 *
 * Playback keeps running with the scrubber put away (`usePlayback` lives in
 * `CesiumViewer`), so the globe can be drawing 1989 with nothing on screen
 * saying so. This says so, and a click brings the scrubber back.
 */
function PlayheadChip({ onOpen }: { onOpen: () => void }) {
  const playheadMs = useEarthquakeStore((state) => state.playheadMs);
  const isPlaying = useEarthquakeStore((state) => state.isPlaying);
  const nowMs = useNow();
  const label = playheadMs === null ? 'Live' : formatPlayhead(playheadMs, nowMs);
  return (
    <button
      type="button"
      className={playheadMs === null ? styles.chip : `${styles.chip} ${styles.chipPast}`}
      onClick={onOpen}
      title="The time the globe is showing — open the timeline"
    >
      {isPlaying ? '▶ ' : ''}
      {label}
    </button>
  );
}

/**
 * The live watch, while there is a pin: a dot, where, how many stations are
 * delivering, and Stop — which removes the pin (the user's design: no
 * paused-but-present state). On the strip, so a running watch is visible on
 * both tabs and minimised. Everything the strip has no room for, the limits
 * above all, is in the tooltip.
 */
function WatchChip() {
  const status = useQuakeWatchStore((state) => state.status);
  const stopWatching = useQuakeWatchStore((state) => state.stopWatching);
  const testAlert = useQuakeWatchStore((state) => state.testAlert);
  const health = watchHealth(status);
  if (health === 'off') return null;
  const dotClass =
    health === 'running' ? styles.watchDotRunning : health === 'limited' ? styles.watchDotLimited : styles.dotTrouble;
  return (
    <div id="watch-chip" className={styles.watchChip} title={watchDetail(status)}>
      <span role="img" className={dotClass} aria-label={`watch ${health}`} />
      <span className={styles.watchLabel}>{watchChipLabel(status)}</span>
      {/* Works whatever the health: it tests the alert, not the stations. */}
      <button
        type="button"
        id="watch-test"
        className={styles.watchTest}
        onClick={testAlert}
        title="Show a test alert: a made-up M5.0 100 km away, with the real banner, sound and countdown"
      >
        Test
      </button>
      <button
        type="button"
        id="watch-stop"
        className={styles.watchStop}
        onClick={stopWatching}
        aria-label="Stop watching and remove the pin"
        title="Stop watching and remove the pin"
      >
        ×
      </button>
    </div>
  );
}

/**
 * The bottom of Explore: the timeline and the live waveforms, one at a time,
 * under a strip of tabs — and minimisable to just that strip for a clear globe.
 *
 * **Sized to the gap between the side columns, not centred at a fixed width.**
 * Waveforms need horizontal room, and the columns change width at runtime (the
 * archive panel, the event list, legend sections), so `ExploreShell` publishes
 * their measured widths and this reads them. A fixed width overlapped them on
 * a 1000px window.
 *
 * **It owns the waveform stream; the panel only draws it.** That is what lets
 * the stream keep running while minimised or on the timeline. It also means
 * this component re-renders on every arriving segment, which is why
 * `TimeScrubber` is memoised.
 */
export function BottomDock() {
  const dock = useGlobeStore((state) => state.dock);
  const pressDockTab = useGlobeStore((state) => state.pressDockTab);
  const showDockTab = useGlobeStore((state) => state.showDockTab);
  const toggleDock = useGlobeStore((state) => state.toggleDock);

  const background = useWaveformBackground(dock.waveformsStarted);
  const replayOpen = useReplayStore(selectReplayOpen);
  const health = streamHealth(dock.waveformsStarted, background.stream);

  const tabs: readonly { id: DockTab; label: string; icon: ReactNode }[] = [
    { id: 'timeline', label: 'Timeline', icon: <TimelineIcon /> },
    { id: 'waveforms', label: 'Waveforms', icon: <WaveformIcon /> },
  ];

  return (
    <div className={styles.dock} ref={publishDockHeight}>
      <div className={styles.strip}>
        <div className={styles.tabs} role="tablist" aria-label="Bottom panel">
          {tabs.map((tab) => {
            const showing = isDockShowing(dock, tab.id);
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`dock-tab-${tab.id}`}
                aria-selected={showing}
                className={showing ? styles.tabActive : styles.tabInactive}
                onClick={() => {
                  pressDockTab(tab.id);
                }}
                title={showing ? `Hide the ${tab.label.toLowerCase()}` : `Show the ${tab.label.toLowerCase()}`}
              >
                {tab.icon}
                <span>{tab.label}</span>
                {tab.id === 'waveforms' && !showing && health !== 'idle' && (
                  <span
                    role="img"
                    className={health === 'running' ? styles.dotRunning : styles.dotTrouble}
                    aria-label={health === 'running' ? 'streaming' : 'stream interrupted'}
                    title={health === 'running' ? 'Streaming in the background' : 'Stream interrupted'}
                  />
                )}
              </button>
            );
          })}
        </div>

        {!isDockShowing(dock, 'timeline') && (
          <PlayheadChip
            onOpen={() => {
              showDockTab('timeline');
            }}
          />
        )}

        <WatchChip />

        <button
          type="button"
          className={styles.minimise}
          onClick={toggleDock}
          aria-expanded={dock.open}
          aria-label={dock.open ? 'Minimise the bottom panel' : 'Restore the bottom panel'}
          title={dock.open ? 'Minimise' : 'Restore'}
        >
          <span aria-hidden="true">{dock.open ? '▾' : '▴'}</span>
        </button>
      </div>

      {isDockShowing(dock, 'timeline') && <TimeScrubber />}
      {/* A replay takes the waveform tab while it is open; the live stream
          keeps running underneath, so closing it lands on a full window. */}
      {isDockShowing(dock, 'waveforms') && (replayOpen ? <ReplayPanel /> : <WaveformPanel {...background} />)}
    </div>
  );
}
