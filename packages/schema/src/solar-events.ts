/**
 * Solar flares and CME arrivals — NASA's DONKI catalogue.
 *
 * The emission side of space weather. Everything else this app ingests is
 * measured at or near Earth; these are events *on the Sun*, plus a model's
 * estimate of when a coronal mass ejection reaches us.
 */

/**
 * Where **DONKI's** flare record becomes usable — not where the flare record
 * as a whole begins.
 *
 * DONKI returns flares from 2010, but its early coverage is badly incomplete.
 * Measured against NOAA's GOES XRS reports, the standard independent catalogue,
 * counting M and X class flares per year:
 *
 * | year | GOES | DONKI | DONKI captures |
 * |---|---|---|---|
 * | 2011 | 119 | 30 | **25%** |
 * | 2012 | 130 | 30 | **23%** |
 * | 2013 | 111 | 28 | **25%** |
 * | **2014** | 221 | 215 | **97%** |
 * | 2015 | 106 | 127 | 120% |
 * | 2016 | 16 | 16 | 100% |
 *
 * **The deeper record is GOES, not DONKI.** GOES XRS yearly reports run 1975 to
 * 2016 and then stop; DONKI is complete from 2014. They overlap for three years
 * at 97-100% agreement, so the two can be joined with the join *validated*
 * rather than assumed — giving fifty years rather than twelve.
 *
 * H1 registers GOES as its source, which turned out to be both correct and the
 * better choice. This constant governs only the DONKI half.
 *
 * **The 2015 disagreement was real and is now explained.** DONKI reports *more*
 * M/X flares than GOES that year, with no duplicates — 127 records, 127 unique
 * ids, 127 unique peak times, one catalogue. The guess recorded here was that
 * GOES's 2015 report is partial across a satellite transition, and **that turned
 * out to be right**: NOAA publishes a corrected file for that year alone,
 * `goes-xrs-report_2015_modifiedreplacedmissingrows.txt`, carrying **119 M/X
 * against the standard file's 106**. The ingest takes the corrected file — see
 * `GOES_FLARE_YEAR_FILENAMES` in `packages/ingest/src/goes-flares.ts`. The
 * residual 119-vs-127 gap is the ordinary margin between two good catalogues,
 * and any flare count still carries it.
 */
export const FLARE_COMPLETE_SINCE_YEAR = 2014;

/** DONKI's earliest flare record, incomplete though it is. */
export const DONKI_START_YEAR = 2010;

/**
 * The first full year of the GOES XRS flare record.
 *
 * GOES-1 launched in October 1975, so 1975 itself is a partial year — its report
 * lists two M/X flares against 405 in 1980. The yearly reports end at **2016**,
 * after which DONKI takes over.
 *
 * Detection is **not uniform across this span**: GOES instruments changed
 * repeatedly and pre-1996 fluxes are known to need a scaling correction, so
 * whether "M1.0" means the same thing in 1980 and 2010 has not been verified
 * here. That is the same class of problem as M4.5 earthquake completeness and it
 * must be settled before any rate is computed over the full record.
 */
export const GOES_FLARE_FIRST_FULL_YEAR = 1976;
export const GOES_FLARE_LAST_YEAR = 2016;

/**
 * Where this app actually starts ingesting GOES, as against where the reports
 * start (`GOES_FLARE_FIRST_FULL_YEAR`).
 *
 * 1996 rather than 1976 because GOES 1-7 fluxes are documented as needing a
 * scaling correction, so "M1.0" before 1996 is not the same threshold as after.
 * Applying that correction would mean introducing a factor nobody here has
 * verified against a citable source — the free parameter non-negotiable #3
 * forbids. GOES-8 onward avoids the question and still gives thirty years.
 *
 * H1b registers this boundary (`HYPOTHESES.md`, "Why 1996"). Extending back to
 * 1976 remains possible and would roughly double the record, but only once that
 * correction is sourced and registered.
 */
export const GOES_FLARE_START_YEAR = 1996;

/**
 * Which catalogue a stored flare came from.
 *
 * Both are kept rather than one overwriting the other, because H1b's
 * registration rests on the two agreeing across 2014-2016 ("the join is
 * validated on their 2014-2016 overlap") — a claim that stops being checkable
 * in-app the moment either side is discarded. `preferredFlareSourceFor` below
 * is what keeps the overlap from being double-counted or drawn twice.
 */
export type FlareSource = 'goes' | 'donki';

/**
 * Which catalogue owns a given year, as H1b registers the join: **GOES at or
 * below 2016, DONKI above it.**
 *
 * One definition, deliberately, rather than the same comparison written out in
 * the query layer, the globe layer and the analysis request builder. Those three
 * must agree or the globe draws a flare the analysis didn't count — the same
 * reasoning that makes `displayWindow` the single definition of the visible
 * span.
 */
export function preferredFlareSourceFor(year: number): FlareSource {
  return year <= GOES_FLARE_LAST_YEAR ? 'goes' : 'donki';
}

/**
 * Flare classes, in order. Each letter is ten times the peak X-ray flux of the
 * one before, so the scale is logarithmic and the letters are not comparable as
 * categories — an X is a hundred times an M is not a figure of speech.
 */
export type FlareClass = 'A' | 'B' | 'C' | 'M' | 'X';

const CLASS_ORDER: readonly FlareClass[] = ['A', 'B', 'C', 'M', 'X'];

export interface SolarFlare {
  /**
   * Stable identity, and its shape depends on `source`.
   *
   * DONKI supplies its own — `2026-08-10T12:34:00-FLR-001`. **GOES supplies
   * none**, so the ingest synthesises one from the record's own fields
   * (`goes:<peak instant>-<class>`), which is what makes re-running the
   * backfill an idempotent upsert rather than a duplicate insert. The two
   * namespaces cannot collide, which matters because both catalogues are
   * stored across their 2014-2016 overlap.
   */
  id: string;
  /**
   * Which catalogue this row came from. See `FlareSource` for why both are
   * kept and `preferredFlareSourceFor` for which one a given year is read from.
   */
  source: FlareSource;
  /** As published, e.g. `M2.4`. */
  classType: string;
  flareClass: FlareClass;
  /** The number after the letter: `M2.4` is 2.4. */
  magnitude: number;
  /** Peak time — the instant a flare is dated by. */
  peakTimeUtc: string;
  beginTimeUtc: string | null;
  endTimeUtc: string | null;
  /**
   * Heliographic position on the solar disc, e.g. `N14W102`.
   *
   * Kept as published rather than parsed into coordinates: nothing here draws
   * the Sun, and a position past the limb (W102 above) is a real value that a
   * naive parse would silently accept as a point on the visible disc.
   */
  sourceLocation: string | null;
  activeRegionNumber: number | null;
  link: string | null;
}

/**
 * Whether a flare is at least a given class and magnitude.
 *
 * Needed because the scale is two-part and lexical comparison fails on it:
 * `M9.9` is smaller than `X1.0`, and `M10` does not occur — it is `X1`.
 */
export function flareAtLeast(
  flare: SolarFlare,
  minimumClass: FlareClass,
  minimumMagnitude = 1,
): boolean {
  const a = CLASS_ORDER.indexOf(flare.flareClass);
  const b = CLASS_ORDER.indexOf(minimumClass);
  if (a !== b) return a > b;
  return flare.magnitude >= minimumMagnitude;
}

/**
 * A modelled CME arrival at Earth.
 *
 * From WSA-ENLIL runs rather than from the CME catalogue itself: **the CME
 * records carry no arrival estimate**, and H2 is registered on arrival rather
 * than emission because Earth rotates substantially during transit.
 *
 * Only a minority of runs reach Earth at all — measured over ten weeks, 79 of
 * 325 — because most modelled CMEs miss. The rest carry arrivals at other
 * spacecraft instead.
 */
export interface CmeArrival {
  simulationId: string;
  /** Modelled shock arrival at Earth. */
  arrivalTimeUtc: string;
  /**
   * The model's predicted Kp at 90 degrees, its headline geoeffectiveness
   * estimate. Null when the run did not produce one.
   */
  predictedKp: number | null;
  /**
   * A grazing encounter rather than a direct hit.
   *
   * **Load-bearing for any trigger set.** A glancing blow can carry a predicted
   * Kp of 2 — barely geoeffective — and pooling those with direct hits dilutes
   * the trigger set with events that were never going to do anything.
   */
  glancingBlow: boolean;
  minorImpact: boolean;
  link: string | null;
}

/** Is this a CME arrival worth treating as a real impact? */
export function isDirectImpact(arrival: CmeArrival): boolean {
  return !arrival.glancingBlow && !arrival.minorImpact;
}

/**
 * What the DONKI backfill is currently doing, as the renderer sees it.
 *
 * `phase` names which endpoint is being fetched, same reason
 * `SpaceWeatherProgress` has one — flares and CME arrivals come from two
 * different DONKI endpoints. `completedChunks`/`totalChunks` count
 * (year, phase) pairs across *both* phases together, the same shape
 * `ArchiveProgress` uses for the earthquake archive's (year, tier) pairs —
 * reporting a single number per phase instead would leave "how far along is
 * the whole backfill" needing to be computed by every consumer rather than
 * answered here.
 */
export interface DonkiProgress {
  state: 'idle' | 'running' | 'waiting' | 'complete' | 'failed' | 'cancelled';
  phase: 'flares' | 'cme' | null;
  completedChunks: number;
  totalChunks: number;
  storedFlares: number;
  storedCmeArrivals: number;
  /** The year currently being fetched, if any. */
  currentYear: number | null;
  /** Present when `state` is 'failed'. */
  error: string | null;
  /**
   * When the next auto-resume attempt fires, only meaningful during
   * `'waiting'` — a rate limit is pausing the run rather than failing it.
   */
  retryAtUtc: string | null;
  /**
   * Whether a personal DONKI API key is configured.
   *
   * NASA's shared `DEMO_KEY` turned out too unreliable to build on (see
   * `nasa-donki.ts` in the ingest package) — a key is now required for these
   * features to fetch anything at all, and this is what the renderer checks
   * before letting a download start or a layer turn on, without the key
   * itself ever crossing IPC.
   */
  hasApiKey: boolean;
}

/**
 * What the GOES XRS flare backfill is doing.
 *
 * **Deliberately smaller than `DonkiProgress`**, and the missing fields are the
 * point: there is no `phase` (one source, not two), no `hasApiKey` (NOAA needs
 * no credential), and no `'waiting'` state or `retryAtUtc` (no rate limit to
 * pause for). Reusing `DonkiProgress` would have meant four fields that are
 * permanently null and a reader having to know which — the same "field present
 * but silently unused" shape the engine's request contracts are split to avoid.
 *
 * `totalChunks` is a constant 21: the range is closed at both ends
 * (`GOES_FLARE_START_YEAR`..`GOES_FLARE_LAST_YEAR`) and entirely in the past, so
 * unlike every other backfill here there is no current year to leave unrecorded.
 */
export interface GoesFlareProgress {
  state: 'idle' | 'running' | 'complete' | 'failed' | 'cancelled';
  completedChunks: number;
  totalChunks: number;
  storedFlares: number;
  /** The year currently being fetched, if any. */
  currentYear: number | null;
  /** Present when `state` is 'failed'. */
  error: string | null;
}
