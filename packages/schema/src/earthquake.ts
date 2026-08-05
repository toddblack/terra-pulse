/**
 * Which catalogue an event came from.
 *
 * USGS is authoritative where both report an event — it carries PAGER alert,
 * tsunami flag and significance, which EMSC does not. EMSC exists to fill the
 * coverage gap below M4: the USGS global feed is ~69% US at M2+, because small
 * events live in national catalogues USGS doesn't aggregate.
 */
import { ARCHIVE_SPANS, archiveSpanForHours, archiveSpanHours } from './archive';

export type EarthquakeSource = 'usgs' | 'emsc';

/**
 * The shape every layer downstream of ingest sees. Ingest adapters are the
 * only code that touches a raw USGS/EMSC/NOAA payload (non-negotiable #7).
 *
 * Fields are nullable where a source genuinely doesn't provide them, rather
 * than defaulted — a zero significance and an unknown significance are
 * different claims.
 */
export interface EarthquakeEvent {
  id: string;
  source: EarthquakeSource;
  magnitude: number;
  magnitudeType: string;
  place: string;
  timeUtc: string;
  updatedUtc: string;
  longitude: number;
  latitude: number;
  /**
   * Null where the catalogue genuinely has no depth for the event.
   *
   * Rare and almost entirely historical — measured across ~48,500 archive
   * events, 4 had no depth, all before 1980. Defaulting them to 0 would place a
   * possibly-deep event at the surface and in the shallowest colour band, which
   * is a false claim rather than a missing one.
   */
  depthKm: number | null;
  /** USGS review state ('automatic' | 'reviewed'). EMSC has no equivalent. */
  status: string | null;
  /**
   * Only ever set true by a source that actually reports it. False therefore
   * means "not flagged", not "confirmed no tsunami" — the inspector renders
   * the row only when true, so it never makes the stronger claim.
   */
  tsunami: boolean;
  /** USGS PAGER impact estimate. */
  alertLevel: string | null;
  /** USGS-specific composite score. */
  significance: number | null;
  url: string;
}

export interface EarthquakeQuery {
  startUtc?: string;
  endUtc?: string;
  minMagnitude?: number;
}

/**
 * Magnitude floors the UI offers.
 *
 * Every value here means something specific, which is why they aren't round
 * numbers:
 *
 * - **M1** — the densest floor ingested. Small events are only recorded where
 *   instrument networks are dense, so this is a map of seismometers as much as
 *   of seismicity.
 * - **M2.5** — USGS's own small-event feed threshold, and the conventional cut
 *   for "small but reliably located".
 * - **M4.5** — where global completeness begins. Measured: USGS misses ~70% of
 *   the M4.0-4.5 events EMSC reports, so anything below this is patchy outside
 *   well-instrumented regions.
 * - **M5.5** — the only floor whose global count has stayed flat since 1970
 *   (12% spread per decade, against 3× for M4.5+). This is the floor any
 *   decade-scale analysis has to use.
 *
 * - **M6.0** and **M7.0** — USGS's own class boundaries (*strong* and *major*).
 *   They exist for the archive: across 57 years M6+ is 7,907 events and M7+ is
 *   781, which is how "every great earthquake since 1970" becomes a view you
 *   can actually draw. **M6.5 is deliberately absent** — it is a round number
 *   with no class boundary on it, which is the exact mistake the rest of this
 *   list was corrected to avoid.
 *
 * An earlier version of this list was `[1, 2, 3, 4, 5]`. Round numbers read
 * tidier but sit beside the real thresholds rather than on them, and M5+ over a
 * long span would ship a 36% coverage drift looking like signal.
 */
export const MAGNITUDE_FLOORS: readonly number[] = [1, 2.5, 4.5, 5.5, 6, 7];

/**
 * How far back the catalogue is fetched, and to what magnitude floor.
 *
 * **One definition, used by both sides.** Main loops these to decide what to
 * ingest; the renderer reads them to decide what the selectors may offer. If
 * they were declared separately the two would drift, and the symptom would be a
 * selectable view the database was never filled for — an empty globe that looks
 * like a quiet month rather than a missing fetch.
 *
 * ## Why the 30-day floor is higher, and why 7-day's isn't
 *
 * This is a **volume** limit, not a completeness one — worth being precise
 * about, because it's easy to reach for the completeness argument and it
 * doesn't apply here. An M1 event is exactly as detectable over 30 days as over
 * 4; there are simply 30 days of them. Regional detection bias is identical at
 * every span.
 *
 * Measured merged marks (USGS + EMSC, after dedup): 4d/M1+ ~2,177 ·
 * 7d/M1+ ~3,638 · 30d/M1+ ~15,600 · 30d/M2.5+ ~7,671. Today's live load is
 * ~2,177, so 7 days at M1 costs 1.7× and stays. Thirty days at M1 would be 7×
 * and produce a globe too dense to read, so that tier alone starts at M2.5.
 *
 * The genuine completeness coupling belongs to the historical tiers, where
 * detection really did change over the decades. Not these.
 */
export interface CoverageTier {
  windowHours: number;
  minMagnitude: number;
  /** Shown on the window button. */
  label: string;
}

export const COVERAGE_TIERS: readonly CoverageTier[] = [
  { windowHours: 24, minMagnitude: 1, label: '24h' },
  { windowHours: 48, minMagnitude: 1, label: '48h' },
  { windowHours: 72, minMagnitude: 1, label: '72h' },
  // No 4d. It sat between 72h and 7d and answered neither question better
  // than its neighbours — the useful steps are "the last few days" and "the
  // last week".
  { windowHours: 168, minMagnitude: 1, label: '7d' },
  { windowHours: 720, minMagnitude: 2.5, label: '30d' },
];

/**
 * The next floor above this one, or `null` at the top.
 *
 * Turns a floor into a band: M1 with this ceiling is "M1 up to but not
 * including M2.5". Used by the isolate-band control, which exists because
 * "everything at least this big" and "only things around this big" are
 * different questions — the first is dominated by whatever is biggest, and the
 * second is the one that shows swarm and induced-seismicity texture.
 *
 * Generalised rather than hardcoded to M2.5: isolating any band costs the same
 * code, and M2.5-4.5 is a legitimate view too.
 */
export function nextMagnitudeFloorAbove(floor: number): number | null {
  const higher = MAGNITUDE_FLOORS.filter((magnitude) => magnitude > floor);
  return higher.length > 0 ? Math.min(...higher) : null;
}

/** The tier governing a given window length. */
export function coverageTierFor(windowHours: number): CoverageTier | undefined {
  return COVERAGE_TIERS.find((tier) => tier.windowHours === windowHours);
}

/**
 * The lowest magnitude the catalogue actually holds for this span.
 *
 * Consults the live tiers *and* the archive spans, because both are windows the
 * selector can offer and they answer this question differently — 30 days holds
 * M2.5+, a decade holds only M5.5+. Keeping one resolver means the store's
 * floor-auto-raise works across the boundary with no special case.
 *
 * An unrecognised window falls back to the strictest floor — showing less than
 * exists is recoverable; showing an empty globe as though it were a quiet month
 * is not.
 */
export function minMagnitudeForWindow(windowHours: number): number {
  const tier = coverageTierFor(windowHours);
  if (tier) return tier.minMagnitude;

  const span = archiveSpanForHours(windowHours);
  if (span) return span.minMagnitude;

  return Math.max(
    ...COVERAGE_TIERS.map((entry) => entry.minMagnitude),
    ...ARCHIVE_SPANS.map((entry) => entry.minMagnitude),
  );
}

/** Floors meaningful for a span — anything at or above what was ingested. */
export function magnitudeFloorsForWindow(windowHours: number): readonly number[] {
  const floor = minMagnitudeForWindow(windowHours);
  return MAGNITUDE_FLOORS.filter((magnitude) => magnitude >= floor);
}

/**
 * The minimal set of fetches covering every tier.
 *
 * Tiers nest, so most are already covered by a longer one at the same floor:
 * six tiers collapse to two fetches (7d at M1, 30d at M2.5). Derived rather
 * than listed so adding a tier can't leave a gap nobody notices.
 */
export function ingestPasses(): CoverageTier[] {
  const longestByFloor = new Map<number, CoverageTier>();

  for (const tier of COVERAGE_TIERS) {
    const current = longestByFloor.get(tier.minMagnitude);
    if (!current || tier.windowHours > current.windowHours) {
      longestByFloor.set(tier.minMagnitude, tier);
    }
  }

  return [...longestByFloor.values()].sort((a, b) => a.windowHours - b.windowHours);
}

/** The longest span the catalogue covers — the pruning horizon. */
export function longestCoverageHours(): number {
  return Math.max(...COVERAGE_TIERS.map((tier) => tier.windowHours));
}

/** Every window length the UI offers, live and archive, shortest first. */
export function offeredWindowHours(): number[] {
  return [
    ...COVERAGE_TIERS.map((tier) => tier.windowHours),
    ...ARCHIVE_SPANS.map(archiveSpanHours),
  ].sort((a, b) => a - b);
}

/**
 * The next-shorter window the UI offers, or `null` at the shortest.
 *
 * This is the trailing window's length. Deriving it from the ladder rather than
 * picking a constant means the trail is always "one step of history" — a decade
 * inside the all-years view, a year inside the decade — and adding a span can't
 * leave it stale. `null` at the bottom is what tells the UI to omit the control
 * instead of offering a checkbox that would do nothing, exactly as
 * `nextMagnitudeFloorAbove` does for the isolate-band control.
 */
export function previousWindowHours(windowHours: number): number | null {
  const shorter = offeredWindowHours().filter((hours) => hours < windowHours);
  return shorter.length > 0 ? Math.max(...shorter) : null;
}

/**
 * The result of one catalogue sync, pushed from main to the renderer.
 *
 * `changed` is false on a quiet poll — the renderer uses it to refresh its
 * freshness indicator without replacing the event set, which would otherwise
 * rebuild the globe layer and destroy the user's current selection.
 */
export interface EarthquakeSyncResult {
  changed: boolean;
  syncedAt: string;
}

/**
 * The magnitude at which a newly-arrived event is worth interrupting for.
 *
 * Chosen by frequency, because that is what a threshold like this is actually
 * for. Measured over the last 365 days: **M5.5 → 485/year (1.3 per day)**,
 * **M5.8 → 233/year (one per 1.6 days)**, **M6 → 139/year (one per 2.6 days)**.
 * One that fires daily gets ignored, and an alert people learn to dismiss
 * without reading is worse than none — it trains you past the M7 as well.
 *
 * **Deliberately not a USGS class boundary, unlike every other threshold in
 * this file — and that is fine here.** `MAGNITUDE_FLOORS` and `COVERAGE_TIERS`
 * sit on real boundaries because they encode *detection completeness*: claims
 * about what the catalogue does and doesn't contain. This encodes "how often do
 * I want to be interrupted", which is a preference, not a fact about the Earth.
 * A number between the boundaries is the right answer to a question about
 * attention.
 *
 * Inclusive: an exact M5.8 alerts, an M5.79 does not.
 */
export const ALERT_MIN_MAGNITUDE = 5.8;

/**
 * How recent an arriving event must be to be announced.
 *
 * One hour, sized against the measured USGS publication lag: 78 s minimum, 222 s
 * median, with revisions arriving for hours afterwards. An hour comfortably
 * clears the slow tail while still excluding the 24-hour feed's older contents
 * on the first poll after launch.
 */
export const ALERT_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * How many events the launch summary lists before trimming.
 *
 * Ten fits on screen without becoming a wall. The list is ordered by magnitude
 * rather than time precisely so this cap can only trim the least interesting
 * end — a chronological cap could hide an M7.5 behind ten M5.9s.
 */
export const MISSED_EVENTS_LIMIT = 10;

/**
 * What arrived while the app was closed — shown once, on launch.
 *
 * Distinct from an alert, and deliberately so. An alert interrupts and claims
 * "this just happened"; this is a digest you choose to read, so it carries no
 * freshness bound and covers however long you were away.
 */
export interface MissedEvents {
  events: EarthquakeEvent[];
  /** Total qualifying, which can exceed `events.length` — see the limit. */
  totalCount: number;
  /** How far back the digest reaches: the last moment the app was running. */
  sinceUtc: string;
}

export interface BoundingBox {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}
