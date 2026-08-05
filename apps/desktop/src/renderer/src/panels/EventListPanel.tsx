import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EarthquakeEvent } from '@terra-pulse/schema';
import { useEarthquakeStore } from '../state/useEarthquakeStore';
import { useEarthquakesUpToPlayhead } from '../globe/useVisibleEarthquakes';
import { totalHeightPx, visibleRange } from './event-list-window';
import { formatRange } from './RangeControls';
import styles from './EventListPanel.module.css';

/**
 * A browsable list of exactly what the globe is drawing.
 *
 * Reads `useEarthquakesUpToPlayhead` — the same projection the count in the
 * legend uses — so the list, the count and the marks can never disagree. It
 * follows the magnitude floor, the window, band isolation, the playhead and the
 * trailing window without knowing about any of them.
 */

type SortMode = 'time' | 'magnitude';

/** Compact and absolute. A relative age on 26,000 rows is unreadable. */
function formatWhen(timeUtc: string): string {
  const ms = Date.parse(timeUtc);
  if (!Number.isFinite(ms)) return '';

  const date = new Date(ms);
  const iso = date.toISOString();
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 16);

  // Year is only interesting once the view spans more than one, and the
  // archive views always do. Dropping it in live views buys room for the place.
  const thisYear = new Date().getUTCFullYear();
  return date.getUTCFullYear() === thisYear ? `${day.slice(5)} ${time}` : day;
}

function sortEvents(events: readonly EarthquakeEvent[], mode: SortMode): EarthquakeEvent[] {
  const sorted = [...events];
  if (mode === 'magnitude') {
    sorted.sort((a, b) => b.magnitude - a.magnitude || Date.parse(b.timeUtc) - Date.parse(a.timeUtc));
  } else {
    sorted.sort((a, b) => Date.parse(b.timeUtc) - Date.parse(a.timeUtc));
  }
  return sorted;
}

export function EventListPanel() {
  const open = useEarthquakeStore((state) => state.eventListOpen);
  const setOpen = useEarthquakeStore((state) => state.setEventListOpen);
  const select = useEarthquakeStore((state) => state.select);
  const selectedEventId = useEarthquakeStore((state) => state.selectedEventId);
  const minMagnitude = useEarthquakeStore((state) => state.minMagnitude);
  const isolateBand = useEarthquakeStore((state) => state.isolateBand);

  const events = useEarthquakesUpToPlayhead();
  const [sortMode, setSortMode] = useState<SortMode>('time');
  const sorted = useMemo(() => sortEvents(events, sortMode), [events, sortMode]);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  /**
   * Measured, because the panel's height is a `vh` calculation with no constant
   * to read it from.
   *
   * **A ref callback rather than an effect, and that is the bug fix.** With an
   * effect keyed on `open`, the observer was bound to whichever element existed
   * when the panel opened. Pick a floor with no events, the scroller unmounts,
   * Chromium reports 0x0 on the way out — and when the element came back the
   * effect never re-ran, so the observer went on watching a detached node and
   * the height stayed 0. The list rendered nothing while the scrollbar still
   * described a full list. Closing and reopening "fixed" it because that is the
   * only thing that re-ran the effect.
   *
   * A ref callback fires with every node change, so the observer can never be
   * left attached to the wrong one. React 19 runs the returned cleanup on
   * detach.
   */
  const attachScroller = useCallback((node: HTMLDivElement | null) => {
    scrollerRef.current = node;
    if (!node) return;

    const observer = new ResizeObserver(() => {
      setViewportHeight(node.clientHeight);
    });
    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, []);

  // A filter change can leave the scroll position past the end of a now-shorter
  // list, which renders an empty panel that looks broken until you scroll.
  // Scrolling the element fires `onScroll`, which is what updates the tracked
  // position — so this doesn't set state itself. When already at the top no
  // event fires, and none is needed: the tracked value is already 0.
  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
  }, [sortMode, minMagnitude, isolateBand]);

  if (!open) {
    return (
      <button
        type="button"
        id="event-list-open"
        className={styles.collapsedButton}
        aria-label="Show earthquake list"
        aria-expanded={false}
        aria-controls="event-list"
        onClick={() => setOpen(true)}
      >
        <span className={styles.icon} aria-hidden="true">
          <span className={styles.iconBar} />
          <span className={styles.iconBar} />
          <span className={styles.iconBar} />
        </span>
        {events.length.toLocaleString()}
      </button>
    );
  }

  const { first, end, offsetTop } = visibleRange(scrollTop, viewportHeight, sorted.length);
  const slice = sorted.slice(first, end);

  return (
    <div id="event-list" className={styles.panel}>
      <div className={styles.header}>
        <h2 className={styles.title}>Events · {formatRange(minMagnitude, isolateBand)}</h2>
        <button
          type="button"
          id="event-list-close"
          className={styles.closeButton}
          aria-label="Hide earthquake list"
          aria-expanded
          aria-controls="event-list"
          onClick={() => setOpen(false)}
        >
          ×
        </button>
      </div>

      <div className={styles.sortRow} role="group" aria-label="Sort order">
        {(['time', 'magnitude'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={sortMode === mode}
            className={
              sortMode === mode
                ? `${styles.sortButton} ${styles.sortButtonActive}`
                : styles.sortButton
            }
            onClick={() => setSortMode(mode)}
          >
            {mode === 'time' ? 'newest' : 'largest'}
          </button>
        ))}
      </div>

      {/* The scroller stays mounted even when empty. Swapping it for a message
          destroyed and recreated the element on every filter change, which is
          what let the resize observation drift onto a detached node. */}
      <div
        ref={attachScroller}
        className={styles.scroller}
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
        }}
      >
        {sorted.length === 0 ? (
          <p className={styles.empty}>nothing in this window</p>
        ) : (
          /* Full-height spacer, so the scrollbar describes the whole list
             while only the visible slice exists as elements. */
          <div className={styles.spacer} style={{ height: totalHeightPx(sorted.length) }}>
            <div style={{ transform: `translateY(${String(offsetTop)}px)` }}>
              {slice.map((event) => (
                <button
                  key={event.id}
                  type="button"
                  className={
                    event.id === selectedEventId
                      ? `${styles.row} ${styles.rowSelected}`
                      : styles.row
                  }
                  // Same contract as every other click-to-fly surface: select
                  // parks a focusRequest, which is the only thing that moves
                  // the camera. The panel stays open — you're browsing.
                  onClick={() => {
                    select(event.id);
                  }}
                >
                  <span className={styles.magnitude}>M{event.magnitude.toFixed(1)}</span>
                  <span className={styles.place}>{event.place}</span>
                  <span className={styles.when}>{formatWhen(event.timeUtc)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <p className={styles.footnote}>
        {sorted.length.toLocaleString()} shown · matches the globe
      </p>
    </div>
  );
}
