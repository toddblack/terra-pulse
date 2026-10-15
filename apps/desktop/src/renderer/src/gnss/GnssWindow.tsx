import { useCallback, useId, useRef, useState, type PointerEvent } from 'react';
import {
  GNSS_BEFORE_SPANS,
  gnssQuakeDayMs,
  type GnssStationSeries,
  type GnssStep,
} from '@terra-pulse/schema';
import { LayerGuideButton } from '../panels/LayerGuideModal';
import { compassPoint } from '../waveforms/station-pick';
import { GNSS_GUIDE_ID } from './gnss-guide';
import {
  GNSS_COMPONENTS,
  changeAcrossQuake,
  componentSamples,
  consecutiveRuns,
  describeStep,
  fitDomain,
  formatMm,
  nearestSample,
  offScale,
  relativeTicks,
  timeExtent,
  visibleSteps,
  type GnssComponent,
  type PlotSample,
  type RelativeTick,
} from './gnss-plot';
import { gnssView, useGnssStore, type GnssSubject } from './useGnssStore';
import styles from './GnssWindow.module.css';

const DAY_MS = 86_400_000;

/** Plot height in px, per row. */
const PLOT_HEIGHT = 64;
/** Room on the left of each plot for the scale's end labels. */
const GUTTER = 44;
/** How many marked steps the footer names before summarising the rest. */
const MAX_LISTED_STEPS = 4;
/** Before the first measurement, so the first frame is not a zero-width plot. */
const FALLBACK_WIDTH = 440;

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function formatRelative(dayMs: number, quakeDay: number): string {
  const days = Math.round((dayMs - quakeDay) / DAY_MS);
  if (days === 0) return 'the day of the quake';
  return days < 0 ? `${String(-days)} d before` : `${String(days)} d after`;
}

function formatVelocity(metresPerYear: number): string {
  const mm = metresPerYear * 1000;
  return `${mm > 0 ? '+' : mm < 0 ? '−' : ''}${Math.abs(mm).toFixed(1)}`;
}

/**
 * A floating window of GPS positions around one quake — §5.15.
 *
 * **Movable because it is a thing to keep open**, unlike the inspector's
 * sections: a reader compares a station's graph against the globe, the
 * timeline or another quake, and wherever the window opens is in the way of
 * something. Dragged by its title bar; the position is kept until the app
 * closes.
 *
 * It belongs to the quake it was opened for, not to the selection — see
 * `useGnssStore`.
 */
export function GnssWindow() {
  const subject = useGnssStore((state) => state.subject);
  const loaded = useGnssStore((state) => state.loaded);
  const position = useGnssStore((state) => state.position);
  const close = useGnssStore((state) => state.close);
  const moveTo = useGnssStore((state) => state.moveTo);

  const windowRef = useRef<HTMLElement | null>(null);
  const drag = useRef<{ dx: number; dy: number; pointerId: number } | null>(null);

  const view = gnssView(subject, loaded);

  const onHeaderPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    // The header's own buttons keep their clicks.
    if ((event.target as HTMLElement).closest('button')) return;
    const node = windowRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    drag.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, []);

  const onHeaderPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const current = drag.current;
      const node = windowRef.current;
      if (!current || current.pointerId !== event.pointerId || !node) return;
      const { width } = node.getBoundingClientRect();
      // Kept on screen: wholly within the width, and the title bar always
      // reachable, or a window dragged off an edge could not be dragged back.
      const x = Math.min(Math.max(0, event.clientX - current.dx), window.innerWidth - width);
      const y = Math.min(Math.max(0, event.clientY - current.dy), window.innerHeight - 40);
      moveTo({ x: Math.max(0, x), y });
    },
    [moveTo],
  );

  const onHeaderPointerUp = useCallback((event: PointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }, []);

  if (view.status === 'closed') return null;

  return (
    <section
      id="gnss-window"
      ref={windowRef}
      className={position ? styles.window : `${styles.window} ${styles.openingPlace}`}
      // `min()` holds a dragged position on screen if the app window is later
      // made smaller.
      style={
        position
          ? {
              left: `min(${String(position.x)}px, calc(100vw - 8rem))`,
              top: `min(${String(position.y)}px, calc(100vh - 3rem))`,
            }
          : undefined
      }
      aria-label="Ground position from GPS"
    >
      <header
        className={styles.titleBar}
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <span className={styles.titleGroup}>
          <span className={styles.title}>Ground position · GPS</span>
          <LayerGuideButton layerId={GNSS_GUIDE_ID} />
        </span>
        <button
          id="gnss-close"
          type="button"
          className={styles.closeButton}
          onClick={close}
          aria-label="Close the GPS window"
        >
          ×
        </button>
      </header>
      <p className={styles.subject}>
        M{view.subject.magnitude.toFixed(1)} · {view.subject.place} ·{' '}
        {formatDay(Date.parse(view.subject.originUtc))}
      </p>

      {view.status === 'loading' && (
        <p className={styles.message}>Asking the Nevada Geodetic Laboratory…</p>
      )}
      {view.status === 'ready' && view.outcome.status === 'error' && (
        <p className={styles.message}>Could not reach the Nevada Geodetic Laboratory.</p>
      )}
      {view.status === 'ready' && view.outcome.status === 'none' && (
        <p className={styles.message}>
          No GPS station was recording across this quake within{' '}
          {Math.round(view.outcome.reachKm).toLocaleString()} km — the distance the lab treats as
          close enough for an M{view.subject.magnitude.toFixed(1)} to have moved one.
          {view.outcome.nearestKm !== null &&
            ` The nearest that was recording was ${Math.round(view.outcome.nearestKm).toLocaleString()} km away.`}
        </p>
      )}
      {view.status === 'ready' && view.outcome.status === 'available' && (
        <StationsView subject={view.subject} stations={view.outcome.stations} />
      )}
    </section>
  );
}

function StationsView({ subject, stations }: { subject: GnssSubject; stations: GnssStationSeries[] }) {
  const spanId = useGnssStore((state) => state.spanId);
  const setSpan = useGnssStore((state) => state.setSpan);
  const removeDrift = useGnssStore((state) => state.removeDrift);
  const setRemoveDrift = useGnssStore((state) => state.setRemoveDrift);
  const stationIndex = useGnssStore((state) => state.stationIndex);
  const setStationIndex = useGnssStore((state) => state.setStationIndex);

  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);

  // A ref callback rather than an effect, per `published-size.ts`: the plots
  // unmount and remount as the outcome changes, and an effect would be left
  // observing a detached node.
  const measure = useCallback((node: HTMLDivElement | null) => {
    if (!node) return undefined;
    const update = () => {
      const measured = node.getBoundingClientRect().width;
      if (measured > 0) setWidth(measured);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  const station = stations[Math.min(stationIndex, stations.length - 1)] ?? stations[0];
  const originMs = Date.parse(subject.originUtc);
  const quakeDay = gnssQuakeDayMs(originMs);
  const spanDays = GNSS_BEFORE_SPANS.find((span) => span.id === spanId)?.days ?? 90;
  const driftRemoved = removeDrift && station !== undefined && station.velocity !== null;

  if (!station) return null;

  // No manual memoisation: the React Compiler does it, and this is at most
  // ~400 days times three rows of arithmetic.
  const rows = GNSS_COMPONENTS.map((component) => {
    const samples = componentSamples(station, component.id, originMs, spanDays, driftRemoved);
    const domain = fitDomain(samples, component.minSpanMm);
    return {
      component,
      samples,
      domain,
      change: changeAcrossQuake(samples),
      off: offScale(samples, domain),
    };
  });
  const ticks = relativeTicks(originMs, spanDays);
  const steps = station.steps ? visibleSteps(station.steps, originMs, spanDays) : [];

  const extent = timeExtent(originMs, spanDays);
  const hoveredDay = hoverMs === null ? null : (rows.map((row) => nearestSample(row.samples, hoverMs)).find(Boolean) ?? null);
  const recordEndsEarly = station.lastDayMs < extent.endMs - DAY_MS;

  return (
    <>
      {stations.length > 1 && (
        <div className={styles.stationTabs} role="tablist" aria-label="Station">
          {stations.map((s, index) => (
            <button
              key={s.station}
              type="button"
              role="tab"
              aria-selected={s === station}
              className={s === station ? `${styles.stationTab} ${styles.stationTabActive}` : styles.stationTab}
              onClick={() => setStationIndex(index)}
              title={`${s.station}, ${Math.round(s.distanceKm)} km ${compassPoint(s.bearingDeg)} of the epicentre`}
            >
              {s.station} · {Math.round(s.distanceKm)} km {compassPoint(s.bearingDeg)}
            </button>
          ))}
        </div>
      )}

      <div className={styles.controls}>
        <span className={styles.spanGroup} role="group" aria-label="How far back">
          {GNSS_BEFORE_SPANS.map((span) => (
            <button
              key={span.id}
              type="button"
              aria-pressed={span.id === spanId}
              className={span.id === spanId ? `${styles.spanButton} ${styles.spanButtonActive}` : styles.spanButton}
              onClick={() => setSpan(span.id)}
            >
              {span.label}
            </button>
          ))}
        </span>
        <label className={styles.driftToggle} title={station.velocity ? undefined : 'The lab publishes no velocity for this station'}>
          <input
            type="checkbox"
            checked={driftRemoved}
            disabled={station.velocity === null}
            onChange={(event) => setRemoveDrift(event.target.checked)}
          />
          remove steady drift
        </label>
      </div>

      <p className={styles.caption}>
        {hoveredDay ? (
          <span className={styles.readout}>
            {formatDay(hoveredDay.dayMs)} · {formatRelative(hoveredDay.dayMs, quakeDay)}
          </span>
        ) : (
          <>
            {stations.length === 1 && `${station.station} · `}
            {Math.round(station.distanceKm)} km {compassPoint(station.bearingDeg)} of the epicentre ·
            zero is its last week before the quake
          </>
        )}
      </p>

      <div ref={measure} className={styles.rows}>
        {rows.map((row) => (
          <ComponentRow
            key={row.component.id}
            component={row.component.id}
            label={row.component.label}
            samples={row.samples}
            domain={row.domain}
            change={row.change}
            off={row.off}
            extent={extent}
            originMs={originMs}
            ticks={ticks}
            steps={steps}
            width={width}
            hoverMs={hoverMs}
            onHover={setHoverMs}
          />
        ))}
        <TickAxis ticks={ticks} extent={extent} width={width} />
      </div>

      <div className={styles.footer}>
        <p>
          {driftRemoved && station.velocity
            ? `Steady drift removed: ${formatVelocity(station.velocity.eastMPerYr)} E, ${formatVelocity(station.velocity.northMPerYr)} N, ${formatVelocity(station.velocity.upMPerYr)} up mm/yr (the lab's MIDAS velocity).`
            : station.velocity
              ? 'Raw positions: the steady plate drift is still in.'
              : 'Raw positions: the lab publishes no velocity for this station.'}
        </p>
        {/* Every marked line in words, because a line two days before the
            quake is exactly where a reader looks for a precursor, and at
            Ridgecrest it is the M6.4 foreshock. */}
        {steps.length > 0 && (
          <p>
            Also marked:{' '}
            {steps
              .slice(0, MAX_LISTED_STEPS)
              .map(
                (step) =>
                  `${formatDay(step.dayMs)}, ${describeStep(step)} (${step.kind === 'earthquake' ? 'orange line' : 'dotted line'})`,
              )
              .join('; ')}
            {steps.length > MAX_LISTED_STEPS && `; and ${String(steps.length - MAX_LISTED_STEPS)} more`}.
          </p>
        )}
        {station.steps === null && (
          <p>Equipment changes unknown: the station's page could not be read.</p>
        )}
        {recordEndsEarly && (
          <p>
            The record ends {formatDay(station.lastDayMs)} — the lab runs about two weeks behind.
          </p>
        )}
        <p className={styles.credit}>
          Nevada Geodetic Laboratory (Blewitt et al. 2018) ·{' '}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => {
              void window.terraPulse.shell.openExternal(
                `https://geodesy.unr.edu/NGLStationPages/stations/${station.station}.sta`,
              );
            }}
          >
            station page ↗
          </button>
          {station.doi !== null && (
            <>
              {' · '}
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  if (station.doi) void window.terraPulse.shell.openExternal(station.doi);
                }}
              >
                data DOI ↗
              </button>
            </>
          )}
        </p>
      </div>
    </>
  );
}

interface ComponentRowProps {
  component: GnssComponent;
  label: string;
  samples: PlotSample[];
  domain: { lo: number; hi: number };
  change: number | null;
  off: 'above' | 'below' | null;
  extent: { startMs: number; endMs: number };
  originMs: number;
  ticks: RelativeTick[];
  steps: GnssStep[];
  width: number;
  hoverMs: number | null;
  onHover: (ms: number | null) => void;
}

function ComponentRow({
  label,
  samples,
  domain,
  change,
  off,
  extent,
  originMs,
  ticks,
  steps,
  width,
  hoverMs,
  onHover,
}: ComponentRowProps) {
  const clipId = useId();
  const plotWidth = Math.max(1, width - GUTTER);
  const x = (ms: number) =>
    GUTTER + ((ms - extent.startMs) / (extent.endMs - extent.startMs)) * plotWidth;
  const y = (mm: number) => 2 + ((domain.hi - mm) / (domain.hi - domain.lo)) * (PLOT_HEIGHT - 4);

  const hovered = hoverMs === null ? null : nearestSample(samples, hoverMs);
  const quakeX = x(originMs);

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left - GUTTER;
    if (px < 0) {
      onHover(null);
      return;
    }
    onHover(extent.startMs + (px / plotWidth) * (extent.endMs - extent.startMs));
  };

  return (
    <div className={styles.row}>
      <div className={styles.rowHeader}>
        <span className={styles.rowTitle}>{label}</span>
        {hovered ? (
          <span className={styles.readout}>{formatMm(hovered.mm)}</span>
        ) : change !== null ? (
          <span className={styles.rowCaption}>
            across the quake {formatMm(change)}
            {off === 'above' && ' · ↑ off scale'}
            {off === 'below' && ' · ↓ off scale'}
          </span>
        ) : (
          <span className={styles.rowCaption}>no days after the quake yet</span>
        )}
      </div>
      <svg
        className={styles.plot}
        width={width}
        height={PLOT_HEIGHT}
        role="img"
        aria-label={`${label} position, millimetres from the week before the quake`}
        onPointerMove={onPointerMove}
        onPointerLeave={() => onHover(null)}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={GUTTER} y={0} width={plotWidth} height={PLOT_HEIGHT} />
          </clipPath>
        </defs>

        <text className={styles.scaleLabel} x={GUTTER - 4} y={9} textAnchor="end">
          {formatMm(domain.hi)}
        </text>
        <text className={styles.scaleLabel} x={GUTTER - 4} y={PLOT_HEIGHT - 2} textAnchor="end">
          {formatMm(domain.lo)}
        </text>

        {ticks.map((tick) => (
          <line
            key={tick.days}
            className={styles.tickLine}
            x1={x(tick.atMs)}
            x2={x(tick.atMs)}
            y1={0}
            y2={PLOT_HEIGHT}
          />
        ))}
        <line className={styles.zeroLine} x1={GUTTER} x2={width} y1={y(0)} y2={y(0)} />

        {steps.map((step) =>
          step.kind === 'equipment' ? (
            <line
              key={`e${String(step.dayMs)}`}
              className={styles.equipmentLine}
              x1={x(step.dayMs + DAY_MS / 2)}
              x2={x(step.dayMs + DAY_MS / 2)}
              y1={0}
              y2={PLOT_HEIGHT}
            >
              <title>{`${formatDay(step.dayMs)}: ${describeStep(step)}`}</title>
            </line>
          ) : (
            // Full height, not a tick along the top: the first version drew
            // a 6 px tick and the Ridgecrest M6.4 foreshock, which explains
            // the drop two days before the M7.1, could not be found on it.
            <line
              key={`q${String(step.dayMs)}`}
              className={styles.otherQuakeLine}
              x1={x(step.dayMs + DAY_MS / 2)}
              x2={x(step.dayMs + DAY_MS / 2)}
              y1={0}
              y2={PLOT_HEIGHT}
            >
              <title>{`${formatDay(step.dayMs)}: ${describeStep(step)}`}</title>
            </line>
          ),
        )}

        <line className={styles.quakeLine} x1={quakeX} x2={quakeX} y1={0} y2={PLOT_HEIGHT} />

        <g clipPath={`url(#${clipId})`}>
          {consecutiveRuns(samples).map((run) =>
            run.length > 1 ? (
              <polyline
                key={run[0]?.dayMs}
                className={styles.line}
                points={run.map((s) => `${x(s.atMs).toFixed(1)},${y(s.mm).toFixed(1)}`).join(' ')}
              />
            ) : null,
          )}
          {samples.map((s) => (
            <circle key={s.dayMs} className={styles.dot} cx={x(s.atMs)} cy={y(s.mm)} r={1.4} />
          ))}
        </g>

        {/* Days off the scale — usually the month after a big quake, since the
            scale is fitted to the days before — pinned to the edge they left
            by, as arrowheads pointing the way they went. Clipped away instead,
            the month after looked like a month with no data, which is the
            first thing the Ridgecrest screenshot showed. How far they went is
            in the row header. */}
        {samples.map((s) => {
          if (s.mm >= domain.lo && s.mm <= domain.hi) return null;
          const cx = x(s.atMs);
          const above = s.mm > domain.hi;
          const points = above
            ? `${String(cx - 2.5)},5 ${String(cx + 2.5)},5 ${String(cx)},1`
            : `${String(cx - 2.5)},${String(PLOT_HEIGHT - 5)} ${String(cx + 2.5)},${String(PLOT_HEIGHT - 5)} ${String(cx)},${String(PLOT_HEIGHT - 1)}`;
          return <polygon key={`o${String(s.dayMs)}`} className={styles.edgeMark} points={points} />;
        })}

        {hovered && (
          <>
            <line
              className={styles.hoverLine}
              x1={x(hovered.atMs)}
              x2={x(hovered.atMs)}
              y1={0}
              y2={PLOT_HEIGHT}
            />
            {hovered.mm >= domain.lo && hovered.mm <= domain.hi && (
              <circle className={styles.hoverDot} cx={x(hovered.atMs)} cy={y(hovered.mm)} r={3} />
            )}
          </>
        )}
      </svg>
    </div>
  );
}

function TickAxis({
  ticks,
  extent,
  width,
}: {
  ticks: RelativeTick[];
  extent: { startMs: number; endMs: number };
  width: number;
}) {
  const plotWidth = Math.max(1, width - GUTTER);
  return (
    <div className={styles.axis} style={{ width }}>
      {ticks.map((tick, index) => (
        <span
          key={tick.days}
          // The last tick is the right edge of the plot; centred, it would
          // overhang the window.
          className={index === ticks.length - 1 ? `${styles.tick} ${styles.tickEnd}` : styles.tick}
          style={{
            left: `${String(GUTTER + ((tick.atMs - extent.startMs) / (extent.endMs - extent.startMs)) * plotWidth)}px`,
          }}
        >
          {tick.label}
        </span>
      ))}
    </div>
  );
}
