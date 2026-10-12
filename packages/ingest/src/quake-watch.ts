import {
  channelIdOf,
  detectorLimit,
  haversineKm,
  type QuakeWatchAlert,
  type WatchLimit,
  type WatchPin,
  type WaveformStation,
} from '@terra-pulse/schema';
import { velocityGainAt, type FdsnTextRow } from './fdsn-stations';
import {
  DEFAULT_ALERT_GEOMETRY,
  HomeAlerter,
  WATCH_ALERT_RULE,
  type AlertGeometry,
  type AlertRule,
} from './quake-alert';
import { DEFAULT_DETECTOR_PARAMS, QuakeDetector, type DetectorParams, type DetectorRecord, type QuakeDetection } from './quake-detector';
import { REPLAY_DETECTOR_RADIUS_KM, REPLAY_MIN_RATE_HZ } from './replay-run';
import { predictIntensity } from './shaking-intensity';

/**
 * The live watch's detector (§5.13): the same `QuakeDetector` the replay
 * script graded, fed records as they land from the ring, with the alert judged
 * at the pin. Pure and Electron-free, so main only wires sockets and windows to
 * it — the same split as `runDetectorReplay` and `quake-replay.ts`.
 */

/** The replay's listening radius and rate floor — what was measured to work. */
export const WATCH_RADIUS_KM = REPLAY_DETECTOR_RADIUS_KM;
export const WATCH_MIN_RATE_HZ = REPLAY_MIN_RATE_HZ;

/**
 * Most stations one watch streams. Burbank has 75 within 300 km and keeps them
 * all; the cap is for the few places with far more — measured on the ring
 * 2026-10-08, the densest 300 km circles hold **349** (around Mount St.
 * Helens, the volcano network), 201 (West Texas) and 150 (Oklahoma). One
 * connection carries 74 in 0.5 s with no measurable cost in latency, so this
 * is courtesy to a public server rather than a hard limit.
 */
export const WATCH_MAX_STATIONS = 100;

/**
 * The stations a watch at this pin listens to: every one ≥20 Hz within 300 km,
 * **thinned by spacing, never cut by distance**, when there are more than the
 * cap.
 *
 * Cutting to the nearest N was measured wrong for the replay: in a dense
 * network the nearest 80 all sit within ~100 km, where the S wave lands inside
 * the 10 s P window, and Ridgecrest M7.1 read **M6.0** — only the farther
 * stations could measure it. Nearest-N around a volcano would be worse still,
 * all of it one mountain. So instead: walk the stations nearest first and keep
 * one only if it is at least `spacing` km from every one already kept, with the
 * smallest spacing that fits the cap. The nearest station always survives
 * (which `too-far` depends on), and the far ring survives with it.
 */
export function watchNetwork(
  stations: readonly WaveformStation[],
  pin: { latitude: number; longitude: number },
  maxStations: number = WATCH_MAX_STATIONS,
): WaveformStation[] {
  const inRange = stations
    .filter((s) => s.sampleRateHz >= WATCH_MIN_RATE_HZ)
    .map((s) => ({ s, km: haversineKm(pin, s) }))
    .filter(({ km }) => km <= WATCH_RADIUS_KM)
    .sort((a, b) => a.km - b.km)
    .map(({ s }) => s);
  if (inRange.length <= maxStations) return inRange;

  const thin = (spacingKm: number): WaveformStation[] => {
    const kept: WaveformStation[] = [];
    for (const s of inRange) {
      if (kept.every((k) => haversineKm(k, s) >= spacingKm)) kept.push(s);
    }
    return kept;
  };
  // The kept count only falls as spacing grows, so a bisection finds the
  // smallest spacing that fits; 0.1 km is far finer than any station layout.
  let low = 0;
  let high = 2 * WATCH_RADIUS_KM;
  while (high - low > 0.1) {
    const mid = (low + high) / 2;
    if (thin(mid).length > maxStations) low = mid;
    else high = mid;
  }
  return thin(high);
}

export interface WatchReach {
  limit: WatchLimit;
  nearestKm: number | null;
}

/** Whether quakes near the pin are inside the detector's reach, by `detectorLimit`'s rules. */
export function watchReach(
  network: readonly WaveformStation[],
  pin: { latitude: number; longitude: number },
  params: DetectorParams = DEFAULT_DETECTOR_PARAMS,
): WatchReach {
  const nearestKm = network.length === 0 ? null : Math.min(...network.map((s) => haversineKm(pin, s)));
  const limit = detectorLimit({
    radiusKm: WATCH_RADIUS_KM,
    stations: network.length,
    stationsWithData: network.length,
    nearestKm,
    minStations: params.associator.minStations,
    maxNearestStationKm: params.associator.maxNearestStationKm,
  });
  return { limit, nearestKm };
}

/**
 * How long a declared quake is kept for its alert to be judged: past this its
 * magnitude cannot change (`QuakeDetector` closes it at 90 s) and nothing new
 * can raise an alert for it.
 */
const OPEN_MS = 120_000;

/** An updated alert is reported again only when its magnitude has moved this much. */
const UPDATE_STEP = 0.1;

export interface WatchPushResult {
  /** Quakes declared by this record. */
  declared: QuakeDetection[];
  /** Alerts raised for the first time. */
  raised: QuakeWatchAlert[];
  /** Alerts already raised whose magnitude has moved since last reported. */
  updated: QuakeWatchAlert[];
}

export interface LiveQuakeWatchInput {
  pin: WatchPin;
  network: readonly WaveformStation[];
  /** Channel epochs for the gains; null runs with no magnitude, so nothing can alert. */
  gains: readonly FdsnTextRow[] | null;
  /** The instant whose epochs apply — now, for a live watch. */
  gainAtMs: number;
  /** Prefixes alert ids, which must be unique across pins in one session. */
  idPrefix: string;
  rule?: AlertRule;
  geometry?: AlertGeometry;
  params?: DetectorParams;
}

export class LiveQuakeWatch {
  readonly pin: WatchPin;
  /** Stations with a gain, which can vote on magnitude. */
  readonly magnitudeStations: number;
  private readonly detector: QuakeDetector;
  private readonly alerter: HomeAlerter;
  private readonly idPrefix: string;
  private readonly open: QuakeDetection[] = [];
  private readonly reported = new Map<number, number>();
  private declaredCount = 0;

  constructor(input: LiveQuakeWatchInput) {
    this.pin = input.pin;
    this.idPrefix = input.idPrefix;
    const stations = input.network.map((s) => ({
      channelId: channelIdOf(s),
      latitude: s.latitude,
      longitude: s.longitude,
      velocityGain: input.gains === null ? null : velocityGainAt(input.gains, channelIdOf(s), input.gainAtMs),
    }));
    this.magnitudeStations = stations.filter((s) => s.velocityGain !== null && s.velocityGain > 0).length;
    this.detector = new QuakeDetector(stations, input.params ?? DEFAULT_DETECTOR_PARAMS);
    this.alerter = new HomeAlerter(input.pin, input.rule ?? WATCH_ALERT_RULE, input.geometry ?? DEFAULT_ALERT_GEOMETRY);
  }

  /** Quakes declared since this watch began. */
  get detections(): number {
    return this.declaredCount;
  }

  /** One record, as it lands. `arrivedAtMs` is the wall clock at arrival. */
  push(record: DetectorRecord, arrivedAtMs: number): WatchPushResult {
    const declared = this.detector.push(record, arrivedAtMs);
    this.declaredCount += declared.length;
    this.open.push(...declared);

    const raised: QuakeWatchAlert[] = [];
    const updated: QuakeWatchAlert[] = [];
    for (let i = this.open.length - 1; i >= 0; i -= 1) {
      const d = this.open[i] as QuakeDetection;
      if (arrivedAtMs - d.originMs > OPEN_MS) {
        this.open.splice(i, 1);
        this.reported.delete(d.id);
        continue;
      }
      const estimate = this.detector.magnitudeOf(d.id);
      const first = this.alerter.evaluate(d, estimate, arrivedAtMs);
      if (first !== null) {
        this.reported.set(d.id, first.magnitude);
        raised.push(this.toAlert(d, estimate?.stations.length ?? 0));
        continue;
      }
      const last = this.reported.get(d.id);
      const current = this.alerter.alertFor(d.id);
      if (last !== undefined && current !== null && Math.abs(current.magnitude - last) >= UPDATE_STEP) {
        this.reported.set(d.id, current.magnitude);
        updated.push(this.toAlert(d, estimate?.stations.length ?? 0));
      }
    }
    return { declared, raised, updated };
  }

  private toAlert(d: QuakeDetection, magnitudeStations: number): QuakeWatchAlert {
    const a = this.alerter.alertFor(d.id);
    if (a === null) throw new Error(`no alert for detection ${String(d.id)}`);
    return {
      id: `${this.idPrefix}-${String(d.id)}`,
      pin: { ...this.pin },
      alertedAtMs: a.alertedAtMs,
      originMs: d.originMs,
      latitude: d.latitude,
      longitude: d.longitude,
      epicentralKm: a.epicentralKm,
      sArrivalAtPinMs: a.sArrivalAtHomeMs,
      magnitude: a.magnitude,
      intensity: a.intensity,
      magnitudeStations,
    };
  }
}

/**
 * The made-up quake behind the chip's Test button (2026-10-08). The banner had
 * never been seen on screen, and the only other way to see it is a real quake,
 * so this is MyShake's test alert: a fake quake sent down the real path.
 *
 * Shaped like a typical real alert rather than a dramatic one, so what you see
 * is what a real alert looks like:
 * - **100 km from the pin**, declared **14 s after its origin** — the graded
 *   median. That leaves ~14 s of countdown, enough to watch it run.
 * - **M5.0, climbing to M5.4 after 3 s**, because a real estimate starts low
 *   and climbs (~0.3 low at declaration). The update goes out the way a real
 *   one does.
 * - Intensity comes from the same equation as a real alert. M5.0 at 100 km
 *   works out to about MMI 2.8, just over the 2.5 threshold.
 *
 * North-east is arbitrary. It only has to be a direction, so the banner gets
 * its usual "100 km NE of …".
 */
export const TEST_ALERT = {
  distanceKm: 100,
  bearingDeg: 45,
  magnitude: 5.0,
  climbedMagnitude: 5.4,
  climbAfterMs: 3_000,
  declaredAfterOriginMs: 14_000,
} as const;

/** The point `distanceKm` from `from` on a great circle at `bearingDeg`. */
function pointFrom(
  from: { latitude: number; longitude: number },
  distanceKm: number,
  bearingDeg: number,
): { latitude: number; longitude: number } {
  const rad = Math.PI / 180;
  const delta = distanceKm / 6371;
  const theta = bearingDeg * rad;
  const phi1 = from.latitude * rad;
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lambda2 =
    from.longitude * rad +
    Math.atan2(Math.sin(theta) * Math.sin(delta) * Math.cos(phi1), Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2));
  // Back into [-180, 180): a pin near the antimeridian would otherwise step out of range.
  const longitude = ((((lambda2 / rad + 180) % 360) + 360) % 360) - 180;
  return { latitude: phi2 / rad, longitude };
}

/** A test alert for this pin, raised now. */
export function testWatchAlert(
  pin: WatchPin,
  alertedAtMs: number,
  id: string,
  geometry: AlertGeometry = DEFAULT_ALERT_GEOMETRY,
): QuakeWatchAlert {
  const epicentre = pointFrom(pin, TEST_ALERT.distanceKm, TEST_ALERT.bearingDeg);
  const epicentralKm = haversineKm(pin, epicentre);
  const originMs = alertedAtMs - TEST_ALERT.declaredAfterOriginMs;
  const hypocentralKm = Math.hypot(epicentralKm, geometry.depthKm);
  return {
    id,
    pin: { ...pin },
    alertedAtMs,
    originMs,
    ...epicentre,
    epicentralKm,
    sArrivalAtPinMs: originMs + (1000 * hypocentralKm) / geometry.sVelocityKmS,
    magnitude: TEST_ALERT.magnitude,
    intensity: predictIntensity(TEST_ALERT.magnitude, hypocentralKm),
    magnitudeStations: 0,
    test: true,
  };
}

/** The same test alert with a climbed magnitude. Origin, place and countdown stay as they were. */
export function climbTestAlert(
  alert: QuakeWatchAlert,
  magnitude: number,
  geometry: AlertGeometry = DEFAULT_ALERT_GEOMETRY,
): QuakeWatchAlert {
  return {
    ...alert,
    magnitude,
    intensity: predictIntensity(magnitude, Math.hypot(alert.epicentralKm, geometry.depthKm)),
  };
}
