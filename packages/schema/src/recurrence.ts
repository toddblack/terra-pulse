/**
 * Observed recurrence intervals — how long between independent large
 * earthquakes in a region, as the instrumental catalogue actually recorded it.
 *
 * ## What this is not
 *
 * It is **not** the number people mean by "the southern San Andreas is overdue".
 * That figure comes from paleoseismology — trenching a fault and dating offset
 * layers to read off ruptures across millennia. This archive reaches 1970 at
 * moderate magnitudes and 1900 at M7.5+ — 57 and 126 years. You cannot measure a
 * 200-year recurrence from either, and nothing here tries: the panel reports
 * intervals it observed and never extrapolates to the next one. See
 * PROJECT_PLAN §5.10 for the full split between the two.
 *
 * What it *can* answer honestly is "how often has this happened here since the
 * catalogue became complete at this size", which is a real and, at moderate
 * magnitudes, well-sampled question.
 *
 * ## Declustering is mandatory, not a refinement
 *
 * A recurrence interval is a rate claim, and non-negotiable #2 requires
 * declustering before any of those. Raw catalogues are dominated by aftershock
 * sequences: measured near Tokyo at M6+, the raw median gap is 0.06 years and
 * the declustered one is 0.32 — five times longer. The raw number is not a
 * noisier version of the right answer, it is an answer to a different question
 * ("how often does the ground shake") dressed as this one.
 */
import type { EarthquakeEvent } from './earthquake';
import { gardnerKnopoffRadiusKm, gardnerKnopoffWindowDays, haversineKm } from './aftershocks';
import { completeSinceYear } from './archive';

/**
 * The floor any rate claim has to use.
 *
 * M5.5 is the only level whose global count has stayed flat since 1970 — M4.5+
 * rose roughly 3× on network growth alone. A recurrence interval computed on
 * M4.5+ would shorten steadily through the record for purely instrumental
 * reasons, and would look exactly like a real increase in seismicity.
 */
export const RECURRENCE_MIN_MAGNITUDE = 5.5;

/**
 * Magnitude floors offered, and every one is at or above the flat-since-1970
 * level above. These are *not* `MAGNITUDE_FLOORS` — that ladder starts at M1
 * for display, and none of those lower steps may carry a rate.
 *
 * M7.5 reaches furthest back: it is the one floor complete from 1900 rather than
 * 1970, so it draws on a 126-year record against everything else's 57. See
 * `recurrenceEpochYear`.
 */
export const RECURRENCE_FLOORS: readonly number[] = [5.5, 6, 6.5, 7, 7.5];

/** Search radii offered, km. */
export const RECURRENCE_RADII_KM: readonly number[] = [100, 200, 300, 500];

/**
 * Defaults, chosen by how much data the catalogue actually holds rather than by
 * what any particular region produces.
 *
 * Measured independent-event counts at 300 km: M5.5+ gives 15–218 across
 * seismic regions, M6+ gives 8–64, M6.5+ drops to 2–27 and M7+ to 1–8. So 300 km
 * at M6 is the widest combination that stays adequately sampled almost
 * everywhere while still describing a region rather than a continent — 100 km
 * leaves Tokyo with 7 events at M6+, and 500 km starts spanning distinct
 * tectonic settings.
 */
export const DEFAULT_RECURRENCE_RADIUS_KM = 300;
export const DEFAULT_RECURRENCE_FLOOR = 6;

/**
 * Fewest intervals before a median is worth printing.
 *
 * Below this the summary statistic is unstable enough to mislead: Kathmandu at
 * M7+ yields two intervals whose mean is 4.85 years and whose median is 9.66 —
 * both "true", neither meaningful. The panel shows the raw gaps instead, which
 * are honest at any count.
 *
 * Eight is a judgement, not a derivation, and it is fixed here rather than
 * chosen per region so the same rule applies to every query.
 */
export const MIN_INTERVALS_FOR_SUMMARY = 8;

/**
 * The year a rate at this floor can honestly start from.
 *
 * **Not a constant, because completeness is not uniform across magnitude.**
 * M7.5+ is globally complete from 1900; everything below only from 1970. Using
 * a single 1970 epoch would throw away 70 years of large-event history, and
 * using a single 1900 epoch would count seven near-empty decades as observation
 * at M6 and inflate every interval through them.
 */
export function recurrenceEpochYear(minMagnitude: number): number {
  return completeSinceYear(minMagnitude);
}

/**
 * Gardner & Knopoff (1974) declustering: keeps one independent event per
 * cluster, drops its dependents.
 *
 * Walks events **largest first**, which is what makes the result independent of
 * the order they arrive in. Each surviving event claims everything inside its
 * own space-time window as dependent, and a claimed event can neither survive
 * nor claim others.
 *
 * Two details worth stating:
 *
 * - The window is sized by the *claiming* event's magnitude, so a big shock
 *   sweeps up a wide, long tail while an M5.5 barely reaches past a month.
 * - Only events **after** the mainshock are removed. Gardner-Knopoff also
 *   defines a foreshock window, but removing earlier events would let a late
 *   large shock erase independent history that preceded it — and for a
 *   *recurrence* count, deleting earlier events is the one error that directly
 *   inflates the interval being measured.
 *
 * O(n²) in the worst case. Measured against the real catalogue that is a few
 * milliseconds at the counts this panel deals with (hundreds, not thousands).
 */
export function declusterGardnerKnopoff(events: readonly EarthquakeEvent[]): EarthquakeEvent[] {
  const largestFirst = [...events].sort((a, b) => b.magnitude - a.magnitude);
  const dependent = new Set<string>();
  const independentIds = new Set<string>();
  const independent: EarthquakeEvent[] = [];

  for (const candidate of largestFirst) {
    if (dependent.has(candidate.id)) continue;
    independent.push(candidate);
    independentIds.add(candidate.id);

    const radiusKm = gardnerKnopoffRadiusKm(candidate.magnitude);
    const windowMs = gardnerKnopoffWindowDays(candidate.magnitude) * 24 * 60 * 60 * 1000;
    const originMs = Date.parse(candidate.timeUtc);
    if (!Number.isFinite(originMs)) continue;

    for (const other of events) {
      if (other.id === candidate.id || dependent.has(other.id)) continue;
      // An event already designated independent cannot later be demoted. Without
      // this, a small early shock whose window happens to reach a much larger
      // later one would "claim" it after the fact — the sweep is largest-first
      // precisely so the big event decides, and this is what makes that hold
      // rather than depend on which candidate happened to run first.
      if (independentIds.has(other.id)) continue;
      const deltaMs = Date.parse(other.timeUtc) - originMs;
      if (!Number.isFinite(deltaMs)) continue;
      if (deltaMs <= 0 || deltaMs > windowMs) continue;
      if (haversineKm(candidate, other) <= radiusKm) dependent.add(other.id);
    }
  }

  return independent.sort((a, b) => a.timeUtc.localeCompare(b.timeUtc));
}

export interface RecurrenceSummary {
  radiusKm: number;
  minMagnitude: number;
  /** Events found before declustering — the difference is the point. */
  rawCount: number;
  /** Independent events after Gardner-Knopoff. */
  independentCount: number;
  /** Years between consecutive independent events, ascending. */
  intervalsYears: number[];
  /**
   * Median interval, or **null** when there are too few to be meaningful.
   *
   * Null is a deliberate refusal rather than a missing value — see
   * `MIN_INTERVALS_FOR_SUMMARY`. The caller shows the raw intervals instead.
   */
  medianYears: number | null;
  shortestYears: number | null;
  longestYears: number | null;
  /** Years since the most recent independent event, or null if there are none. */
  sinceLastYears: number | null;
  /** Span the catalogue actually covers here, for stating the denominator. */
  observedYears: number;
  /** The year this rate starts from — 1900 at M7.5+, otherwise 1970. */
  epochYear: number;
}

/**
 * A region's recurrence result, as the renderer receives it.
 *
 * Lives here rather than in `@terra-pulse/db` for the same reason
 * `AftershockSequence` does: the panel that displays it type-checks with no Node
 * types at all, so its shape must not sit in a package that pulls in
 * `node:sqlite`.
 */
export interface RegionalRecurrence {
  summary: RecurrenceSummary;
  /**
   * The independent events, newest first — so the panel can show which
   * earthquakes bracket a gap rather than only the statistics.
   */
  independent: EarthquakeEvent[];
  /**
   * Whether the archive covers all of 1970-to-now at this floor.
   *
   * False means no summary is trustworthy: a hole in the record merges two real
   * gaps into one longer false one, an error that always points toward "rarer
   * than it is".
   */
  archiveComplete: boolean;
}

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Summarises intervals between already-declustered events.
 *
 * `events` must already be filtered to the region and floor and declustered —
 * this does not re-filter, so the definition of "independent" lives in exactly
 * one place.
 */
export function summariseRecurrence(
  independent: readonly EarthquakeEvent[],
  options: { radiusKm: number; minMagnitude: number; rawCount: number; nowMs: number },
): RecurrenceSummary {
  const inTimeOrder = [...independent].sort((a, b) => a.timeUtc.localeCompare(b.timeUtc));

  const intervalsYears: number[] = [];
  for (let i = 1; i < inTimeOrder.length; i += 1) {
    const previous = Date.parse(inTimeOrder[i - 1]?.timeUtc ?? '');
    const current = Date.parse(inTimeOrder[i]?.timeUtc ?? '');
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue;
    intervalsYears.push((current - previous) / MS_PER_YEAR);
  }
  intervalsYears.sort((a, b) => a - b);

  const enough = intervalsYears.length >= MIN_INTERVALS_FOR_SUMMARY;
  const last = inTimeOrder[inTimeOrder.length - 1];
  const lastMs = last ? Date.parse(last.timeUtc) : Number.NaN;

  const epochMs = Date.UTC(recurrenceEpochYear(options.minMagnitude), 0, 1);

  return {
    radiusKm: options.radiusKm,
    minMagnitude: options.minMagnitude,
    rawCount: options.rawCount,
    independentCount: inTimeOrder.length,
    intervalsYears,
    // Median only past the threshold; the extremes are facts at any count, so
    // they are reported whenever an interval exists at all.
    medianYears: enough ? (intervalsYears[intervalsYears.length >> 1] ?? null) : null,
    shortestYears: intervalsYears[0] ?? null,
    longestYears: intervalsYears[intervalsYears.length - 1] ?? null,
    sinceLastYears: Number.isFinite(lastMs) ? (options.nowMs - lastMs) / MS_PER_YEAR : null,
    observedYears: Math.max(0, (options.nowMs - epochMs) / MS_PER_YEAR),
    epochYear: recurrenceEpochYear(options.minMagnitude),
  };
}
