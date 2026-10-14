import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  calendarDayStartMs,
  compareCalendarDays,
  type CalendarDay,
} from '@terra-pulse/schema';
import {
  dayInBounds,
  decadeOf,
  decadesBetween,
  monthGrid,
  monthInBounds,
  openingView,
  shiftMonth,
  yearInBounds,
  type PickerView,
} from './date-picker';
import { formatUtcDay } from './time-labels';
import styles from './DatePicker.module.css';

interface DatePickerProps {
  id: string;
  /** "From" or "To" — the row's label, and the dialog's accessible name. */
  label: string;
  value: CalendarDay | null;
  /** Where to open when there is no value yet: the range's other end. */
  hint: CalendarDay | null;
  min: CalendarDay;
  max: CalendarDay;
  /** Whether the range these dates describe is the one on the globe. */
  active: boolean;
  /**
   * Controlled by the parent, because picking a start opens the end's
   * calendar — which one is open is a fact about the pair, not about either.
   */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (day: CalendarDay) => void;
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** "Mar", via the locale, read in UTC so the 1st cannot slip into February. */
function monthName(month: number, style: 'short' | 'long'): string {
  return new Date(Date.UTC(2001, month - 1, 1)).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    month: style,
  });
}

/**
 * One end of a date range: a button showing the day, and a calendar that
 * opens beside it.
 *
 * The calendar is picked by clicking and nothing is typed, at the user's
 * request. A fresh pick goes year, then month, then day; see `openingView` for
 * why it starts on the year.
 */
export function DatePicker(props: DatePickerProps) {
  const { id, label, value, active, open, onOpenChange } = props;
  const fieldRef = useRef<HTMLButtonElement | null>(null);

  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <button
        ref={fieldRef}
        id={id}
        type="button"
        className={
          value === null
            ? `${styles.field} ${styles.fieldEmpty}`
            : active
              ? `${styles.field} ${styles.fieldActive}`
              : styles.field
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        {value === null ? 'pick a date' : formatUtcDay(calendarDayStartMs(value))}
      </button>
      {open && <Calendar {...props} anchorRef={fieldRef} />}
    </div>
  );
}

/** Gap between the field and the calendar, and the least margin to the window's edge. */
const POPOVER_GAP_PX = 20;
const WINDOW_MARGIN_PX = 8;

/**
 * The calendar itself. Mounted only while open, so its starting step and
 * month come from `useState`'s initialiser instead of an effect that would
 * have to notice the picker opening.
 *
 * **Portalled to the body and placed with `position: fixed`.** It is wider
 * than the left column it belongs to, and the column sits beside the
 * selection column at `z-index: 10` — drawn in place it would open underneath
 * the inspector. Out here nothing can clip it or paint over it.
 */
function Calendar({
  label,
  value,
  hint,
  min,
  max,
  onChange,
  onOpenChange,
  anchorRef,
}: DatePickerProps & { anchorRef: RefObject<HTMLButtonElement | null> }) {
  const [opening] = useState(() => openingView(value, hint, max));
  const [view, setView] = useState<PickerView>(opening.view);
  const [year, setYear] = useState(opening.year);
  const [month, setMonth] = useState(opening.month);
  const [decade, setDecade] = useState(decadeOf(opening.year));
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Placed once, when the node appears: to the right of the field, and pulled
  // up if it would run off the bottom. Written straight to the style — the
  // position depends on nothing React renders, and the calendar is a fixed
  // size whichever step is showing, so it never needs redoing.
  const place = (node: HTMLDivElement | null) => {
    popoverRef.current = node;
    const anchor = anchorRef.current;
    if (node === null || anchor === null) return;
    const field = anchor.getBoundingClientRect();
    const top = Math.max(
      WINDOW_MARGIN_PX,
      Math.min(field.top - 40, window.innerHeight - node.offsetHeight - WINDOW_MARGIN_PX),
    );
    node.style.left = `${String(Math.round(field.right + POPOVER_GAP_PX))}px`;
    node.style.top = `${String(Math.round(top))}px`;
  };

  useEffect(() => {
    const close = () => {
      onOpenChange(false);
    };

    // Capture phase, so a click on the globe closes the calendar even though
    // Cesium's own handlers never let the event bubble back up.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (popoverRef.current?.contains(target)) return;
      // The field toggles on its own click; closing here too would reopen it.
      if (anchorRef.current?.contains(target)) return;
      close();
    };

    // Also capture, and stopped: Escape is the antipode view's exit too, and
    // one press should close the thing on top, not both.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
      anchorRef.current?.focus();
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    // The position was worked out for the old window; simpler to close than
    // to chase the field around.
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', close);
    };
  }, [onOpenChange, anchorRef]);

  const pick = (day: CalendarDay) => {
    onChange(day);
    onOpenChange(false);
  };

  const previous = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);

  return createPortal(
    <div
      ref={place}
      className={styles.popover}
      role="dialog"
      aria-label={`${label} date`}
    >
      {view === 'year' && (
        <>
          <p className={styles.step}>Year</p>
          <div className={styles.grid5}>
            {decadesBetween(min.year, max.year).map((start) => (
              <button
                key={start}
                type="button"
                className={start === decade ? `${styles.cell} ${styles.cellCurrent}` : styles.cell}
                aria-pressed={start === decade}
                onClick={() => {
                  setDecade(start);
                }}
              >
                {start}s
              </button>
            ))}
          </div>
          <div className={`${styles.grid5} ${styles.years}`}>
            {Array.from({ length: 10 }, (_, offset) => decade + offset).map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={
                  candidate === value?.year ? `${styles.cell} ${styles.cellSelected}` : styles.cell
                }
                disabled={!yearInBounds(candidate, min, max)}
                onClick={() => {
                  setYear(candidate);
                  setView('month');
                }}
              >
                {candidate}
              </button>
            ))}
          </div>
        </>
      )}

      {view === 'month' && (
        <>
          <div className={styles.header}>
            <button
              type="button"
              className={styles.headerButton}
              onClick={() => {
                setDecade(decadeOf(year));
                setView('year');
              }}
              title="Choose a different year"
            >
              ‹ {year}
            </button>
          </div>
          <div className={styles.grid4}>
            {Array.from({ length: 12 }, (_, index) => index + 1).map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={
                  candidate === value?.month && year === value.year
                    ? `${styles.cell} ${styles.cellTall} ${styles.cellSelected}`
                    : `${styles.cell} ${styles.cellTall}`
                }
                disabled={!monthInBounds(year, candidate, min, max)}
                onClick={() => {
                  setMonth(candidate);
                  setView('day');
                }}
              >
                {monthName(candidate, 'short')}
              </button>
            ))}
          </div>
        </>
      )}

      {view === 'day' && (
        <>
          <div className={styles.header}>
            <button
              type="button"
              className={styles.arrow}
              aria-label="Previous month"
              disabled={!monthInBounds(previous.year, previous.month, min, max)}
              onClick={() => {
                setYear(previous.year);
                setMonth(previous.month);
              }}
            >
              ‹
            </button>
            <span className={styles.title}>
              <button
                type="button"
                className={styles.headerButton}
                onClick={() => {
                  setView('month');
                }}
                title="Choose a different month"
              >
                {monthName(month, 'long')}
              </button>
              <button
                type="button"
                className={styles.headerButton}
                onClick={() => {
                  setDecade(decadeOf(year));
                  setView('year');
                }}
                title="Choose a different year"
              >
                {year}
              </button>
            </span>
            <button
              type="button"
              className={styles.arrow}
              aria-label="Next month"
              disabled={!monthInBounds(next.year, next.month, min, max)}
              onClick={() => {
                setYear(next.year);
                setMonth(next.month);
              }}
            >
              ›
            </button>
          </div>
          <div className={styles.grid7} aria-hidden="true">
            {WEEKDAYS.map((weekday, index) => (
              <span key={index} className={styles.weekday}>
                {weekday}
              </span>
            ))}
          </div>
          <div className={styles.grid7}>
            {monthGrid(year, month).map((day, index) => {
              if (day === null) return <span key={`blank-${String(index)}`} />;
              const candidate = { year, month, day };
              const selected = value !== null && compareCalendarDays(candidate, value) === 0;
              return (
                <button
                  key={day}
                  type="button"
                  className={selected ? `${styles.cell} ${styles.cellSelected}` : styles.cell}
                  disabled={!dayInBounds(candidate, min, max)}
                  onClick={() => {
                    pick(candidate);
                  }}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </>
      )}

      <div className={styles.footer}>
        <span>days are UTC</span>
        <button
          type="button"
          className={styles.headerButton}
          onClick={() => {
            pick(max);
          }}
        >
          Today
        </button>
      </div>
    </div>,
    document.body,
  );
}
