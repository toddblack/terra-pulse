/**
 * The historical archive — Tier 1 in PROJECT_PLAN §Storage.
 *
 * A one-time, user-triggered backfill of the global catalogue, distinct from
 * the rolling cache that `COVERAGE_TIERS` drives. The rolling cache answers
 * "what happened lately" and refills itself; this answers "where do large
 * earthquakes happen, and how long between them", and is expensive enough that
 * losing it matters.
 */

/**
 * The archive's magnitude floor.
 *
 * M4.5 is where global completeness begins — below it the catalogue is patchy
 * outside well-instrumented regions and a global count means something closer
 * to "where the seismometers are".
 *
 * **This is the browsing floor, not the analysis floor.** M4.5+ counts rose ~3×
 * since 1970 from network growth alone, so any rate, trend or recurrence
 * interval computed on M4.5+ would drift for purely instrumental reasons.
 * Anything making a claim about how often something happens must filter to
 * `ARCHIVE_ANALYSIS_MIN_MAGNITUDE`.
 */
export const ARCHIVE_MIN_MAGNITUDE = 4.5;

/**
 * The floor anything rate-like has to use: the only one whose global count has
 * stayed flat since 1970 (~12% spread per decade, against 3× for M4.5+).
 *
 * Measured totals for 1970–2026: 294,648 events at M4.5+, 26,746 at M5.5+.
 */
export const ARCHIVE_ANALYSIS_MIN_MAGNITUDE = 5.5;

/**
 * Where the archive starts.
 *
 * 1970 because that is where the M5.5+ record goes flat — earlier data exists
 * but the network was changing fast enough that it would contaminate exactly
 * the recurrence-interval questions the archive is for. A later start would
 * throw away real signal for no reason.
 */
export const ARCHIVE_START_YEAR = 1970;

/**
 * FDSN returns at most this many events per request, so every chunk has to be
 * fetched in pages of no more than this.
 *
 * Measured: the busiest year at M4.5+ is 2011, at 9,584 events — comfortably
 * inside one page, so in practice a year-sized chunk is a single request. The
 * paging path still exists because "in practice" is not "always", and a future
 * lower floor would blow straight past it.
 */
export const FDSN_MAX_PAGE_SIZE = 20_000;

/**
 * One unit of backfill: a half-open time range `[startUtc, endUtc)`.
 *
 * **Boundaries are calendar years, and that is load-bearing.** Resume works by
 * recording which chunks finished, so the chunk plan has to come out identical
 * on every run. Anything adaptive — splitting on observed density, sizing from
 * a live count — would shift boundaries between runs and turn a resumed
 * backfill into a partial one with no way to notice.
 */
export interface ArchiveChunk {
  startUtc: string;
  endUtc: string;
  /** The calendar year this chunk covers, and its stable identity. */
  year: number;
}

/**
 * Every chunk the archive is made of, oldest first.
 *
 * Oldest first so a partial archive is a contiguous span from 1970 rather than
 * scattered years — the sparse early decades are also the cheapest, so the run
 * front-loads its cheapest work, and an interrupted backfill leaves something
 * coherent to look at.
 */
export function archiveChunks(throughYear: number): ArchiveChunk[] {
  const chunks: ArchiveChunk[] = [];

  for (let year = ARCHIVE_START_YEAR; year <= throughYear; year++) {
    chunks.push({
      year,
      startUtc: `${String(year)}-01-01T00:00:00.000Z`,
      // Half-open: this is the next year's start, not 23:59:59 of this one.
      // FDSN's endtime is inclusive, so an event at exactly midnight would be
      // fetched by both neighbours — harmless (the upsert absorbs it) but it
      // would make the per-chunk counts disagree with the catalogue total.
      endUtc: `${String(year + 1)}-01-01T00:00:00.000Z`,
    });
  }

  return chunks;
}

/**
 * The spans the UI offers for browsing the archive — **read by the renderer
 * only.**
 *
 * ## Why these are not in `COVERAGE_TIERS`
 *
 * That constant is shared with main, which loops it to decide what to fetch on
 * every launch. A 57-year entry there would make the app try to re-download the
 * whole archive on every start. These are *view* spans over data already on
 * disk; they must never reach `ingestPasses`.
 *
 * ## Why each span carries a floor
 *
 * Every view is sized to the same mark budget — roughly what the shipped
 * 30d/M2.5 view already draws (~7,671 marks, measured). Longer spans therefore
 * demand higher floors, and the existing floor-auto-raise in `setWindowHours`
 * enforces it with no new mechanism.
 *
 * Measured entity build cost against the real layer:
 *
 *   1y  / M4.5 →  8,485 marks · 161 ms
 *   10y / M5.5 →  4,604 marks · ~120 ms
 *   all / M5.5 → 26,746 marks · 590 ms
 *
 * And the combinations deliberately *not* offered, which is the point:
 *
 *   5y  / M4.5 → 38,538 marks · 827 ms
 *   all / M4.5 → 294,648 marks · **V8 out-of-memory, process dies**
 *
 * So the M4.5–5.5 band is capped at one year. Above M5.5 the whole record is
 * cheap enough to browse, and raising the floor from there is free: M6 over all
 * years is 7,907 marks, M7 is 781.
 */
export interface ArchiveSpan {
  /** Length of the window, in years. */
  years: number;
  /** The lowest magnitude this span may be drawn at. */
  minMagnitude: number;
  label: string;
}

export const ARCHIVE_SPANS: readonly ArchiveSpan[] = [
  { years: 1, minMagnitude: ARCHIVE_MIN_MAGNITUDE, label: '1y' },
  { years: 10, minMagnitude: ARCHIVE_ANALYSIS_MIN_MAGNITUDE, label: '10y' },
  // "All" is expressed in years like the others rather than as a sentinel, so
  // every consumer does the same arithmetic. Comfortably past 1970 so it keeps
  // covering the whole archive as years pass.
  { years: 100, minMagnitude: ARCHIVE_ANALYSIS_MIN_MAGNITUDE, label: 'all' },
];

const HOURS_PER_YEAR = 365.25 * 24;

/** An archive span as window-hours, the unit the store and layers already use. */
export function archiveSpanHours(span: ArchiveSpan): number {
  return Math.round(span.years * HOURS_PER_YEAR);
}

/** The archive span for a window length, or `undefined` if it's a live tier. */
export function archiveSpanForHours(windowHours: number): ArchiveSpan | undefined {
  return ARCHIVE_SPANS.find((span) => archiveSpanHours(span) === windowHours);
}

/** What the archive backfill is currently doing, as the renderer sees it. */
export interface ArchiveProgress {
  state: 'idle' | 'running' | 'complete' | 'failed' | 'cancelled';
  /** Chunks recorded complete, including ones finished on an earlier run. */
  completedChunks: number;
  totalChunks: number;
  /** Events stored so far, summed over completed chunks. */
  storedEvents: number;
  /** The year currently being fetched, if any. */
  currentYear: number | null;
  /** Present when `state` is 'failed'. */
  error: string | null;
}
