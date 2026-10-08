import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  WAVEFORM_WINDOW_MS,
  channelIdOf,
  detectorLimit,
  type QuakeReplay,
  type ReplayDetectorReach,
  type WaveformChannelStatus,
} from '@terra-pulse/schema';
import { useGlobeStore } from '../state/useGlobeStore';
import { StationTrace } from './StationTrace';
import { EMPTY_CHANNEL_BUFFER } from './waveform-buffer';
import { WAVEFORM_REPLAY_GUIDE_ID } from './waveform-limits';
import { displayLagMs, type TraceMark } from './waveform-trace';
import {
  REPLAY_SPEEDS,
  arrivedCount,
  buffersFromArrivals,
  formatSinceOrigin,
  knownPicks,
  magnitudeAt,
} from './replay-playback';
import { useReplayStore } from './useReplayStore';
import panelStyles from './WaveformPanel.module.css';
import styles from './ReplayPanel.module.css';

/** How often the playback clock advances. Ten a second is smooth for traces drawn at 1 Hz live. */
const TICK_MS = 100;

const km = (value: number) => `${Math.round(value).toLocaleString()} km`;

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

/**
 * What limits the detector here, said up front — the common case away from
 * dense networks — so a quiet detector does not look like one that failed.
 */
function limitNote(reach: ReplayDetectorReach): string | null {
  switch (detectorLimit(reach)) {
    case 'too-few-stations': {
      const had = reach.stationsWithData === 0 ? 'no public station' : `only ${String(reach.stationsWithData)} public stations`;
      return `The early-warning detector could not have caught this one: ${had} within ${km(reach.radiusKm)} had data, and it needs ${String(reach.minStations)} to agree. The rows are here to watch the waves arrive.`;
    }
    case 'too-far':
      return `The nearest station is ${km(reach.nearestKm ?? 0)} from the epicentre, and the detector only searches for a source within ${km(reach.maxNearestStationKm)} of one — so at best it places this quake near the stations.`;
    case null:
      return null;
  }
}

/** The line under the transport: what the detector knew at the playhead. */
function StatusLine({ replay, positionMs }: { replay: QuakeReplay; positionMs: number }) {
  const { detection, detector } = replay;
  const limit = detectorLimit(detector);
  const note = limitNote(detector);
  if (limit === 'too-few-stations') return <p className={styles.status}>{note}</p>;

  if (detection === null || positionMs < detection.declaredAtMs) {
    // Declarations that are not this quake by the match rule — shown once the
    // playhead reaches them, with where they were placed. Offshore, that is
    // usually this quake pulled toward the stations.
    const other = replay.otherDetections.filter((d) => d.declaredAtMs <= positionMs).at(-1);
    let body: string;
    if (other !== undefined && detection === null) {
      body = `It declared an event ${formatSinceOrigin(other.declaredAtMs - replay.request.originMs)} after origin, placed ${km(other.distanceKm)} from where USGS put this quake — too far to count as finding it.`;
    } else if (detection === null && positionMs >= replay.windowEndMs) {
      body = 'The detector never declared this quake.';
    } else {
      const triggered = [...knownPicks(replay.picks, positionMs).keys()].length;
      body = `The detector is listening through ${String(detector.stationsWithData)} stations within ${km(detector.radiusKm)} — ${String(triggered)} of these rows triggered so far. It declares once ${String(detector.minStations)} agree on one source.`;
    }
    return (
      <p className={styles.status}>
        {note === null ? '' : `${note} `}
        {body}
      </p>
    );
  }

  const step = magnitudeAt(detection.magnitudeSteps, positionMs);
  // "Updating", not "climbing": it usually climbs, but a station joining with a
  // short window can pull it down, and the label should not promise a direction.
  const magnitude = step === null ? 'magnitude pending' : `M${step.magnitude.toFixed(1)}${step.complete ? '' : ' (updating)'}`;
  return (
    <p className={styles.status}>
      Declared {formatSinceOrigin(detection.declaredAtMs - replay.request.originMs)} after origin from{' '}
      {detection.stationsAtDeclaration} stations, {detection.locationErrorKm.toFixed(0)} km from where USGS placed it ·{' '}
      {magnitude}
    </p>
  );
}

/** Ticks along the scrub bar for the moments worth jumping to. */
function scrubMarks(replay: QuakeReplay): { atMs: number; label: string; kind: string }[] {
  const marks = [{ atMs: replay.request.originMs, label: 'Origin', kind: 'origin' }];
  if (replay.detection !== null) marks.push({ atMs: replay.detection.declaredAtMs, label: 'Declared', kind: 'declared' });
  return marks.filter((m) => m.atMs >= replay.windowStartMs && m.atMs <= replay.windowEndMs);
}

/** The footer: what the rows are, and what to make of empty ones. */
function footerText(replay: QuakeReplay): string {
  const withData = new Set(replay.arrivals.map((a) => a.segment.channelId));
  const rowsWithData = replay.rows.filter((r) => withData.has(channelIdOf(r))).length;
  const watchedOnly = replay.rows.filter((r) => !r.listened).length;
  const parts = [
    `${String(rowsWithData)} of these ${String(replay.rows.length)} stations had archived data.`,
    'Rows are the nearest public stations to the epicentre, nearest first, with distance and direction; the dashed line is the origin, and each record appears when it would have reached us live.',
    watchedOnly === 0
      ? 'Amber ticks are where the detector triggered.'
      : `Amber ticks are where the detector triggered; the ${String(watchedOnly)} row${watchedOnly === 1 ? '' : 's'} past ${km(replay.detector.radiusKm)} ${watchedOnly === 1 ? 'is' : 'are'} only watched.`,
  ];
  // The archive takes minutes to hours to receive the newest data.
  if (rowsWithData === 0) parts.push('A very recent quake may not have reached the archive yet; try again later.');
  return parts.join(' ');
}

function ReadyReplay({ replay }: { replay: QuakeReplay }) {
  const playback = useReplayStore((state) => state.playback);
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

      <footer className={panelStyles.footer}>{footerText(replay)}</footer>
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
