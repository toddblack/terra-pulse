import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WAVEFORM_WINDOW_MS, channelIdOf, type WaveformChannel } from '@terra-pulse/schema';
import { StationTrace } from './StationTrace';
import { EMPTY_CHANNEL_BUFFER } from './waveform-buffer';
import { displayLagMs } from './waveform-trace';
import { WAVEFORM_GUIDE_ID } from './waveform-limits';
import { LayerGuideModal } from '../panels/LayerGuideModal';
import { useGlobeStore } from '../state/useGlobeStore';
import { WAVEFORM_REGIONS, channelsOf } from './waveform-regions';
import { PICKED_REGION_ID, useWaveformStore } from './useWaveformStore';
import { useWaveformSelection } from './useWaveformSelection';
import type { WaveformSelection } from './waveform-selection';
import {
  WAVEFORM_PICK_MIN_SEPARATION_KM,
  azimuthalGapDeg,
  formatDistanceKm,
  formatPickCoordinates,
} from './station-pick';
import { useWaveformStream } from './useWaveformStream';
import styles from './WaveformShell.module.css';

/**
 * Pulls the picker's station list when the mode mounts.
 *
 * Every mount asks, and main answers from its own hour-long cache, so this is a
 * ~300 KB clone rather than a fetch. Asking each time is what lets a failed
 * list recover by leaving the mode and coming back — and the Retry button does
 * the same thing without the detour.
 */
function useStationCatalogue(): () => void {
  const setCatalogue = useWaveformStore((state) => state.setCatalogue);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    window.terraPulse.waveforms.stations().then(
      (catalogue) => {
        if (live) setCatalogue(catalogue);
      },
      (cause: unknown) => {
        if (!live) return;
        setCatalogue({
          status: 'unavailable',
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      },
    );
    return () => {
      live = false;
    };
  }, [setCatalogue, attempt]);

  return useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);
}

/** The sentence under the tabs: what this set of rows is, and what it is not. */
function describeSelection(selection: WaveformSelection | null): string {
  if (selection === null) return '';
  if (selection.kind === 'preset') return selection.region.note;

  switch (selection.state) {
    case 'awaiting-click':
      return 'Click anywhere on the globe — or on an earthquake — to stream the stations surrounding it.';
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
 * Live waveforms — the app's third mode.
 *
 * **A panel over the globe, not a full-screen surface.** The globe stays
 * visible above it, and clicking it is how a reader picks their own stations:
 * every click in this mode is a pick, the way every click under the fault
 * probe is a probe. See `CesiumViewer`.
 *
 * Nothing here persists. The connection opens when this mounts and closes when
 * it unmounts, so leaving the mode genuinely stops the stream.
 */
export function WaveformShell() {
  const openGuide = useGlobeStore((state) => state.openGuide);
  const regionId = useWaveformStore((state) => state.regionId);
  const setRegionId = useWaveformStore((state) => state.setRegionId);
  const selection = useWaveformSelection();
  const retryCatalogue = useStationCatalogue();
  const stations = useMemo(() => selection?.stations ?? [], [selection]);

  /**
   * The channels to stream, **keyed on their ids rather than on an array**.
   *
   * This list is the stream effect's dependency, so a new identity tears the
   * connection down and rebuilds it. The station list landing ~3 s after mount,
   * or an hourly refresh of it, re-runs the selection and hands out new arrays
   * for the very same stations — keying on content means only a real change of
   * stations restarts the stream.
   */
  const channelKey = JSON.stringify(channelsOf(stations));
  const channels = useMemo(() => JSON.parse(channelKey) as WaveformChannel[], [channelKey]);
  const { status, buffers, error } = useWaveformStream(channels);

  /**
   * A 1 Hz clock, so traces scroll between arrivals rather than jumping when a
   * record lands.
   *
   * Deliberately local and deliberately not `useNow`, which ticks every 30 s
   * for the whole app: this is the only thing in the app that needs a
   * per-second clock, and it runs only while this mode is mounted. Redrawing
   * eight polyline strings a second is microseconds of work, so it needs no
   * animation frame.
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
        <div className={styles.titleRow}>
          <h2 className={styles.title}>Live waveforms</h2>
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
          <span className={styles.connection}>{connectionText}</span>
        </div>

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
          <span className={styles.pickHint}>or click the globe to pick a spot</span>
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

      {/* Explore's copy is not mounted in this mode, so this one serves the
          `?` above. The modal resolves layer, track and waveform guide ids. */}
      <LayerGuideModal />
    </section>
  );
}
