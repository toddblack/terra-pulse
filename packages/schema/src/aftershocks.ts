/**
 * Observed aftershock sequences — PROJECT_PLAN §5.9, the Explore-safe half.
 *
 * §5.9 splits the inspector two ways. For a live event the interesting thing is
 * the *forecast*, which is model output and belongs in Analyze. For an archive
 * event a forecast is meaningless — 1985 already happened — but what actually
 * followed is real data, and that is what this module describes.
 *
 * Everything here is **observation**: a count of events that occurred, inside a
 * window whose size was fixed by a 1974 paper rather than by anything anyone
 * saw in this catalogue. No rate is fitted, nothing is extrapolated, and no
 * significance is claimed. That is what keeps it out of Analyze and clear of
 * non-negotiable #1.
 *
 * ## Why Gardner-Knopoff sets the window
 *
 * The window has to come from somewhere, and "somewhere" must not be a number
 * picked after looking at a sequence — non-negotiable #3. Gardner & Knopoff
 * (1974) is already this project's declared declustering standard
 * (non-negotiable #2), so reusing its windows here means the events this panel
 * calls aftershocks are exactly the events Phase 4 will later remove as
 * dependent. One definition, two consumers, no drift.
 */
import type { BoundingBox, EarthquakeEvent } from './earthquake';
import { ARCHIVE_MIN_MAGNITUDE } from './archive';

/**
 * The smallest mainshock offered a sequence panel.
 *
 * §5.9's own threshold. Below M5 the Gardner-Knopoff window shrinks to ~40 km
 * and the catalogue floor is M4.5, so the honest answer is almost always
 * "nothing recorded" — which reads as a finding rather than as the floor doing
 * its job. A panel that says zero for structural reasons is worse than no
 * panel.
 */
export const SEQUENCE_MIN_MAINSHOCK_MAGNITUDE = 5;

/**
 * The floor the sequence is counted at, and it is deliberately **not** the
 * floor on screen.
 *
 * M4.5 is the one level available uniformly across the entire database: the
 * archive's own floor from 1970 on, and comfortably above the rolling cache's
 * M1/M2.5. Counting at the *view's* floor would make "12 aftershocks" mean
 * something different in the 30-day view than in the all-years view, and make a
 * 1985 sequence incomparable with a 2026 one — which is the single question
 * this panel exists to answer.
 *
 * The cost is that it disagrees with the globe: a recent M5.2 may show forty
 * small dots around it and report three aftershocks. The panel therefore always
 * prints the floor next to the count rather than leaving the reader to discover
 * the discrepancy.
 */
export const SEQUENCE_MIN_MAGNITUDE = ARCHIVE_MIN_MAGNITUDE;

/**
 * Gardner-Knopoff (1974) spatial window, in km, for a mainshock of magnitude M.
 *
 * The analytic fit to GK's Table 1 in general use since Uhrhammer (1986); see
 * van Stiphout, Zhuang & Marsan (2012) for the form. Checked against the
 * published table before use — M6.0 gives 53.2 km against 54 tabulated, M7.0
 * gives 70.7 against 70 — so this is the paper's window, not a lookalike.
 */
export function gardnerKnopoffRadiusKm(magnitude: number): number {
  return 10 ** (0.1238 * magnitude + 0.983);
}

/**
 * Gardner-Knopoff (1974) temporal window, in days.
 *
 * Two branches, and the split at M6.5 is in the source rather than a smoothing
 * convenience: the window saturates near 1,000 days for the largest events
 * instead of continuing to grow. Checked against Table 1 — M7.0 gives 918 days
 * against 915, M8.0 gives 988 against 985.
 *
 * **The fit is not monotonic across the branch point, and that is left alone.**
 * Measured: the lower branch reaches 930.8 days approaching M6.5 and the upper
 * branch starts at 884.9, so an M6.5 gets a window 45.8 days (4.9%) *shorter*
 * than an M6.4 — backwards, physically. It is a known property of the published
 * piecewise form, not a transcription error here, and the alternatives are both
 * worse:
 *
 * - Taking the larger branch everywhere restores monotonicity and then explodes:
 *   the lower branch extrapolates to 1,735 days at M7 (table says 915) and
 *   **20,946 days at M9** — 57 years, which would claim the entire archive as
 *   one sequence. The branch switch exists precisely to cap that.
 * - Interpolating across the seam would mean inventing a coefficient no paper
 *   published, which is the free parameter non-negotiable #3 forbids.
 *
 * Neither branch is especially good right at M6.5 anyway (the table says 790;
 * they give 931 and 885), so a 5% step inside that error band changes nothing a
 * descriptive panel reports. Pinned by a test so it stays a known quantity.
 *
 * The consequence worth knowing: an M9 window is ~1,070 days, so a sequence
 * from the last three years is still *running*. `summariseSequence` reports how
 * much of the window has elapsed for exactly this reason.
 */
export function gardnerKnopoffWindowDays(magnitude: number): number {
  return magnitude >= 6.5
    ? 10 ** (0.032 * magnitude + 2.7389)
    : 10 ** (0.5409 * magnitude - 0.547);
}

/** Great-circle distance in km. Earth as a sphere is ample at these scales. */
export function haversineKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const earthRadiusKm = 6371;
  const toRad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * toRad;
  const dLon = (b.longitude - a.longitude) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * toRad) * Math.cos(b.latitude * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * R-Tree search boxes covering a circle of `radiusKm` around a point.
 *
 * Returns **one or two** boxes, and the two-box case is not an edge case worth
 * skipping: a 130 km circle spans about 4° of longitude at the equator and far
 * more at high latitude, and Kamchatka, the Aleutians and Fiji all straddle
 * ±180°. A single box there would come out with `minLon` greater than `maxLon`,
 * which SQLite answers with zero rows — an M8 in the Kurils would report no
 * aftershocks at all, and report it in the same confident voice as a real zero.
 *
 * The boxes are a deliberate **superset** of the circle: this is the index
 * narrowing step, and the caller still measures true great-circle distance with
 * `haversineKm`. Two consequences follow from that, both intended:
 *
 * - Longitude degrees are sized using whichever edge of the box is nearer the
 *   pole, where they are shortest in km and so most numerous per km. Sizing on
 *   the centre latitude would make the box too narrow at its far edge and clip
 *   real events.
 * - Near the poles the longitude span is simply the whole world. Past about
 *   89.5° the scaling diverges, and a full-longitude box costs nothing at those
 *   latitudes because almost no events are there.
 */
export function sequenceSearchBoxes(
  center: { latitude: number; longitude: number },
  radiusKm: number,
): BoundingBox[] {
  const KM_PER_DEGREE_LAT = 111.32;
  const latDelta = radiusKm / KM_PER_DEGREE_LAT;
  const minLat = Math.max(-90, center.latitude - latDelta);
  const maxLat = Math.min(90, center.latitude + latDelta);

  // The box edge closest to a pole is where a degree of longitude is shortest,
  // so it needs the most degrees to cover the radius.
  const extremeLat = Math.max(Math.abs(minLat), Math.abs(maxLat));
  const cosLat = Math.cos((extremeLat * Math.PI) / 180);
  const lonDelta = cosLat < 0.01 ? 180 : radiusKm / (KM_PER_DEGREE_LAT * cosLat);

  if (lonDelta >= 180) return [{ minLon: -180, maxLon: 180, minLat, maxLat }];

  const minLon = center.longitude - lonDelta;
  const maxLon = center.longitude + lonDelta;

  // Split rather than wrap. An R-Tree range query is a pair of comparisons, so
  // a box from 178 to 182 matches nothing — the events on the far side are
  // stored at -179, not 181.
  if (minLon < -180) {
    return [
      { minLon: -180, maxLon, minLat, maxLat },
      { minLon: minLon + 360, maxLon: 180, minLat, maxLat },
    ];
  }
  if (maxLon > 180) {
    return [
      { minLon, maxLon: 180, minLat, maxLat },
      { minLon: -180, maxLon: maxLon - 360, minLat, maxLat },
    ];
  }
  return [{ minLon, maxLon, minLat, maxLat }];
}

/**
 * Time bins for the decay strip, as hours since the mainshock.
 *
 * Log-spaced, because Omori decay is: roughly half a sequence lands on the
 * first day and the rest spreads over months, so linear bins would be one full
 * bar followed by four empty ones. Five bins is what fits legibly across a
 * 19rem panel.
 */
export const SEQUENCE_BINS: readonly { label: string; fromHours: number; toHours: number }[] = [
  { label: '<1d', fromHours: 0, toHours: 24 },
  { label: '1-7d', fromHours: 24, toHours: 24 * 7 },
  { label: '1-4w', fromHours: 24 * 7, toHours: 24 * 30 },
  { label: '1-6mo', fromHours: 24 * 30, toHours: 24 * 180 },
  { label: '6mo+', fromHours: 24 * 180, toHours: Number.POSITIVE_INFINITY },
];

export interface SequenceBin {
  label: string;
  count: number;
  /**
   * Days of this bin that have actually happened — bounded by the
   * Gardner-Knopoff window and by now, whichever comes first.
   */
  observedDays: number;
  /**
   * Events per day, or **null** where none of the bin has elapsed yet.
   *
   * ## Why the strip plots this and not `count`
   *
   * The bins are log-spaced, so they are wildly unequal in width: the first is
   * one day and the last runs to the end of the window — about 890 days for an
   * M9. Plotting raw counts across them shows the *width of the bins*, not the
   * behaviour of the sequence, and it gets the direction backwards. Measured on
   * the real catalogue, Tohoku's counts are [182, 236, 204, 223, 289] and
   * Sumatra's are [5, 17, 19, 147, 139] — both read as "aftershocks become more
   * frequent over time", which is the exact opposite of what happened.
   *
   * As a rate the same data is [182, 39.3, 8.9, 1.5, 0.32] per day: Omori decay,
   * plainly. Same observation, divided by the time it was observed over.
   *
   * This is still pure description — a count over an interval, with no rate
   * fitted, no curve drawn through it and no parameter estimated. The
   * Reasenberg-Jones fit that *would* be model output stays in Analyze (§5.9).
   *
   * Null rather than zero when nothing has elapsed, because "no aftershocks in
   * the second year" and "the second year hasn't happened" are different facts
   * and a zero-height bar would state the first.
   */
  perDay: number | null;
}

/**
 * What followed a mainshock, as observed.
 *
 * `count` is always "events at or above `minMagnitude` inside the window", never
 * a corrected or estimated total.
 */
export interface SequenceSummary {
  radiusKm: number;
  windowDays: number;
  minMagnitude: number;
  count: number;
  /** The biggest event in the window, or null if nothing qualified. */
  largest: EarthquakeEvent | null;
  /** Hours from the mainshock to `largest`. Null when there is no largest. */
  largestAfterHours: number | null;
  /**
   * True when something in the window was **bigger than the mainshock** — i.e.
   * the selected event was a foreshock and the sequence's real mainshock came
   * later.
   *
   * Surfaced prominently because the panel is otherwise silently wrong about
   * its own subject: Gardner-Knopoff treats the largest event of a cluster as
   * the mainshock, so when this is true the window itself is the wrong shape,
   * being sized to a smaller magnitude than the sequence deserved.
   */
  exceededMainshock: boolean;
  /**
   * How much of the Gardner-Knopoff window has actually passed, 0 to 1.
   *
   * Below 1 the sequence is still developing and the count is a running total,
   * not a final one. Without this the panel would report a partial count for a
   * recent event in exactly the same voice it uses for a settled 1985 sequence.
   */
  elapsedFraction: number;
  bins: readonly SequenceBin[];
}

/**
 * What followed a mainshock, plus an honest account of what the database could
 * actually see.
 *
 * Lives here rather than in `@terra-pulse/db` for the same reason
 * `EarthquakeQuery` does: the renderer displays this and type-checks with no
 * Node types at all, so its shape must not sit in a package that pulls in
 * `node:sqlite`.
 *
 * The two halves are separate on purpose. A count of zero is a real and common
 * answer — most M5s are followed by nothing at M4.5+ — but it is also what an
 * undownloaded archive returns, and those must not look alike.
 */
export interface AftershockSequence {
  summary: SequenceSummary;
  /**
   * Years the elapsed window touches that the archive has not downloaded.
   *
   * Empty means the count is a total. Non-empty means it is a **lower bound**,
   * and the panel says so rather than printing a number that looks complete.
   */
  missingYears: number[];
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Summarises an already-filtered set of aftershocks.
 *
 * Pure, and deliberately separated from the query: the spatial-temporal
 * selection is the database's job, and everything the panel displays can then
 * be tested without a database at all.
 *
 * `events` must already be restricted to the window — this does not re-filter,
 * because doing so would put the window definition in two places and let them
 * disagree. It does sort, so callers need not.
 */
export function summariseSequence(
  mainshock: Pick<EarthquakeEvent, 'magnitude' | 'timeUtc'>,
  events: readonly EarthquakeEvent[],
  nowMs: number,
): SequenceSummary {
  const radiusKm = gardnerKnopoffRadiusKm(mainshock.magnitude);
  const windowDays = gardnerKnopoffWindowDays(mainshock.magnitude);
  const originMs = Date.parse(mainshock.timeUtc);

  const counts = SEQUENCE_BINS.map(() => 0);

  // Sorted here rather than required of the caller. The tie-break below is
  // order-dependent, and "pass me these in time order" is precisely the kind of
  // precondition that holds until some later caller doesn't know about it.
  const inTimeOrder = [...events].sort((a, b) => a.timeUtc.localeCompare(b.timeUtc));

  let largest: EarthquakeEvent | null = null;
  for (const event of inTimeOrder) {
    // Ties go to the earlier event: with two M6.2s in a sequence, the first is
    // the one that started it. `>` rather than `>=` gives that, given the sort
    // above.
    if (largest === null || event.magnitude > largest.magnitude) largest = event;

    const afterHours = (Date.parse(event.timeUtc) - originMs) / HOUR_MS;
    const index = SEQUENCE_BINS.findIndex((bin) => afterHours < bin.toHours);
    // The last bin is Infinity, so a real timestamp always matches. The guard
    // is for an unparseable one: that yields NaN, which compares false against
    // every bound, and would otherwise write to counts[-1] and vanish.
    if (index >= 0) counts[index] = (counts[index] ?? 0) + 1;
  }

  const elapsedMs = nowMs - originMs;
  const windowMs = windowDays * 24 * HOUR_MS;

  // A bin is observable only as far as both the window and the present reach.
  // Taking the window into account matters for the open-ended last bin, whose
  // real end is the window's; taking `now` into account is what stops a
  // three-day-old M8 reporting a rate over a period that hasn't happened.
  const observableHours = Math.max(0, Math.min(windowMs, elapsedMs)) / HOUR_MS;

  const bins: SequenceBin[] = SEQUENCE_BINS.map((bin, index) => {
    const endHours = Math.min(bin.toHours, observableHours);
    const observedDays = Math.max(0, endHours - bin.fromHours) / 24;
    const count = counts[index] ?? 0;
    return {
      label: bin.label,
      count,
      observedDays,
      perDay: observedDays > 0 ? count / observedDays : null,
    };
  });

  return {
    radiusKm,
    windowDays,
    minMagnitude: SEQUENCE_MIN_MAGNITUDE,
    count: events.length,
    largest,
    largestAfterHours:
      largest === null ? null : (Date.parse(largest.timeUtc) - originMs) / HOUR_MS,
    exceededMainshock: largest !== null && largest.magnitude > mainshock.magnitude,
    elapsedFraction: Math.max(0, Math.min(1, elapsedMs / windowMs)),
    bins,
  };
}
