import { useEffect, useMemo } from 'react';
import type { WaveformChannelStatus } from '@terra-pulse/schema';
import type { ChannelBuffer } from './waveform-buffer';
import { layoutWaveform, polylinePoints } from './waveform-trace';
import { compassPoint, formatDistanceKm, type DisplayStation } from './station-pick';
import { useWaveformStore } from './useWaveformStore';
import { waveformStationKey } from '../layers/waveform-stations-overlay';
import styles from './WaveformPanel.module.css';

interface StationTraceProps {
  /** Carries its distance from the pick, or null for a preset. */
  channel: DisplayStation;
  buffer: ChannelBuffer;
  status: WaveformChannelStatus | undefined;
  windowStartMs: number;
  windowEndMs: number;
  /** Wall clock, for the age readout. The window ends before this — see `displayLagMs`. */
  nowMs: number;
  columns: number;
}

/** Compact count label: 1,200 → "1.2k", 250,000 → "250k". */
function formatCounts(counts: number): string {
  if (counts >= 1_000_000) return `${(counts / 1_000_000).toFixed(counts >= 10_000_000 ? 0 : 1)}M`;
  if (counts >= 1_000) return `${(counts / 1_000).toFixed(counts >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(counts));
}

/**
 * One station's row.
 *
 * **SVG rather than canvas**, which is the reversible choice here: the layout
 * is a pure function returning data, and only `polylinePoints` knows about SVG
 * at all. At a 1 Hz redraw and a few hundred points per trace, canvas would buy
 * nothing and would make the drawing untestable — every other track module in
 * this app is SVG for the same reason.
 */
export function StationTrace({
  channel,
  buffer,
  status,
  windowStartMs,
  windowEndMs,
  nowMs,
  columns,
}: StationTraceProps) {
  const layout = useMemo(
    () => layoutWaveform(buffer.segments, windowStartMs, windowEndMs, columns),
    [buffer.segments, windowStartMs, windowEndMs, columns],
  );

  // Hovering the row picks out its marker on the globe.
  const stationKey = waveformStationKey(channel);
  const hoverStation = useWaveformStore((store) => store.hoverStation);
  const unhoverStation = useWaveformStore((store) => store.unhoverStation);
  // A row unmounted under the pointer — a region switch, a new pick — never
  // receives its mouseleave, and its marker would stay picked out.
  useEffect(
    () => () => {
      unhoverStation(stationKey);
    },
    [stationKey, unhoverStation],
  );

  const state = status?.state ?? 'connecting';
  const hasData = layout.spans.length > 0;

  // Where the data actually stops. Normally at or past the right edge, because
  // the shared window ends far enough behind now for every station to have
  // reached it — but a station running later than the rest still shows its
  // shortfall rather than being stretched to fit.
  const awaitingFrom =
    layout.newestSampleMs === null
      ? 0
      : Math.max(
          0,
          Math.min(100, ((layout.newestSampleMs - windowStartMs) / (windowEndMs - windowStartMs)) * 100),
        );

  // How old this station's newest sample is. This is the per-station delay that
  // used to be readable only as where the ink stopped — which looked like a
  // broken container. A number says it without breaking the shared time axis.
  const ageSeconds =
    layout.newestSampleMs === null ? null : Math.max(0, Math.round((nowMs - layout.newestSampleMs) / 1000));

  const note = (() => {
    if (state === 'rejected') return status?.rejectedReason ?? 'not available';
    if (state === 'stalled') return 'no packets — stalled';
    if (!hasData) return state === 'live' ? 'waiting for a full record' : 'connecting';
    return null;
  })();

  return (
    <li
      className={styles.row}
      onMouseEnter={() => {
        hoverStation(stationKey);
      }}
      onMouseLeave={() => {
        unhoverStation(stationKey);
      }}
    >
      <div className={styles.rowLabel}>
        <span className={styles.station}>
          {channel.network} {channel.station}
          {/* Always printed for a pick, because the nearest station is
              routinely far — 74 km from Tokyo, over 800 km mid-ocean — and a
              row with no distance implies it is under the click. The compass
              point says which side it watches from, which is what the
              surround rule chose it for. */}
          {channel.distanceKm !== null && (
            <span className={styles.distance}>
              {' '}
              · {formatDistanceKm(channel.distanceKm)}
              {channel.bearingDeg !== null && channel.distanceKm >= 1
                ? ` ${compassPoint(channel.bearingDeg)}`
                : ''}
            </span>
          )}
        </span>
        <span className={styles.site} title={channel.site}>
          {channel.site}
        </span>
      </div>

      <div className={styles.plot} data-state={state}>
        <svg
          className={styles.trace}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {/* The centre line is the station's own mean, removed. */}
          <line className={styles.centreLine} x1="0" y1="50" x2="100" y2="50" />
          {layout.newestSampleMs !== null && awaitingFrom < 100 && (
            <rect
              className={styles.awaiting}
              x={awaitingFrom}
              y="0"
              width={100 - awaitingFrom}
              height="100"
            />
          )}
          {layout.spans.map((span, index) => (
            <polyline
              // Spans have no identity of their own — they are a decimation of
              // the buffer, rebuilt whole on every layout.
              key={index}
              className={styles.line}
              points={polylinePoints(span, layout)}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {note !== null && <span className={styles.note}>{note}</span>}
      </div>

      <div className={styles.rowScale}>
        {hasData ? (
          <>
            <span className={styles.scaleValue}>±{formatCounts(layout.scaleCounts)}</span>
            <span className={styles.scaleUnit}>counts</span>
            {ageSeconds !== null && (
              <span
                className={styles.age}
                title={`Newest sample from this station is ${String(ageSeconds)} s old`}
              >
                {ageSeconds}s old
              </span>
            )}
          </>
        ) : (
          <span className={styles.scaleUnit}>—</span>
        )}
      </div>
    </li>
  );
}
