import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WAVEFORM_WINDOW_MS } from '@terra-pulse/schema';
import { StationTrace } from './StationTrace';
import { EMPTY_CHANNEL_BUFFER } from './waveform-buffer';
import { displayLagMs } from './waveform-trace';
import { WAVEFORM_GUIDE_ID } from './waveform-limits';
import { LayerGuideModal } from '../panels/LayerGuideModal';
import { useGlobeStore } from '../state/useGlobeStore';
import {
  WAVEFORM_REGIONS,
  channelsOf,
  waveformRegionById,
  type WaveformRegion,
} from './waveform-regions';
import { useWaveformStore } from './useWaveformStore';
import { useWaveformStream } from './useWaveformStream';
import styles from './WaveformShell.module.css';

/**
 * Live waveforms — the app's third mode.
 *
 * **A panel over the globe, not a full-screen surface.** The globe stays
 * visible above it, which is what makes the planned station picker a natural
 * next step rather than a redesign: the stations being drawn are somewhere, and
 * eventually you will click them there.
 *
 * Nothing here persists. The connection opens when this mounts and closes when
 * it unmounts, so leaving the mode genuinely stops the stream.
 */
export function WaveformShell() {
  const openGuide = useGlobeStore((state) => state.openGuide);
  const regionId = useWaveformStore((state) => state.regionId);
  const setRegionId = useWaveformStore((state) => state.setRegionId);
  const region: WaveformRegion | undefined = waveformRegionById(regionId) ?? WAVEFORM_REGIONS[0];

  // Memoised on the region, because this is the stream effect's dependency: a
  // fresh array each render would tear down and rebuild the connection every
  // time anything re-rendered.
  const channels = useMemo(() => (region === undefined ? [] : channelsOf(region)), [region]);
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
          <span className={styles.connection}>
            {error !== null
              ? `refused: ${error}`
              : status?.connected === true
                ? `${String(liveCount)} of ${String(channels.length)} streaming`
                : status?.retries !== undefined && status.retries > 0
                  ? `reconnecting (attempt ${String(status.retries)})`
                  : 'connecting'}
          </span>
        </div>

        <div className={styles.regions} role="tablist" aria-label="Region">
          {WAVEFORM_REGIONS.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              aria-selected={candidate.id === region?.id}
              className={candidate.id === region?.id ? styles.regionActive : styles.regionInactive}
              onClick={() => {
                setRegionId(candidate.id);
              }}
            >
              {candidate.label}
            </button>
          ))}
        </div>

        <p className={styles.note}>
          {region?.note}{' '}
          <span className={styles.caution}>
            Raw counts, not comparable between rows; most motion here is ocean microseism, not
            earthquakes.
          </span>
        </p>
      </header>

      <ol className={styles.rows} ref={measureRef}>
        {region?.channels.map((channel) => {
          const id = `${channel.network}_${channel.station}_${channel.location}_${channel.channel}`;
          return (
            <StationTrace
              key={id}
              channel={channel}
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
