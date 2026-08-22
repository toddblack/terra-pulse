/**
 * Focal mechanisms from the Global CMT catalogue — the orientation H6 resolves
 * tidal stress onto, and the one thing that hypothesis was blocked on.
 *
 * Nothing else in this app stores a fault orientation: `vendor-gem-faults.mjs`
 * explicitly drops dip and rake, and USGS moment-tensor products were measured
 * and rejected (35-70% coverage of M5+, with the product mix inverting over the
 * record). Full reconnaissance is in `SOURCES.md` under "Focal mechanisms".
 */

/**
 * One centroid-moment-tensor solution, as published.
 *
 * Faithful to the source per non-negotiable #7 — in particular **both nodal
 * planes are stored even though H6 reads only the first**. Discarding the
 * second here would be the adapter making an analysis decision; the analysis
 * makes it at the call site, the same split the aurora layer uses for its
 * equatorial seam.
 */
export interface FocalMechanism {
  /** GCMT's own event name, e.g. `C202401010710A`. Unique within the catalogue. */
  id: string;
  /**
   * Hypocentre origin time, from the reference catalogue on NDK line 1 — a
   * **USGS PDE** hypocentre for 93.1% of the record, which is what makes the
   * join to this app's own catalogue mostly an identity match.
   *
   * This is the instant H6 uses: its registration says stress is evaluated "at
   * hypocenter location and origin time". The centroid below is CMT's own
   * inversion and sits tens of km and tens of seconds away by design.
   */
  timeUtc: string;
  /** Hypocentre latitude, degrees north. */
  latitude: number;
  /** Hypocentre longitude, degrees east. */
  longitude: number;
  /** Hypocentre depth, km. */
  depthKm: number;
  /** Moment magnitude, from the scalar moment. */
  magnitude: number;
  /**
   * Scalar seismic moment in **dyne-cm**, the unit NDK publishes.
   *
   * Kept in the published unit rather than converted to N-m, so a reader
   * comparing against globalcmt.org sees the same number. `momentMagnitude`
   * carries the conversion and its constant.
   */
  scalarMomentDyneCm: number;
  /** Strike, dip, rake of the first nodal plane, degrees. The plane H6 reads. */
  nodalPlane1: NodalPlane;
  /**
   * The second nodal plane. Stored for fidelity; **not to be used in a stress
   * calculation** — see `NODAL_PLANE_ROUNDING_NOTE`.
   */
  nodalPlane2: NodalPlane;
  /** Centroid latitude, degrees north. */
  centroidLatitude: number;
  /** Centroid longitude, degrees east. */
  centroidLongitude: number;
  /** Centroid depth, km. */
  centroidDepthKm: number;
  /**
   * Which catalogue supplied the hypocentre on line 1 — `PDE`, `PDEW`, `MLI`
   * and so on. Provenance rather than a filter: 93.1% are a PDE variant.
   */
  referenceCatalog: string;
}

/** Fault-plane orientation in the Aki & Richards convention, whole degrees. */
export interface NodalPlane {
  /** Degrees clockwise from north. */
  strike: number;
  /** Degrees from horizontal, 0-90. */
  dip: number;
  /** Slip direction in the plane, -180 to 180. */
  rake: number;
}

/**
 * Why a stress calculation must read `nodalPlane1` and never compare the two.
 *
 * The resolved **shear** stress is identical on both planes — for conjugates
 * n₂ = u₁ and u₂ = n₁, so n₁·σ·u₁ equals u₁·σ·n₁ for any symmetric σ. Verified
 * against all 70,044 published mechanisms: worst difference 3.3e-16.
 *
 * But GCMT rounds both planes to whole degrees, so the two *listed* planes are
 * only approximately conjugate, and their resolved shear disagrees by **1.3% at
 * the median and 9.6% at p90**. That is publication precision, not physics. An
 * implementation that computes both and finds them different will read the
 * rounding as a real signal and be tempted to pick a "better" plane — which is
 * exactly the free parameter H6's registration exists to exclude.
 */
export const NODAL_PLANE_ROUNDING_NOTE =
  'Read nodal plane 1 only. The planes are physically equivalent for shear stress; ' +
  'their published forms differ by rounding alone.';

/**
 * Kanamori's relation for moments in **dyne-cm**.
 *
 * The N-m form uses 9.1 rather than 16.1. Getting the pair wrong shifts every
 * magnitude by 1.2 units, which is a plausible-looking catalogue rather than an
 * obviously broken one — hence the constant lives here with its unit named.
 */
export function momentMagnitude(scalarMomentDyneCm: number): number {
  return (2 / 3) * (Math.log10(scalarMomentDyneCm) - 16.1);
}

/**
 * The first year Global CMT covers.
 *
 * The shared catalogue reaches 1970 and the deep tier 1900, but no orientation
 * exists before this, so H6's effective span starts here and says so.
 *
 * `PRE1976/` publishes solutions for deep events 1962-1976 and
 * intermediate-depth ones 1962-1975. Deliberately not ingested: they are
 * depth-selected rather than a complete catalogue, so including them would make
 * the pre-1976 record a biased sample of exactly the variable that already
 * drifts across the record.
 */
export const GCMT_START_YEAR = 1976;

/**
 * The floor H6 registers, and the reason it differs from every other
 * hypothesis here.
 *
 * The binding limit is not GCMT's own completeness but **what fraction of this
 * app's target set can be given an orientation at all**. Measured across the
 * record: 39.5% → 80.6% at M5.0+ (a 2.0x swing), against 84.3% → 94.0% at
 * M5.5+ and 93.3% → 97.7% at M6.0+. At M5.0+ the usable set would be "the
 * subset that happened to get a CMT" rather than "M5.0+ events".
 *
 * It is also the floor Tanaka, Ohtake & Sato (2002) used against this same
 * catalogue, and the floor this project already uses for rate claims — three
 * independent routes to the same number.
 */
export const MECHANISM_STABLE_MIN_MAGNITUDE = 5.5;

/**
 * How a CMT solution is matched to an event in this app's catalogue.
 *
 * Chosen from the measured distribution rather than picked: across 53,000 real
 * matches the offsets sit at p99 = 7.9 s and 40 km, so these bounds are well
 * clear of the match population without reaching into a neighbouring event.
 * 93.1% of GCMT hypocentres are USGS PDE to begin with, so most matches are
 * exact.
 */
export const MECHANISM_JOIN_WINDOW_MS = 60_000;
/** See `MECHANISM_JOIN_WINDOW_MS`. */
export const MECHANISM_JOIN_RADIUS_KM = 100;

/** The minimum an event must carry to be matched against the catalogue. */
export interface MechanismJoinTarget {
  timeUtc: string;
  latitude: number;
  longitude: number;
}

export interface MechanismMatch<T extends MechanismJoinTarget> {
  event: T;
  mechanism: FocalMechanism;
  /** Separation between the two hypocentres, km. */
  distanceKm: number;
  /** Absolute difference in origin time, seconds. */
  timeOffsetSeconds: number;
}

export interface MechanismJoinResult<T extends MechanismJoinTarget> {
  matched: MechanismMatch<T>[];
  /** Events with no mechanism inside the join bounds. */
  unmatched: T[];
}

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRadians = Math.PI / 180;
  const deltaLat = (bLat - aLat) * toRadians;
  const deltaLon = (bLon - aLon) * toRadians;
  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(aLat * toRadians) * Math.cos(bLat * toRadians) * Math.sin(deltaLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/**
 * Attaches a focal mechanism to each event, nearest in space among those inside
 * the time window.
 *
 * ## Why it is a merge rather than a SQL join
 *
 * The predicate is "within 60 s **and** 100 km", and SQLite can index the first
 * half but not the second. Expressing it in SQL would mean a correlated range
 * join with the distance recomputed per candidate pair in an expression SQLite
 * cannot optimise. Both sides are small — ~19,000 M5.5+ events against 70,044
 * mechanisms — so a two-pointer sweep over time-ordered arrays does the whole
 * thing in one pass with no per-event search at all.
 *
 * **Both inputs must be sorted by `timeUtc` ascending.** That is what makes it
 * a sweep rather than a scan per event; it is asserted rather than assumed,
 * because an unsorted input would silently return a plausible partial join.
 *
 * ## Nearest in space, not first in time
 *
 * Aftershock sequences put several M5.5+ events within a minute of each other,
 * so "the first mechanism inside the window" is not reliably the right one.
 * Distance separates them cleanly: the measured match population sits at p99 =
 * 40 km, while a genuinely different event in the same sequence is hundreds of
 * km away or is itself matched to its own mechanism.
 *
 * ## One mechanism belongs to exactly one event
 *
 * Nearest-per-event is not enough on its own, and the failure is quiet. A large
 * mainshock and a smaller event seconds later both fall inside each other's
 * window; CMT inverts the mainshock but often not the smaller one, whose signal
 * is swamped. With no mechanism of its own, the smaller event then claims the
 * mainshock's — and receives a fault orientation belonging to a different
 * earthquake.
 *
 * Measured on the real catalogue: **53 mechanisms were claimed twice out of
 * 21,125 matches**, and the shape is unmistakable. `C032378C` sits 0.2 km and
 * 0.0 s from an M7.5 and was also taken by an M5.9 **89.7 km** away.
 *
 * So a mechanism goes to its nearest claimant and the others are returned as
 * unmatched. That is the right outcome for both cases behind those 53: for two
 * genuinely distinct events it withholds an orientation nobody measured, and
 * for the 19 that are the same earthquake recorded twice under different
 * sources (`usp000198f` and `iscgem639614` are one M5.5) it keeps the duplicate
 * out of the target set entirely. Being unmatched is ordinary here — 9.4% of
 * M5.5+ events have no mechanism at all.
 */
export function matchMechanisms<T extends MechanismJoinTarget>(
  events: readonly T[],
  mechanisms: readonly FocalMechanism[],
  windowMs: number = MECHANISM_JOIN_WINDOW_MS,
  radiusKm: number = MECHANISM_JOIN_RADIUS_KM,
): MechanismJoinResult<T> {
  const eventTimes = events.map((event) => Date.parse(event.timeUtc));
  const mechanismTimes = mechanisms.map((mechanism) => Date.parse(mechanism.timeUtc));
  assertAscending(eventTimes, 'events');
  assertAscending(mechanismTimes, 'mechanisms');

  const matched: MechanismMatch<T>[] = [];
  const unmatched: T[] = [];

  // Left edge of the candidate window. It only ever moves forward, which is
  // what keeps this linear.
  let low = 0;

  for (const [index, event] of events.entries()) {
    const eventMs = eventTimes[index]!;
    while (low < mechanisms.length && mechanismTimes[low]! < eventMs - windowMs) low += 1;

    let best: MechanismMatch<T> | null = null;
    for (let cursor = low; cursor < mechanisms.length; cursor += 1) {
      const mechanismMs = mechanismTimes[cursor]!;
      if (mechanismMs > eventMs + windowMs) break;
      const mechanism = mechanisms[cursor]!;
      const distanceKm = haversineKm(
        event.latitude,
        event.longitude,
        mechanism.latitude,
        mechanism.longitude,
      );
      if (distanceKm > radiusKm) continue;
      if (best === null || distanceKm < best.distanceKm) {
        best = {
          event,
          mechanism,
          distanceKm,
          timeOffsetSeconds: Math.abs(mechanismMs - eventMs) / 1000,
        };
      }
    }

    if (best === null) unmatched.push(event);
    else matched.push(best);
  }

  return resolveContested(matched, unmatched);
}

/**
 * Gives each mechanism to its nearest claimant and returns the rest unmatched.
 *
 * Ties are broken on the smaller time offset and then on first-seen order, so
 * the result does not depend on iteration accident — a registered analysis has
 * to produce the same target set on every run.
 */
function resolveContested<T extends MechanismJoinTarget>(
  matched: readonly MechanismMatch<T>[],
  unmatched: readonly T[],
): MechanismJoinResult<T> {
  const winners = new Map<string, MechanismMatch<T>>();

  for (const candidate of matched) {
    const held = winners.get(candidate.mechanism.id);
    if (held === undefined) {
      winners.set(candidate.mechanism.id, candidate);
      continue;
    }
    const closer =
      candidate.distanceKm < held.distanceKm ||
      (candidate.distanceKm === held.distanceKm &&
        candidate.timeOffsetSeconds < held.timeOffsetSeconds);
    if (closer) winners.set(candidate.mechanism.id, candidate);
  }

  const kept = new Set(winners.values());
  const displaced = matched.filter((candidate) => !kept.has(candidate)).map((c) => c.event);

  return {
    // Rebuilt from `matched` rather than from the map, so the output keeps the
    // input's chronological order instead of insertion order.
    matched: matched.filter((candidate) => kept.has(candidate)),
    unmatched: [...unmatched, ...displaced],
  };
}

function assertAscending(times: readonly number[], label: string): void {
  for (const [index, time] of times.entries()) {
    if (!Number.isFinite(time)) {
      throw new Error(`matchMechanisms: ${label}[${String(index)}] has an unparseable timeUtc`);
    }
    if (index > 0 && time < times[index - 1]!) {
      throw new Error(`matchMechanisms: ${label} must be sorted by timeUtc ascending`);
    }
  }
}

/**
 * Progress of the Global CMT backfill, for the archive panel.
 *
 * Mirrors `GoesFlareProgress` rather than inventing a shape, with one addition:
 * `pendingMonths`. Global CMT publishes solutions on a three-to-four-month
 * delay, so the most recent months genuinely do not exist yet — a download can
 * be entirely successful and still leave chunks unfetched. Without this the
 * panel would show a permanently incomplete bar and read as a failed download.
 */
export interface GcmtProgress {
  state: 'idle' | 'running' | 'complete' | 'failed' | 'cancelled';
  completedChunks: number;
  totalChunks: number;
  storedMechanisms: number;
  /** The chunk currently being fetched, if any. */
  currentChunk: string | null;
  /** Chunks skipped because the source has not published them yet. */
  pendingMonths: number;
  /** Present when `state` is 'failed'. */
  error: string | null;
}
