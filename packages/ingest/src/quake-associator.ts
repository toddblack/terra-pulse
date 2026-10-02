import { haversineKm } from '@terra-pulse/schema';
import type { Pick } from './quake-picker';

/**
 * Turns station picks into earthquakes: finds a location and origin time that
 * several stations' picks agree on.
 *
 * **Agreement is the whole defence against false alarms.** One station
 * triggering means nothing — trucks, doors, glitches. Four triggering at times
 * that a single point source at crustal P velocity explains, to within a
 * second, is very hard to produce by coincidence, because noise does not know
 * how far apart the stations are.
 *
 * The method is a plain grid search, chosen over anything cleverer because it
 * is easy to verify and cannot get stuck: every node in the region is tried,
 * the travel time from it to each picked station is subtracted from that
 * pick, and the node where the most stations imply the *same* origin time
 * (within the tolerance) wins. A coarse pass over the whole region, then a fine
 * pass around the winner.
 *
 * **Uniform velocity, fixed depth.** Real crust is layered, and beyond
 * ~150 km the faster mantle path (Pn) overtakes the crustal one, so far picks
 * arrive early relative to this model. For an alert that only matters in the
 * first few stations — which are near — this is the right simplification; the
 * tolerance absorbs the rest. It is also why `minStations` should be met by
 * nearby stations, and why the miss check below only asks about stations
 * closer than the farthest one that did trigger.
 */

export interface AssociatorStation {
  channelId: string;
  latitude: number;
  longitude: number;
}

export interface AssociatorParams {
  /** Average crustal P velocity, km/s. */
  pVelocityKmS: number;
  /** Average crustal S velocity, km/s — only used to absorb S-wave retriggers. */
  sVelocityKmS: number;
  /** Assumed hypocentre depth, km. Southern California's seismicity is mostly 5-15. */
  depthKm: number;
  /**
   * How far, in seconds, a pick may sit from the model and still agree.
   *
   * **This sets how easily coincidence passes for a quake**, so it is set by
   * station spacing, not just by pick error. A crustal wave takes ~3 s to cross
   * the ~20 km between neighbouring stations; at ±1 s (a 2 s window) a distant
   * quake's fast-sweeping P wave fitted fake sources inside the network on
   * rings of similar-distance stations, in tests. ±0.5 s still exceeds what
   * pick error (~0.1-0.3 s with a 0.5 s STA) and the uniform-velocity model
   * (~0.3 s at 50 km) cost the first few, near, stations — which is the claim
   * the replay's tuning half has to confirm.
   */
  toleranceS: number;
  /** Stations that must agree before an event is declared. */
  minStations: number;
  /**
   * Of the stations that *should* have triggered by now — data already past
   * their predicted arrival, closer than the farthest member — the largest
   * fraction allowed to have stayed silent. Noise and distant quakes produce
   * clusters that fit a point source by luck; they rarely also explain why the
   * stations nearest that point heard nothing.
   */
  maxMissFraction: number;
  /**
   * The located epicentre must lie within this distance of its nearest member
   * station, km.
   *
   * **This is the guard the miss check cannot provide on its own**, found by a
   * test: a point source placed far *outside* the network sees every station
   * at nearly the same distance, so four near-simultaneous picks — a distant
   * great quake's P wave, arriving almost vertically — fit it by luck, and no
   * station lies nearer to it to contradict the fit. A real local quake that
   * four stations heard has one of them close by in a network this dense.
   *
   * It also bounds the search grid (see the constructor), so a real quake
   * beyond this reach — offshore, say — is declared at the network's edge in
   * the right direction rather than not at all: measured in tests ~40 km off
   * with a late origin, errors that largely cancel for a site inside.
   */
  maxNearestStationKm: number;
  /**
   * How long an unassociated pick stays available, seconds. Long enough for
   * the first several stations of any quake the network can locate — 50 km of
   * reach plus station spacing is well under 20 s of P travel — and short
   * enough that a noisy station's stray triggers don't pile up into clusters
   * of their own. Was 90; noise accumulation on real data is why it is not.
   */
  pickRetentionS: number;
  /**
   * After an event, how long past each station's predicted S arrival its
   * further picks are treated as that event's own shaking (S wave, coda)
   * rather than as candidates for a new one.
   */
  codaS: number;
  /**
   * Whether a pick inside an earlier event's S/coda window — one that fits
   * neither that event's P nor its S — may still help locate a *new* event.
   *
   * **This, not stuck stations, was the main reason a second quake was
   * missed.** Traced on a real M3.9 that followed an M3.4 by 23 s: once the
   * stations were released they *did* pick it, and every pick was filed as
   * the M3.4's coda. A second quake's P lands exactly in the first one's coda
   * window at every station farther than a few kilometres.
   *
   * Opened alone, it was a disaster: 30-48 false alarms on the `sequence` set
   * for at most two more detections — the first quake's S waves and coda
   * bursts lining up into fake sources. The three rules below are what make it
   * safe; each was found from what the false alarms actually were.
   */
  retriggersMayDeclare: boolean;
  /**
   * A new event built from any such pick must lie within this distance of the
   * event whose shaking that pick was in. A genuine second quake mid-coda is
   * the same sequence; the fakes sat 35-300 km away. 30 km is flat with 20 on
   * every set and removed the last three that 60 km let through (two near
   * Malibu, one 35 km along Ridgecrest's M7.1 rupture 6.6 s after it).
   *
   * **The price:** for the minute or two of a big quake's coda, a large
   * aftershock more than 30 km away is missed. Ridgecrest's rupture ran ~50
   * km, so that can happen. Before this rule, every quake in a coda was.
   */
  sequenceRadiusKm: number;
  /**
   * ...and must begin at least this long after it, s, or it is the same quake.
   * Every false alarm left at 30 km was this: a real quake declared twice, 1-3
   * s apart — two alerts for one earthquake. Flat from 5 to 10 s.
   */
  minSequenceGapS: number;
  /**
   * A pick this close to an earlier event's predicted S arrival, s, is that
   * event's S wave and is never offered to a new one. Found by a synthetic
   * test, not by the replay: a row of S picks plus one stray fitted a fake
   * source 26 km away and 8 s later, inside both rules above. Flat from 1 to
   * 2.5 s on the `sequence` set.
   */
  sToleranceS: number;
  coarseGridKm: number;
  fineGridKm: number;
}

export const DEFAULT_ASSOCIATOR_PARAMS: AssociatorParams = {
  pVelocityKmS: 6.2,
  sVelocityKmS: 3.6,
  depthKm: 8,
  toleranceS: 0.5,
  minStations: 4,
  maxMissFraction: 0.4,
  maxNearestStationKm: 50,
  pickRetentionS: 45,
  codaS: 30,
  retriggersMayDeclare: true,
  sequenceRadiusKm: 30,
  minSequenceGapS: 5,
  sToleranceS: 1.5,
  coarseGridKm: 8,
  fineGridKm: 1,
};

export interface AssociatedEvent {
  /** Increments per declared event. */
  id: number;
  originMs: number;
  latitude: number;
  longitude: number;
  /** Picks that located it, plus later P picks that fit it. */
  picks: Pick[];
  /** Root-mean-square misfit of the member picks, seconds. */
  rmsS: number;
  /** Stations that should have triggered by declaration and did not. */
  missedStations: string[];
}

/**
 * What became of the last pick offered — for diagnosing why a quake was
 * declared late or a false alarm got through. Never needed to run the
 * detector; only to understand it.
 */
export type AssociationVerdict =
  | { kind: 'unknown-station' }
  | { kind: 'absorbed'; eventId: number }
  | { kind: 'too-few'; stations: number }
  | { kind: 'too-far-outside'; nearestKm: number }
  | { kind: 'nearest-silent'; stations: number }
  | { kind: 'too-many-silent'; stations: number; silent: number }
  | { kind: 'not-in-sequence'; stations: number }
  | { kind: 'duplicate'; stations: number }
  | { kind: 'declared'; eventId: number };

interface Located {
  latitude: number;
  longitude: number;
  originMs: number;
  /** Indices into the candidate pick list. */
  members: number[];
  rmsS: number;
}

interface PooledPick extends Pick {
  stationIndex: number;
  /** The event whose S/coda window this pick fell in, if any. */
  inShakingOf: number | null;
}

const KM_PER_DEGREE = 111.195;

/**
 * Upper-mantle P velocity. Used only as the earliest any part of a declared
 * event can reach a station — never to locate. Taken with no crossover
 * intercept, so it errs early, which here means absorbing generously.
 */
const PN_VELOCITY_KM_S = 8;

/**
 * Distinct clusters tried per pick, best first. **One, on measurement.** At 8,
 * Ridgecrest's M6.4 was declared ~1 s sooner — but 25 km off, and the
 * distant-quake sweep test started passing a false cluster: every extra
 * candidate is another chance for coincidence to survive the checks, the same
 * multiple-comparisons arithmetic the Analyze mode corrects for. Left as a
 * knob, not hard-coded, so that trade can be re-measured on the replay.
 */
const MAX_CANDIDATES = 1;

export class QuakeAssociator {
  private readonly params: AssociatorParams;
  private readonly stations: readonly AssociatorStation[];
  private readonly indexOf = new Map<string, number>();
  private readonly nodeLat: Float64Array;
  private readonly nodeLon: Float64Array;
  /** Travel time, seconds, from every coarse node to every station: node-major. */
  private readonly nodeTravelS: Float32Array;
  private readonly stationSeen: Int32Array;
  private pool: PooledPick[] = [];
  private events: AssociatedEvent[] = [];
  private nextId = 1;

  constructor(stations: readonly AssociatorStation[], params: AssociatorParams = DEFAULT_ASSOCIATOR_PARAMS) {
    this.params = params;
    this.stations = stations;
    stations.forEach((station, index) => this.indexOf.set(station.channelId, index));
    this.stationSeen = new Int32Array(stations.length).fill(-1);

    // The search covers only ground within `maxNearestStationKm` of some
    // station. A source anywhere else would be rejected at declaration anyway —
    // and searched, it does harm: measured on Ridgecrest's M6.4, stray picks
    // from a noisy station formed a *larger* cluster placed far outside the
    // network, which outranked the real one, failed, and blocked it. The real
    // quake was declared only once it outnumbered the noise, 12 s late.
    const lats = stations.map((s) => s.latitude);
    const lons = stations.map((s) => s.longitude);
    const midLat = lats.length > 0 ? (Math.min(...lats) + Math.max(...lats)) / 2 : 0;
    const reach = params.maxNearestStationKm;
    const kmPerLonDegree = KM_PER_DEGREE * Math.cos((midLat * Math.PI) / 180);
    const stepLat = params.coarseGridKm / KM_PER_DEGREE;
    const stepLon = params.coarseGridKm / kmPerLonDegree;
    const lat0 = (lats.length > 0 ? Math.min(...lats) : 0) - reach / KM_PER_DEGREE;
    const lat1 = (lats.length > 0 ? Math.max(...lats) : 0) + reach / KM_PER_DEGREE;
    const lon0 = (lons.length > 0 ? Math.min(...lons) : 0) - reach / kmPerLonDegree;
    const lon1 = (lons.length > 0 ? Math.max(...lons) : 0) + reach / kmPerLonDegree;
    const rows = Math.max(1, Math.ceil((lat1 - lat0) / stepLat) + 1);
    const cols = Math.max(1, Math.ceil((lon1 - lon0) / stepLon) + 1);

    const nodeLat: number[] = [];
    const nodeLon: number[] = [];
    const travel: number[] = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const node = { latitude: lat0 + r * stepLat, longitude: lon0 + c * stepLon };
        const distances = stations.map((station) => haversineKm(node, station));
        if (Math.min(...distances) > reach) continue;
        nodeLat.push(node.latitude);
        nodeLon.push(node.longitude);
        for (const km of distances) travel.push(this.travelS(km, params.pVelocityKmS));
      }
    }
    this.nodeLat = Float64Array.from(nodeLat);
    this.nodeLon = Float64Array.from(nodeLon);
    this.nodeTravelS = Float32Array.from(travel);
  }

  get nodeCount(): number {
    return this.nodeLat.length;
  }

  private travelS(epicentralKm: number, velocityKmS: number): number {
    return Math.hypot(epicentralKm, this.params.depthKm) / velocityKmS;
  }

  private stationTravelS(station: AssociatorStation, latitude: number, longitude: number, v: number): number {
    return this.travelS(haversineKm({ latitude, longitude }, station), v);
  }

  /**
   * Offers one pick. Returns the event it caused to be declared, if any.
   *
   * `readyThroughMs` says, per station, how far its continuous, warmed-up data
   * reaches (or null if it has none) — what the miss check needs to know
   * whether silence is evidence.
   */
  /** What happened to the most recent pick. Diagnostic only. */
  lastVerdict: AssociationVerdict = { kind: 'too-few', stations: 0 };

  addPick(pick: Pick, nowMs: number, readyThroughMs: (channelId: string) => number | null): AssociatedEvent | null {
    const stationIndex = this.indexOf.get(pick.channelId);
    if (stationIndex === undefined) {
      this.lastVerdict = { kind: 'unknown-station' };
      return null;
    }
    this.expire(nowMs);

    // A pick that falls inside an existing event's shaking at this station
    // belongs to that event — its P if it fits, otherwise its S or coda.
    //
    // **The window opens at mantle speed, not crustal.** Beyond ~150 km the
    // wave refracted along the top of the mantle (Pn, ~8 km/s) overtakes the
    // crustal P this model uses, so distant stations pick *early* against it.
    // Opened at crustal P, those early picks escaped the event and grouped into
    // new ones: four false alarms inside Ridgecrest's M6.4, at 170-300 km.
    let inShakingOf: number | null = null;
    for (const event of this.events) {
      const station = this.stations[stationIndex] as AssociatorStation;
      const pArrival = event.originMs + 1000 * this.stationTravelS(station, event.latitude, event.longitude, this.params.pVelocityKmS);
      const earliest = event.originMs + 1000 * this.stationTravelS(station, event.latitude, event.longitude, PN_VELOCITY_KM_S);
      const sArrival = event.originMs + 1000 * this.stationTravelS(station, event.latitude, event.longitude, this.params.sVelocityKmS);
      const toleranceMs = this.params.toleranceS * 1000;
      if (pick.timeMs >= earliest - toleranceMs && pick.timeMs <= sArrival + this.params.codaS * 1000) {
        const fitsP = Math.abs(pick.timeMs - pArrival) <= toleranceMs;
        const fitsS = Math.abs(pick.timeMs - sArrival) <= this.params.sToleranceS * 1000;
        if (fitsP && !event.picks.some((p) => p.channelId === pick.channelId)) event.picks.push(pick);
        if (fitsP || fitsS || !this.params.retriggersMayDeclare) {
          this.lastVerdict = { kind: 'absorbed', eventId: event.id };
          return null;
        }
        inShakingOf ??= event.id;
      }
    }

    this.pool.push({ ...pick, stationIndex, inShakingOf });
    const { candidates, mostStations } = this.locate(this.pool, this.pool.length - 1);
    if (candidates.length === 0) {
      this.lastVerdict = inShakingOf === null ? { kind: 'too-few', stations: mostStations } : { kind: 'absorbed', eventId: inShakingOf };
      return null;
    }

    // Try each candidate in rank order and declare the first that survives
    // every check. Testing only the top one let a junk cluster that happened to
    // fit a hair tighter fail the checks and block the real one beneath it —
    // measured on Ridgecrest's M6.4, where the right four stations were in the
    // pool ~2.5 s before the declaration finally came.
    let firstFailure: AssociationVerdict | null = null;
    for (const located of candidates) {
      const failure = this.check(located, readyThroughMs);
      if (failure === null) return this.declare(located, readyThroughMs);
      firstFailure ??= failure;
    }
    this.lastVerdict = firstFailure ?? { kind: 'too-few', stations: mostStations };
    return null;
  }

  /** Why this cluster may not be declared, or null if it may. */
  private check(located: Located, readyThroughMs: (channelId: string) => number | null): AssociationVerdict | null {
    const stations = located.members.length;
    const memberPicks = located.members.map((m) => this.pool[m] as PooledPick);
    const nearestKm = Math.min(
      ...memberPicks.map((p) => haversineKm(located, this.stations[p.stationIndex] as AssociatorStation)),
    );
    if (nearestKm > this.params.maxNearestStationKm) return { kind: 'too-far-outside', nearestKm };
    const shaking = new Set(memberPicks.flatMap((p) => (p.inShakingOf === null ? [] : [p.inShakingOf])));
    if (shaking.size > 0) {
      const near = this.events.filter(
        (e) => shaking.has(e.id) && haversineKm(located, e) <= this.params.sequenceRadiusKm,
      );
      if (near.length === 0) return { kind: 'not-in-sequence', stations };
      if (near.some((e) => located.originMs - e.originMs < this.params.minSequenceGapS * 1000)) {
        return { kind: 'duplicate', stations };
      }
    }
    if (!this.nearestReadyStationIsMember(located, memberPicks, readyThroughMs)) return { kind: 'nearest-silent', stations };
    const silent = this.missedStations(located, memberPicks, readyThroughMs).length;
    if (silent / (silent + stations) > this.params.maxMissFraction) return { kind: 'too-many-silent', stations, silent };
    return null;
  }

  private declare(located: Located, readyThroughMs: (channelId: string) => number | null): AssociatedEvent {
    const memberPicks = located.members.map((m) => this.pool[m] as PooledPick);
    const missed = this.missedStations(located, memberPicks, readyThroughMs);
    const event: AssociatedEvent = {
      id: this.nextId,
      originMs: located.originMs,
      latitude: located.latitude,
      longitude: located.longitude,
      picks: memberPicks.map(({ channelId, timeMs, ratio }) => ({ channelId, timeMs, ratio })),
      rmsS: located.rmsS,
      missedStations: missed,
    };
    this.nextId += 1;
    this.events.push(event);
    this.lastVerdict = { kind: 'declared', eventId: event.id };
    const memberSet = new Set(located.members);
    this.pool = this.pool.filter((_, index) => !memberSet.has(index));
    return event;
  }

  private expire(nowMs: number): void {
    const retentionMs = this.params.pickRetentionS * 1000;
    this.pool = this.pool.filter((p) => nowMs - p.timeMs <= retentionMs);
    // An event stops absorbing picks once its slowest possible S wave and coda
    // have crossed the whole search region; until then it must keep them, or
    // its own S arrivals would be offered as a new earthquake.
    const holdMs = (this.params.pickRetentionS + this.params.codaS) * 1000 * 2;
    this.events = this.events.filter((e) => nowMs - e.originMs <= holdMs);
  }

  /**
   * Candidate point sources for a set of picks that includes `picks[anchor]`,
   * best first: each a distinct set of at least `minStations` stations, ranked
   * by how many stations agree and then by the smaller misfit, each refined on
   * the fine grid. Also reports the most stations any node got to agree, for
   * the verdict when none reaches the minimum.
   *
   * **Anchored on the newest pick** because a declaration can only become
   * possible when a pick arrives — so the cluster worth testing is the one that
   * pick joins. Unanchored, the largest cluster anywhere in the pool won, and
   * on real data that was sometimes old noise rather than the quake in
   * progress.
   */
  locate(picks: readonly PooledPick[], anchor: number): { candidates: Located[]; mostStations: number } {
    const n = this.stations.length;
    let mostStations = 0;
    // Best node per distinct member set: many neighbouring nodes produce the
    // same cluster, and testing it once is enough.
    const bySet = new Map<string, Located>();
    for (let node = 0; node < this.nodeLat.length; node += 1) {
      const candidate = this.clusterAt(picks, anchor, (p) => this.nodeTravelS[node * n + p.stationIndex] as number);
      if (candidate === null) continue;
      mostStations = Math.max(mostStations, candidate.members.length);
      if (candidate.members.length < this.params.minStations) continue;
      const key = [...candidate.members].sort((a, b) => a - b).join(',');
      const located = { ...candidate, latitude: this.nodeLat[node] as number, longitude: this.nodeLon[node] as number };
      if (isBetter(located, bySet.get(key) ?? null)) bySet.set(key, located);
    }

    const ranked = [...bySet.values()].sort((a, b) => (isBetter(a, b) ? -1 : isBetter(b, a) ? 1 : 0));
    const candidates = ranked.slice(0, MAX_CANDIDATES).map((coarse) => this.refine(picks, anchor, coarse));
    return { candidates, mostStations };
  }

  /** Fine pass: a square one coarse step either side of a coarse winner. */
  private refine(picks: readonly PooledPick[], anchor: number, coarse: Located): Located {
    const { coarseGridKm, fineGridKm, pVelocityKmS } = this.params;
    const steps = Math.round(coarseGridKm / fineGridKm);
    const dLat = fineGridKm / KM_PER_DEGREE;
    const dLon = fineGridKm / (KM_PER_DEGREE * Math.cos((coarse.latitude * Math.PI) / 180));
    let best = coarse;
    for (let i = -steps; i <= steps; i += 1) {
      for (let j = -steps; j <= steps; j += 1) {
        const latitude = coarse.latitude + i * dLat;
        const longitude = coarse.longitude + j * dLon;
        const candidate = this.clusterAt(picks, anchor, (p) =>
          this.stationTravelS(this.stations[p.stationIndex] as AssociatorStation, latitude, longitude, pVelocityKmS),
        );
        if (candidate !== null && isBetter(candidate, best)) best = { ...candidate, latitude, longitude };
      }
    }
    return best;
  }

  /**
   * The largest set of picks, one per station and including the anchor, whose
   * implied origin times fall within a window twice the tolerance wide — found
   * by sorting the implied origins and sliding the window along them.
   */
  private clusterAt(
    picks: readonly PooledPick[],
    anchor: number,
    travelOf: (p: PooledPick) => number,
  ): Omit<Located, 'latitude' | 'longitude'> | null {
    const anchorPick = picks[anchor];
    if (anchorPick === undefined) return null;
    const widthMs = 2 * this.params.toleranceS * 1000;
    const anchorOriginMs = anchorPick.timeMs - travelOf(anchorPick) * 1000;
    const origins: { index: number; station: number; originMs: number }[] = [];
    picks.forEach((p, index) => {
      const originMs = p.timeMs - travelOf(p) * 1000;
      // Anything further than one window from the anchor cannot share one with it.
      if (Math.abs(originMs - anchorOriginMs) <= widthMs) origins.push({ index, station: p.stationIndex, originMs });
    });
    origins.sort((a, b) => a.originMs - b.originMs);

    let bestCount = 0;
    let bestStart = 0;
    let bestEnd = 0;
    let start = 0;
    let distinct = 0;
    const seen = this.stationSeen;
    // Per-station count within the window, held in `seen` (reset afterwards).
    seen.fill(0);
    for (let end = 0; end < origins.length; end += 1) {
      const added = origins[end] as (typeof origins)[number];
      if ((seen[added.station] as number) === 0) distinct += 1;
      seen[added.station] = (seen[added.station] as number) + 1;
      while ((added.originMs - (origins[start] as (typeof origins)[number]).originMs) > widthMs) {
        const removed = origins[start] as (typeof origins)[number];
        seen[removed.station] = (seen[removed.station] as number) - 1;
        if ((seen[removed.station] as number) === 0) distinct -= 1;
        start += 1;
      }
      const holdsAnchor =
        (origins[start] as (typeof origins)[number]).originMs <= anchorOriginMs && added.originMs >= anchorOriginMs;
      if (holdsAnchor && distinct > bestCount) {
        bestCount = distinct;
        bestStart = start;
        bestEnd = end;
      }
    }
    if (bestCount === 0) return null;

    // One pick per station: where a station has two in the window, keep the
    // one closest to the window's median — except the anchor's station, which
    // keeps the anchor, or the cluster would no longer be the one it joined.
    const window = origins.slice(bestStart, bestEnd + 1);
    const median = (window[Math.floor(window.length / 2)] as (typeof origins)[number]).originMs;
    const byStation = new Map<number, (typeof origins)[number]>();
    for (const o of window) {
      if (o.station === anchorPick.stationIndex) {
        if (o.index === anchor) byStation.set(o.station, o);
        continue;
      }
      const current = byStation.get(o.station);
      if (current === undefined || Math.abs(o.originMs - median) < Math.abs(current.originMs - median)) {
        byStation.set(o.station, o);
      }
    }
    const members = [...byStation.values()];
    // Some member must be within reach of this node — checked here, per
    // candidate, not just at declaration. Measured on Ridgecrest's M6.4: two
    // real picks from 30 km padded out with a noisy station's strays formed a
    // bigger cluster placed 120+ km away, which outranked the real cluster at
    // the right node, failed at declaration, and held the alert back ~5 s.
    const reachS = this.travelS(this.params.maxNearestStationKm, this.params.pVelocityKmS);
    if (!members.some((o) => travelOf(picks[o.index] as PooledPick) <= reachS)) return null;
    const mean = members.reduce((sum, o) => sum + o.originMs, 0) / members.length;
    const rmsS = Math.sqrt(members.reduce((sum, o) => sum + (o.originMs - mean) ** 2, 0) / members.length) / 1000;
    return { originMs: mean, members: members.map((o) => o.index), rmsS };
  }

  /**
   * The working station closest to the epicentre must be one of the members.
   *
   * The closest station is always among the first to hear a real quake. A fake
   * source fitted to a coincidence — found in tests, inside the network, on a
   * ring of stations that a fast distant P wave reached at similar times —
   * typically has a station near its centre that triggered at the wrong time
   * for it, or not at all. "Working" means data past its predicted arrival:
   * one still warming up, or behind, says nothing either way and is skipped.
   */
  private nearestReadyStationIsMember(
    located: Located,
    memberPicks: readonly PooledPick[],
    readyThroughMs: (channelId: string) => number | null,
  ): boolean {
    const { pVelocityKmS, toleranceS } = this.params;
    let nearest: AssociatorStation | null = null;
    let nearestKm = Number.POSITIVE_INFINITY;
    for (const station of this.stations) {
      const km = haversineKm(located, station);
      if (km >= nearestKm) continue;
      const isMember = memberPicks.some((p) => p.channelId === station.channelId);
      const through = readyThroughMs(station.channelId);
      const arrival = located.originMs + 1000 * this.stationTravelS(station, located.latitude, located.longitude, pVelocityKmS);
      if (!isMember && (through === null || through < arrival + toleranceS * 1000)) continue;
      nearest = station;
      nearestKm = km;
    }
    return nearest !== null && memberPicks.some((p) => p.channelId === nearest.channelId);
  }

  private missedStations(
    located: Located,
    memberPicks: readonly PooledPick[],
    readyThroughMs: (channelId: string) => number | null,
  ): string[] {
    const { pVelocityKmS, toleranceS } = this.params;
    const memberIds = new Set(memberPicks.map((p) => p.channelId));
    const farthestKm = Math.max(
      ...memberPicks.map((p) => haversineKm(located, this.stations[p.stationIndex] as AssociatorStation)),
    );
    const missed: string[] = [];
    for (const station of this.stations) {
      if (memberIds.has(station.channelId)) continue;
      if (haversineKm(located, station) > farthestKm) continue;
      const through = readyThroughMs(station.channelId);
      if (through === null) continue;
      const arrival =
        located.originMs + 1000 * this.stationTravelS(station, located.latitude, located.longitude, pVelocityKmS);
      // Silence only counts once the station's data reaches past the arrival
      // plus the tolerance — before that it simply hasn't been heard from yet.
      if (through >= arrival + toleranceS * 1000) missed.push(station.channelId);
    }
    return missed;
  }
}

function isBetter(candidate: Omit<Located, 'latitude' | 'longitude'>, best: Located | null): boolean {
  if (best === null) return true;
  if (candidate.members.length !== best.members.length) return candidate.members.length > best.members.length;
  return candidate.rmsS < best.rmsS;
}
