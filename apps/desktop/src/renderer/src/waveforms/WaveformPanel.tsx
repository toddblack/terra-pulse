import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WAVEFORM_WINDOW_MS, channelIdOf } from '@terra-pulse/schema';
import { StationTrace } from './StationTrace';
import { EMPTY_CHANNEL_BUFFER } from './waveform-buffer';
import { displayLagMs } from './waveform-trace';
import { WAVEFORM_GUIDE_ID } from './waveform-limits';
import { useGlobeStore } from '../state/useGlobeStore';
import { WAVEFORM_REGIONS } from './waveform-regions';
import { PICKED_REGION_ID, useWaveformStore } from './useWaveformStore';
import type { WaveformSelection } from './waveform-selection';
import type { WaveformBackground } from './useWaveformBackground';
import {
  WAVEFORM_PICK_MIN_SEPARATION_KM,
  azimuthalGapDeg,
  formatDistanceKm,
  formatPickCoordinates,
  type WaveformPickPoint,
} from './station-pick';
import { WatchHereButton } from '../watch/WatchHereButton';
import styles from './WaveformPanel.module.css';

/** The sentence under the tabs: what this set of rows is, and what it is not. */
function describeSelection(selection: WaveformSelection | null): string {
  if (selection === null) return '';
  if (selection.kind === 'preset') return selection.region.note;

  switch (selection.state) {
    case 'awaiting-click':
      return 'Click bare globe to stream the stations surrounding that spot — or open an earthquake and choose “Stations near this quake”.';
    case 'loading':
      return 'Loading the station list…';
    case 'unavailable':
      return `No station list: ${selection.reason ?? 'it could not be fetched'}.`;
    case 'ready': {
      const point = selection.point;
      if (point === null) return '';
      const place = point.label ?? formatPickCoordinates(point);
      const count = selection.stations.length;
      if (count === 0) return `No stations on the public ring near ${place}.`;
      const farthest = Math.max(...selection.stations.map((station) => station.distanceKm ?? 0));
      const gap = Math.round(azimuthalGapDeg(selection.stations));
      return `${String(count)} stations surrounding ${place}, at least ${String(
        WAVEFORM_PICK_MIN_SEPARATION_KM,
      )} km apart, out to ${formatDistanceKm(farthest)}. Widest direction with no station: ${String(gap)}°.`;
    }
  }
}

/**
 * What the watch button would pin, or why it can't. A preset is a whole region,
 * so there is no one spot to watch; the picked tab has one from the moment of
 * the click — the watch fetches its own stations, so it need not wait for the
 * pick's list.
 */
function watchTarget(selection: WaveformSelection | null): {
  point: WaveformPickPoint | null;
  label: string;
  disabledReason: string | null;
} {
  if (selection?.kind !== 'picked') {
    return {
      point: null,
      label: '',
      disabledReason: 'A preset covers a whole region — open “Picked spot” and click the globe to choose one spot to watch',
    };
  }
  if (selection.point === null) {
    return { point: null, label: '', disabledReason: 'Click the globe to pick a spot first' };
  }
  return {
    point: selection.point,
    label: selection.point.label ?? formatPickCoordinates(selection.point),
    disabledReason: null,
  };
}

/**
 * Live waveforms — the dock's second tab.
 *
 * This was a whole app mode until the dock existed, and the mode cost too much:
 * entering it unmounted Explore, so the earthquakes stayed drawn while nothing
 * about them could be hovered or inspected. As a tab it sits beside all of
 * that, and a click on bare globe while it is showing still picks a spot for
 * stations — a click on a quake opens the inspector instead. See
 * `globe/click-route.ts`.
 *
 * **It renders the stream; it does not own it.** The dock does, through
 * `useWaveformBackground`, so this panel can unmount while minimised without
 * the connection closing or the buffers emptying.
 */
export function WaveformPanel({ selection, channels, stream, retryCatalogue }: WaveformBackground) {
  const openGuide = useGlobeStore((state) => state.openGuide);
  const regionId = useWaveformStore((state) => state.regionId);
  const setRegionId = useWaveformStore((state) => state.setRegionId);
  const stations = useMemo(() => selection?.stations ?? [], [selection]);
  const { status, buffers, error } = stream;

  /**
   * A 1 Hz clock, so traces scroll between arrivals rather than jumping when a
   * record lands.
   *
   * Deliberately local and deliberately not `useNow`, which ticks every 30 s
   * for the whole app: this is the only thing in the app that needs a
   * per-second clock, and it runs only while this panel is on screen — a
   * minimised dock unmounts it, so a background stream costs no redraws.
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  /**
   * Column count follows the real width.
   *
   * Bound with a **ref callback, not an effect** — an effect-bound observer
   * watching a conditionally-rendered node has shipped a blank panel in this
   * app once already. Two pixels a column: finer than the eye resolves, and it
   * keeps the envelope honest at any window size.
   */
  const [plotWidth, setPlotWidth] = useState(960);
  const observer = useRef<ResizeObserver | null>(null);
  const measureRef = useCallback((node: Element | null) => {
    observer.current?.disconnect();
    if (node === null) return;
    observer.current = new ResizeObserver(([entry]) => {
      const width = entry?.target.getBoundingClientRect().width ?? 0;
      if (width > 0) setPlotWidth(width);
    });
    observer.current.observe(node);
  }, []);
  const columns = Math.max(60, Math.floor(plotWidth / 2));

  const statusById = useMemo(
    () => new Map((status?.channels ?? []).map((channel) => [channel.channelId, channel])),
    [status],
  );

  /**
   * The shared right edge sits a few seconds behind now, so that every station
   * has data at it and the traces line up. See `displayLagMs` for why this is
   * derived from record length rather than from each channel's staleness, and
   * why rows must not get their own axes.
   */
  const lagMs = useMemo(
    () => displayLagMs([...buffers.values()].map((buffer) => buffer.segments)),
    [buffers],
  );
  const windowEndMs = nowMs - lagMs;
  const windowStartMs = windowEndMs - WAVEFORM_WINDOW_MS;
  const liveCount = (status?.channels ?? []).filter((channel) => channel.state === 'live').length;

  const connectionText = (() => {
    if (channels.length === 0) return '';
    if (error !== null) return `refused: ${error}`;
    if (status?.connected === true) return `${String(liveCount)} of ${String(channels.length)} streaming`;
    if (status?.retries !== undefined && status.retries > 0) {
      return `reconnecting (attempt ${String(status.retries)})`;
    }
    return 'connecting';
  })();

  const tabs = [
    ...WAVEFORM_REGIONS.map((region) => ({ id: region.id, label: region.label })),
    { id: PICKED_REGION_ID, label: 'Picked spot' },
  ];

  return (
    <section className={styles.panel} aria-label="Live seismic waveforms">
      <header className={styles.header}>
        <div className={styles.tabRow}>
          <div className={styles.regions} role="tablist" aria-label="Stations">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={tab.id === regionId}
                className={tab.id === regionId ? styles.regionActive : styles.regionInactive}
                onClick={() => {
                  setRegionId(tab.id);
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <span className={styles.pickHint}>or click bare globe to pick a spot</span>
          <WatchHereButton {...watchTarget(selection)} />
          <span className={styles.connection}>{connectionText}</span>
          <button
            type="button"
            className={styles.guideButton}
            onClick={() => {
              openGuide(WAVEFORM_GUIDE_ID);
            }}
            aria-label="What this shows, and what it cannot tell you"
          >
            ?
          </button>
        </div>

        <p className={styles.note}>
          {describeSelection(selection)}{' '}
          {selection?.kind === 'picked' && selection.state === 'unavailable' && (
            <button type="button" className={styles.retry} onClick={retryCatalogue}>
              Retry
            </button>
          )}{' '}
          <span className={styles.caution}>
            Raw counts, not comparable between rows; most motion here is ocean microseism, not
            earthquakes.
          </span>
        </p>
      </header>

      <ol className={styles.rows} ref={measureRef}>
        {stations.map((station) => {
          const id = channelIdOf(station);
          return (
            <StationTrace
              key={id}
              channel={station}
              buffer={buffers.get(id) ?? EMPTY_CHANNEL_BUFFER}
              status={statusById.get(id)}
              windowStartMs={windowStartMs}
              windowEndMs={windowEndMs}
              nowMs={nowMs}
              columns={columns}
            />
          );
        })}
      </ol>

      <footer className={styles.footer}>
        Two minutes on one shared clock, newest at the right. The right edge is{' '}
        <strong className={styles.lag}>{Math.round(lagMs / 1000)} s behind live</strong> — records
        ship only once full, and the slowest station on screen sets the delay. The figure at each
        row&rsquo;s right is how old that station&rsquo;s newest sample is.
      </footer>
    </section>
  );
}
