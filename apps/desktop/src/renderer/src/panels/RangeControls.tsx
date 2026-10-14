import { useEffect, useState } from 'react';
import {
  ARCHIVE_ANALYSIS_MIN_MAGNITUDE,
  ARCHIVE_MIN_MAGNITUDE,
  ARCHIVE_SPANS,
  ARCHIVE_START_YEAR,
  DATE_RANGE_FIRST_YEAR,
  DEEP_ARCHIVE_MIN_MAGNITUDE,
  COVERAGE_TIERS,
  archiveSpanHours,
  calendarDayOf,
  dateRangeFromDays,
  magnitudeFloorsForRange,
  magnitudeFloorsForWindow,
  minMagnitudeForRange,
  minMagnitudeForWindow,
  nextMagnitudeFloorAbove,
  previousWindowHours,
  type CalendarDay,
  type DateRange,
} from '@terra-pulse/schema';
import { useEarthquakeStore, viewStartMs } from '../state/useEarthquakeStore';
import { useNow } from '../globe/useNow';
import { DatePicker } from './DatePicker';
import { withFrom } from './date-picker';
import { formatYearRanges } from './sequence-format';
import styles from './RangeControls.module.css';

/**
 * What each magnitude floor actually means for coverage.
 *
 * Measured on the USGS + EMSC merge, US share by floor: M1+ 35% · M2.5+ ~15% ·
 * M4.5+ ~3%. Adding EMSC's national-agency aggregation transformed this — USGS
 * alone was 86% at M1+ and 6% at M4+.
 *
 * The residual caveat is no longer "this is a US map". It is that small events
 * are only recorded where instrument networks are dense: an M2 in the mid-
 * Pacific is detected by nobody, and no aggregator fixes that. Completeness
 * becomes genuinely global around M4.5 — measured, USGS misses ~70% of what
 * EMSC reports between M4.0 and M4.5. M5.5 is the only floor whose global count
 * has held steady since 1970, which is why it's here at all.
 *
 * Without the note, switching floors transforms the map with no explanation
 * and invites the wrong conclusion. See PROJECT_PLAN §5.3 and §10.
 */
const COVERAGE_NOTES: Record<number, string> = {
  1: 'instrumented regions only',
  2.5: 'instrumented regions only',
  4.5: 'globally complete',
  5.5: 'globally complete · steady since 1970',
  // The archive floors. Named by USGS's own classes rather than described as
  // "complete" again — above M5.5 completeness stopped being the interesting
  // property, and the class is what a reader is actually picking.
  6: 'strong · 7,910 since 1970',
  7: 'major · 782 since 1970',
};

/**
 * Human label for a window length in hours, matching the selector's own labels
 * so the trailing-window text can't disagree with the button that set it.
 */
export function formatWindowLabel(hours: number): string {
  const tier = COVERAGE_TIERS.find((entry) => entry.windowHours === hours);
  if (tier) return tier.label;
  const span = ARCHIVE_SPANS.find((entry) => archiveSpanHours(entry) === hours);
  if (span) return span.label;
  return `${String(Math.round(hours))}h`;
}

/** "M4.5" rather than "M4.5000000001" — floors include half steps. */
function formatMagnitude(magnitude: number): string {
  return `M${Number.isInteger(magnitude) ? magnitude : magnitude.toFixed(1)}`;
}

/** "M4.5+" for a floor, "M1–2.5" for an isolated band. */
export function formatRange(minMagnitude: number, isolateBand: boolean): string {
  const ceiling = isolateBand ? nextMagnitudeFloorAbove(minMagnitude) : null;
  if (ceiling === null) return `${formatMagnitude(minMagnitude)}+`;
  return `${formatMagnitude(minMagnitude)}–${ceiling.toFixed(1)}`;
}

const FIRST_DAY: CalendarDay = { year: DATE_RANGE_FIRST_YEAR, month: 1, day: 1 };

/** A completed lookup, tagged with the range it describes. */
interface MissingYears {
  key: string;
  years: number[];
}

/**
 * Years of the date range that were never downloaded.
 *
 * An empty globe over an undownloaded year looks exactly like a quiet one, and
 * the calendar can land on any year since 1900 — so this asks, and the panel
 * says which it is.
 *
 * Stored against the range it was asked about, the `useAntipodal` shape: two
 * picks in quick succession fire overlapping requests with no ordering
 * guarantee, and a late reply for the old range must not caption the new one.
 */
function useMissingArchiveYears(dateRange: DateRange | null): number[] {
  const [result, setResult] = useState<MissingYears | null>(null);
  const key = dateRange === null ? null : `${String(dateRange.startMs)}|${String(dateRange.endMs)}`;
  const startMs = dateRange?.startMs ?? null;
  const endMs = dateRange?.endMs ?? null;

  useEffect(() => {
    if (key === null || startMs === null || endMs === null) return;
    let cancelled = false;

    const ask = () => {
      void window.terraPulse.archive
        .missingYears({
          startUtc: new Date(startMs).toISOString(),
          endUtc: new Date(endMs - 1).toISOString(),
        })
        .then(
          (years) => {
            if (!cancelled) setResult({ key, years });
          },
          (error: unknown) => {
            console.error('Could not check archive coverage', error);
          },
        );
    };

    ask();
    // A download running underneath changes the answer year by year, and when
    // it finishes the globe needs the rows it just gained — nothing else
    // reloads a view when the archive lands.
    const unsubscribe = window.terraPulse.archive.onProgress((progress) => {
      ask();
      if (progress.state === 'complete') void useEarthquakeStore.getState().load();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [key, startMs, endMs]);

  return result !== null && result.key === key ? result.years : [];
}

export function RangeControls() {
  const minMagnitude = useEarthquakeStore((state) => state.minMagnitude);
  const setMinMagnitude = useEarthquakeStore((state) => state.setMinMagnitude);
  const windowHours = useEarthquakeStore((state) => state.windowHours);
  const setWindowHours = useEarthquakeStore((state) => state.setWindowHours);
  const toggleArchiveSpan = useEarthquakeStore((state) => state.toggleArchiveSpan);

  const isolateBand = useEarthquakeStore((state) => state.isolateBand);
  const setIsolateBand = useEarthquakeStore((state) => state.setIsolateBand);
  const trailingWindow = useEarthquakeStore((state) => state.trailingWindow);
  const setTrailingWindow = useEarthquakeStore((state) => state.setTrailingWindow);
  const dateRange = useEarthquakeStore((state) => state.dateRange);
  const setDateRange = useEarthquakeStore((state) => state.setDateRange);
  const clearDateRange = useEarthquakeStore((state) => state.clearDateRange);
  const trailHours = previousWindowHours(windowHours);
  const nowMs = useNow();

  /**
   * A half-made pick: one end chosen, the other not yet.
   *
   * Only ever holds that in-between state. Once both ends exist the range goes
   * to the store and this is cleared, so the fields read from the store and
   * empty themselves when the range is left by any route — a History button,
   * a Window button, the scrubber's Live. Keeping a second copy here would
   * leave dates showing over a globe that had stopped using them.
   */
  const [draft, setDraft] = useState<{ from: CalendarDay | null; to: CalendarDay | null }>({
    from: null,
    to: null,
  });
  const [openPicker, setOpenPicker] = useState<'from' | 'to' | null>(null);

  // Closing one calendar must not close the other. Picking a start opens the
  // end calendar and *then* the start calendar reports itself closed; written
  // as a plain "set to null", that second call shut the calendar that had
  // just been opened.
  const setPickerOpen = (which: 'from' | 'to', open: boolean) => {
    setOpenPicker((current) => (open ? which : current === which ? null : current));
  };

  const today = calendarDayOf(nowMs);
  const from = dateRange === null ? draft.from : calendarDayOf(dateRange.startMs);
  // The range's end is the midnight after its last day, hence the millisecond.
  const to = dateRange === null ? draft.to : calendarDayOf(dateRange.endMs - 1);

  const applyDays = (nextFrom: CalendarDay | null, nextTo: CalendarDay | null) => {
    const range =
      nextFrom !== null && nextTo !== null
        ? dateRangeFromDays(nextFrom, nextTo, Date.now())
        : null;
    if (range === null) {
      setDraft({ from: nextFrom, to: nextTo });
      return;
    }
    setDraft({ from: null, to: null });
    setDateRange(range);
  };

  const missingYears = useMissingArchiveYears(dateRange);

  const activeNote = COVERAGE_NOTES[minMagnitude];
  const bandCeiling = nextMagnitudeFloorAbove(minMagnitude);
  // Only the floors this span was actually ingested at. Offering more would
  // mean offering an empty globe that looks like a quiet month.
  const availableFloors =
    dateRange === null
      ? magnitudeFloorsForWindow(windowHours)
      : magnitudeFloorsForRange(dateRange, nowMs);
  const spanFloor =
    dateRange === null ? minMagnitudeForWindow(windowHours) : minMagnitudeForRange(dateRange, nowMs);
  // A long date range is held at M5.5+ by how much it would draw, not by what
  // is stored — M4.5+ is right there in the archive. Saying "not stored" for
  // it would be wrong, and would hide the way to get it: a shorter range.
  const heldByLength = dateRange !== null && spanFloor === ARCHIVE_ANALYSIS_MIN_MAGNITUDE;

  /**
   * Whether the current window reaches back past the main archive's 1970 start.
   *
   * Only the widest span does. It matters because the record changes character
   * there rather than simply ending: 1900-1970 holds the deep tier's M7.5+ and
   * nothing below it, so on a M5.5 view those seven decades render as 262 marks
   * against 26,767 after. Played back on the scrubber that reads as seismicity
   * exploding in 1970, which is the instrumental artefact this project warns
   * about everywhere else — manufactured here by the view itself.
   */
  // Via `useNow`, never a bare `Date.now()` — reading the clock during render
  // is impure, and nothing re-renders when it ticks, so the value would go
  // stale until some unrelated state change happened to refresh it.
  const reachesDeepTier =
    viewStartMs(windowHours, dateRange, nowMs) < Date.UTC(ARCHIVE_START_YEAR, 0, 1);

  return (
    <div id="range-controls" className={styles.panel}>
      <div className={styles.group}>
        <h2 className={styles.heading}>Magnitude</h2>
        <div className={styles.magnitudeGrid} role="group" aria-label="Minimum magnitude">
          {availableFloors.map((floor) => (
            <button
              key={floor}
              id={`magnitude-option-${floor}`}
              type="button"
              aria-pressed={minMagnitude === floor}
              onClick={() => setMinMagnitude(floor)}
              className={
                minMagnitude === floor
                  ? `${styles.button} ${styles.buttonActive}`
                  : styles.button
              }
            >
              {formatMagnitude(floor)}+
            </button>
          ))}
        </div>

        {/* Only offered where there is something above to hide. At the top
            floor the control would be a no-op that looks like it does something. */}
        {bandCeiling !== null && (
          <label className={styles.toggle}>
            <input
              id="isolate-band"
              type="checkbox"
              className={styles.checkbox}
              checked={isolateBand}
              onChange={(event) => setIsolateBand(event.target.checked)}
            />
            <span>
              only {formatRange(minMagnitude, true)}
            </span>
          </label>
        )}

        {activeNote && <p className={styles.note}>coverage: {activeNote}</p>}
        {/* Hiding the largest events is exactly the sort of thing that should
            never be quietly in effect — say so while it is. */}
        {isolateBand && bandCeiling !== null && (
          <p className={styles.warning}>
            hiding {formatMagnitude(bandCeiling)}+
          </p>
        )}
        {/* Say why the smaller floors vanished, or their disappearance reads as
            a bug rather than a limit of what was fetched. */}
        {spanFloor > 1 && (
          <p className={styles.note}>
            {heldByLength
              ? `${formatMagnitude(ARCHIVE_MIN_MAGNITUDE)}+ needs a range of a year or less`
              : `below ${formatMagnitude(spanFloor)}+ not stored this far back`}
          </p>
        )}
        {/* Louder than the floor note above, because this one says the record
            changes character mid-view rather than simply stopping. */}
        {reachesDeepTier && (
          <p className={styles.warning}>
            before {ARCHIVE_START_YEAR}: {formatMagnitude(DEEP_ARCHIVE_MIN_MAGNITUDE)}+ only
          </p>
        )}
      </div>

      <div className={styles.group}>
        <h2 className={styles.heading}>Window</h2>
        <div className={styles.buttonRow} role="group" aria-label="Time window">
          {COVERAGE_TIERS.map((tier) => (
            <button
              key={tier.windowHours}
              id={`window-option-${tier.windowHours}`}
              type="button"
              aria-pressed={dateRange === null && windowHours === tier.windowHours}
              onClick={() => setWindowHours(tier.windowHours)}
              className={
                // A date range can be exactly as long as a tier without being
                // that tier, so the length alone must not light the button.
                dateRange === null && windowHours === tier.windowHours
                  ? `${styles.button} ${styles.buttonActive}`
                  : styles.button
              }
            >
              {tier.label}
            </button>
          ))}
        </div>
      </div>

      {/* Its own group rather than more buttons in the row above. Crossing from
          a live tier to an archive span silently raises the magnitude floor and
          changes what the data means — that boundary should be visible. */}
      <div className={styles.group}>
        <h2 className={styles.heading}>History</h2>
        <div className={styles.buttonRow} role="group" aria-label="Archive span">
          {ARCHIVE_SPANS.map((span) => {
            const spanHours = archiveSpanHours(span);
            return (
              <button
                key={span.label}
                id={`archive-span-${span.label}`}
                type="button"
                aria-pressed={dateRange === null && windowHours === spanHours}
                // Toggles: clicking the active span returns to the live view
                // you came from, rather than being a one-way door.
                onClick={() => toggleArchiveSpan(spanHours)}
                className={
                  dateRange === null && windowHours === spanHours
                    ? `${styles.button} ${styles.buttonActive}`
                    : styles.button
                }
              >
                {span.label}
              </button>
            );
          })}
        </div>

        {/* A range between two picked days, beside the spans because it is the
            same kind of thing: a way into the archive that raises the floor
            and that you step back out of. The spans all end today; this is
            for a span that does not. */}
        <div className={styles.dates}>
          <DatePicker
            id="date-range-from"
            label="From"
            value={from}
            hint={to}
            min={FIRST_DAY}
            max={today}
            active={dateRange !== null}
            open={openPicker === 'from'}
            onOpenChange={(open) => {
              setPickerOpen('from', open);
            }}
            onChange={(day) => {
              const next = withFrom(day, to);
              applyDays(next.from, next.to);
              // Straight on to the end date while there is none: a start by
              // itself shows nothing, and the end is usually close by.
              if (next.to === null) setOpenPicker('to');
            }}
          />
          <DatePicker
            id="date-range-to"
            label="To"
            value={to}
            hint={from}
            // Not before the start. Moving a range earlier therefore begins
            // with its start, which is the natural order anyway.
            min={from ?? FIRST_DAY}
            max={today}
            active={dateRange !== null}
            open={openPicker === 'to'}
            onOpenChange={(open) => {
              setPickerOpen('to', open);
            }}
            onChange={(day) => {
              applyDays(from, day);
              if (from === null) setOpenPicker('from');
            }}
          />
          {(from !== null || to !== null) && (
            <button
              type="button"
              id="date-range-clear"
              className={styles.clear}
              onClick={() => {
                setDraft({ from: null, to: null });
                setOpenPicker(null);
                clearDateRange();
              }}
            >
              {dateRange === null ? 'clear' : 'clear dates · back to live'}
            </button>
          )}
        </div>
        {dateRange === null && (from !== null) !== (to !== null) && (
          <p className={styles.note}>
            pick {from === null ? 'a start' : 'an end'} date to show the range
          </p>
        )}
        {/* Without this an undownloaded year is an empty globe, which reads as
            a quiet year. */}
        {missingYears.length > 0 && (
          <p className={styles.warning}>
            {formatYearRanges(missingYears)} not downloaded — see the archive below
          </p>
        )}

        {/* Only where there's a shorter span to trail by. At the bottom of the
            ladder this would be a checkbox that does nothing — the same reason
            the isolate-band control disappears at the top floor. */}
        {trailHours !== null && (
          <label className={styles.toggle}>
            <input
              id="trailing-window"
              type="checkbox"
              className={styles.checkbox}
              checked={trailingWindow}
              onChange={(event) => setTrailingWindow(event.target.checked)}
            />
            <span>only last {formatWindowLabel(trailHours)} before playhead</span>
          </label>
        )}
        {trailingWindow && trailHours !== null && (
          <p className={styles.warning}>showing {formatWindowLabel(trailHours)} of the span</p>
        )}
      </div>
    </div>
  );
}
