import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WAVEFORM_WINDOW_MS, channelIdOf, type QuakeReplay, type WaveformChannelStatus } from '@terra-pulse/schema';
import { playAlertSound } from '../audio/alert-sound';
import { useGlobeStore } from '../state/useGlobeStore';
import { StationTrace } from './StationTrace';
import { EMPTY_CHANNEL_BUFFER } from './waveform-buffer';
import { WAVEFORM_REPLAY_GUIDE_ID } from './waveform-limits';
import { displayLagMs, type TraceMark } from './waveform-trace';
import {
  REPLAY_SPEEDS,
  arrivedCount,
  buffersFromArrivals,
  crossedForward,
  formatSinceOrigin,
  knownPicks,
  magnitudeAt,
} from './replay-playback';
import { useReplayStore } from './useReplayStore';
import panelStyles from './WaveformPanel.module.css';
import styles from './ReplayPanel.module.css';

/** How often the playback clock advances. Ten a second is smooth for traces drawn at 1 Hz live. */
const TICK_MS = 100;

const seconds = (ms: number) => (ms / 1000).toFixed(1);

/** A row the archive held nothing for, said as such rather than as "connecting". */
function rowStatus(channelId: string, hasData: boolean): WaveformChannelStatus {
  const [network = '', station = '', location = '', channel = ''] = channelId.split('_');
  return {
    channelId,
    channel: { network, station, location, channel },
    state: hasData ? 'live' : 'rejected',
    rejectedReason: hasData ? null : 'no data in the archive',
    lastPacketMs: null,
    records: 0,
  };
}

/** The line under the transport: what the detector knew at the playhead. */
function StatusLine({ replay, positionMs }: { replay: QuakeReplay; positionMs: number }) {
  const { detection, alert, home } = replay;

  if (detection === null || positionMs < detection.declaredAtMs) {
    if (detection === null && positionMs >= replay.windowEndMs) {
      return (
        <p className={styles.status}>
          The detector never declared this quake.
          {replay.kind === 'distant'
            ? ' That is the expected answer for a distant one: its P waves have lost the high frequencies the detector listens for.'
            : ''}
        </p>
      );
    }
    const triggered = [...knownPicks(replay.picks, positionMs).keys()].length;
    return (
      <p className={styles.status}>
        Listening through {replay.stationsWithData} stations — {triggered} of these {replay.rows.length} rows
        triggered so far. It declares once four agree on one source.
      </p>
    );
  }

  const step = magnitudeAt(detection.magnitudeSteps, positionMs);
  // "Updating", not "climbing": it usually climbs, but a station joining with a
  // short window can pull it down, and the label should not promise a direction.
  const magnitude = step === null ? 'magnitude pending' : `M${step.magnitude.toFixed(1)}${step.complete ? '' : ' (updating)'}`;
  const sinceOrigin = formatSinceOrigin(detection.declaredAtMs - replay.request.originMs);

  if (alert !== null && positionMs >= alert.alertedAtMs) {
    const shakingInMs = alert.sArrivalAtHomeMs - positionMs;
    const intensity = step?.intensityAtHome ?? alert.intensity;
    return (
      <p className={styles.banner} role="status">
        <span className={styles.bannerTag}>REPLAY · ALERT</span>
        {magnitude} · MMI {intensity.toFixed(1)} predicted at {home.label} ·{' '}
        {shakingInMs > 0 ? (
          <strong>strong shaking in {seconds(shakingInMs)} s</strong>
        ) : (
          <strong>
            strong shaking reached home — {seconds(alert.sArrivalAtHomeMs - alert.alertedAtMs)} s of warning
          </strong>
        )}
      </p>
    );
  }

  const intensity = step?.intensityAtHome ?? null;
  return (
    <p className={styles.status}>
      Declared {sinceOrigin} after origin from {detection.stationsAtDeclaration} stations,{' '}
      {detection.locationErrorKm.toFixed(0)} km from where USGS placed it · {magnitude}
      {intensity !== null &&
        ` · MMI ${intensity.toFixed(1)} predicted at ${home.label}${
          alert === null ? ` — below the ${replay.alertThreshold.toFixed(1)} alert threshold` : ''
        }`}
    </p>
  );
}

/** Ticks along the scrub bar for the moments worth jumping to. */
function scrubMarks(replay: QuakeReplay): { atMs: number; label: string; kind: string }[] {
  const marks = [{ atMs: replay.request.originMs, label: 'Origin', kind: 'origin' }];
  marks.push({ atMs: replay.pArrivalAtHomeMs, label: `P wave reaches ${replay.home.label}`, kind: 'home' });
  if (replay.sArrivalAtHomeMs !== null) {
    marks.push({ atMs: replay.sArrivalAtHomeMs, label: `Strong shaking reaches ${replay.home.label}`, kind: 'home' });
  }
  if (replay.detection !== null) marks.push({ atMs: replay.detection.declaredAtMs, label: 'Declared', kind: 'declared' });
  if (replay.alert !== null) marks.push({ atMs: replay.alert.alertedAtMs, label: 'Alert', kind: 'alert' });
  return marks.filter((m) => m.atMs >= replay.windowStartMs && m.atMs <= replay.windowEndMs);
}

function ReadyReplay({ replay }: { replay: QuakeReplay }) {
  const playback = useReplayStore((state) => state.playback);
  const lastMove = useReplayStore((state) => state.lastMove);
  const play = useReplayStore((state) => state.play);
  const pause = useReplayStore((state) => state.pause);
  const setSpeed = useReplayStore((state) => state.setSpeed);
  const seek = useReplayStore((state) => state.seek);
  const tick = useReplayStore((state) => state.tick);
  const { positionMs } = playback;

  // The clock: measured wall time between ticks, so a busy frame never makes
  // the replay run slow.
  useEffect(() => {
    if (!playback.playing) return;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      tick(now - last);
      last = now;
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [playback.playing, tick]);

  // The alert sound, on playback crossing the alert — never on a scrub.
  const previous = useRef(positionMs);
  useEffect(() => {
    if (lastMove === 'tick' && replay.alert !== null && crossedForward(previous.current, positionMs, replay.alert.alertedAtMs)) {
      playAlertSound();
    }
    previous.current = positionMs;
  }, [positionMs, lastMove, replay.alert]);

  // Only what had arrived by the playhead — the replay's whole honesty.
  const count = arrivedCount(replay.arrivals, positionMs);
  const buffers = useMemo(() => buffersFromArrivals(replay.arrivals, count), [replay.arrivals, count]);
  const lagMs = useMemo(() => displayLagMs([...buffers.values()].map((b) => b.segments)), [buffers]);
  const windowEndMs = positionMs - lagMs;
  const windowStartMs = windowEndMs - WAVEFORM_WINDOW_MS;
  const picks = useMemo(() => knownPicks(replay.picks, positionMs), [replay.picks, positionMs]);
  const withData = useMemo(() => new Set(replay.arrivals.map((a) => a.segment.channelId)), [replay.arrivals]);

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

  const span = replay.windowEndMs - replay.windowStartMs;
  const percent = (atMs: number) => ((atMs - replay.windowStartMs) / span) * 100;

  return (
    <>
      <div className={styles.transport}>
        <button
          type="button"
          className={styles.playButton}
          onClick={playback.playing ? pause : play}
          aria-label={playback.playing ? 'Pause the replay' : 'Play the replay'}
        >
          <span aria-hidden="true">{playback.playing ? '❚❚' : '▶'}</span>
        </button>
        <div className={styles.speeds} role="group" aria-label="Replay speed">
          {REPLAY_SPEEDS.map((speed) => (
            <button
              key={speed}
              type="button"
              className={speed === playback.speed ? styles.speedActive : styles.speedInactive}
              aria-pressed={speed === playback.speed}
              onClick={() => {
                setSpeed(speed);
              }}
            >
              {speed}×
            </button>
          ))}
        </div>
        <div className={styles.scrub}>
          <input
            type="range"
            className={styles.slider}
            min={replay.windowStartMs}
            max={replay.windowEndMs}
            step={100}
            value={positionMs}
            onChange={(event) => {
              seek(Number(event.target.value));
            }}
            aria-label="Replay position"
            aria-valuetext={`${formatSinceOrigin(positionMs - replay.request.originMs)} from the origin`}
          />
          <div className={styles.scrubMarks} aria-hidden="true">
            {scrubMarks(replay).map((mark) => (
              <span
                key={mark.label}
                className={styles.scrubMark}
                data-kind={mark.kind}
                style={{ left: `${String(percent(mark.atMs))}%` }}
                title={mark.label}
              />
            ))}
          </div>
        </div>
        <span className={styles.clock} title="Time since the quake began">
          {formatSinceOrigin(positionMs - replay.request.originMs)}
        </span>
      </div>

      <StatusLine replay={replay} positionMs={positionMs} />

      <ol className={panelStyles.rows} ref={measureRef}>
        {replay.rows.map((row) => {
          const id = channelIdOf(row);
          const marks: TraceMark[] = [
            { timeMs: replay.request.originMs, kind: 'origin' },
            ...(picks.get(id) ?? []).map((timeMs) => ({ timeMs, kind: 'pick' as const })),
          ];
          return (
            <StationTrace
              key={id}
              channel={row}
              buffer={buffers.get(id) ?? EMPTY_CHANNEL_BUFFER}
              status={rowStatus(id, withData.has(id))}
              windowStartMs={windowStartMs}
              windowEndMs={windowEndMs}
              nowMs={positionMs}
              columns={columns}
              marks={marks}
            />
          );
        })}
      </ol>

      <footer className={panelStyles.footer}>
        {replay.stationsWithData} of the {replay.networkSize} home-network stations had archived data for this
        quake. Rows are the first to trigger, distance and direction from the epicentre; amber ticks are triggers,
        the dashed line is the origin. Each record appears when it would have reached us live.
      </footer>
    </>
  );
}

/**
 * A past quake played back through the early-warning detector, in the dock's
 * waveform tab. The live stream keeps running underneath; closing the replay
 * returns to it. See `useReplayStore` and the replay guide.
 */
export function ReplayPanel() {
  const request = useReplayStore((state) => state.request);
  const load = useReplayStore((state) => state.load);
  const start = useReplayStore((state) => state.start);
  const close = useReplayStore((state) => state.close);
  const noteProgress = useReplayStore((state) => state.noteProgress);
  const openGuide = useGlobeStore((state) => state.openGuide);

  useEffect(() => window.terraPulse.quakeReplay.onProgress(noteProgress), [noteProgress]);

  if (request === null) return null;
  const when = new Date(request.originMs).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <section className={panelStyles.panel} aria-label="Quake replay">
      <header className={styles.titleRow}>
        <span className={styles.badge}>Replay</span>
        <span className={styles.title}>
          M{request.magnitude.toFixed(1)} · {request.place} · {when}
        </span>
        <button
          type="button"
          className={panelStyles.guideButton}
          onClick={() => {
            openGuide(WAVEFORM_REPLAY_GUIDE_ID);
          }}
          aria-label="What a replay shows, and what it cannot tell you"
        >
          ?
        </button>
        <button type="button" className={styles.close} onClick={close} title="Back to the live waveforms">
          ✕ Back to live
        </button>
      </header>

      {load?.status === 'loading' && (
        <p className={styles.status}>
          {load.progress === null || load.progress.phase === 'stations'
            ? 'Finding the home network…'
            : load.progress.phase === 'gains'
              ? 'Reading station calibrations…'
              : load.progress.phase === 'waveforms'
                ? `Fetching archived records… ${String(load.progress.done + 1)} of ${String(load.progress.total)}`
                : 'Running the detector…'}
        </p>
      )}
      {load?.status === 'error' && (
        <p className={styles.status}>
          Could not replay: {load.reason}.{' '}
          <button
            type="button"
            className={panelStyles.retry}
            onClick={() => {
              start(request);
            }}
          >
            Retry
          </button>
        </p>
      )}
      {load?.status === 'ready' && <ReadyReplay replay={load.replay} />}
    </section>
  );
}
