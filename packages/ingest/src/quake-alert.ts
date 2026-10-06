import { HOME_LOCATION, haversineKm } from '@terra-pulse/schema';
import type { MagnitudeEstimate } from './quake-magnitude';
import { predictIntensity } from './shaking-intensity';

/**
 * The early-warning decision: alert when the shaking predicted *at home*
 * reaches a threshold, from the detector's location and running magnitude.
 *
 * **It latches.** The magnitude is a running estimate and its mean can dip as
 * a station joins with a short window; an alert that followed it down would
 * un-warn someone mid-quake. Once an event has alerted it stays alerted, and
 * later estimates only update what the alert says.
 *
 * Nothing here is a registered analysis parameter: the threshold is a
 * preference about when to be interrupted, the same footing as the large-event
 * banner's M5.8.
 */

export interface AlertRule {
  /** Predicted MMI at home that triggers an alert. */
  minIntensity: number;
}

/**
 * **2.5 — anything that rounds to MMI III**, MyShake's level ("weak shaking,
 * felt indoors"). Provisional: the user's call. Swept on the replay's tuning
 * set, each row graded against what Burbank reported to DYFI at the same level:
 *
 *   threshold  alerts  agree  missed  extra   Ridgecrest M6.4 / M7.1 warning
 *   2.5        7       6      1       1       35.8 / 40.5 s
 *   3.0        5       2      0       3       35.8 / 40.5 s
 *   3.5        3       2      0       1       23.0 / 34.4 s
 *
 * The extra alerts at 3.0 are all M5+ quakes whose magnitude ran 0.3-0.6 high
 * (Searles M5.5 read 5.9) — with catalogue magnitudes the intensity equation
 * matches Burbank's reports. A higher threshold also alerts *later*, since the
 * climbing estimate needs longer to reach it. No threshold produced an alert
 * in the distant-quake or random-hour sets.
 */
export const DEFAULT_ALERT_RULE: AlertRule = { minIntensity: 2.5 };

export interface HomeLocation {
  latitude: number;
  longitude: number;
}

/**
 * Home, until the home-location prompt exists (Phase 6). Defined once in
 * `@terra-pulse/schema` (`HOME_LOCATION`) so the script, main and the renderer
 * all read the same point every grade so far was made against.
 */
export const DEFAULT_HOME: HomeLocation = { latitude: HOME_LOCATION.latitude, longitude: HOME_LOCATION.longitude };
export const DEFAULT_HOME_LABEL: string = HOME_LOCATION.label;

export interface AlertGeometry {
  /** The detector's assumed source depth, km. */
  depthKm: number;
  /** For when strong shaking reaches home. */
  sVelocityKmS: number;
}

/**
 * The geometry every graded replay used: a fixed 8 km source and a 3.6 km/s S
 * wave. Shared so the app's replay predicts shaking at home exactly as the
 * graded runs did, not with a second set of numbers that happens to agree.
 */
export const DEFAULT_ALERT_GEOMETRY: AlertGeometry = { depthKm: 8, sVelocityKmS: 3.6 };

export interface HomeAlert {
  eventId: number;
  /** When the threshold was first crossed. */
  alertedAtMs: number;
  /** When the S wave — the strong shaking — is expected at home. */
  sArrivalAtHomeMs: number;
  epicentralKm: number;
  /** Latest values; they keep updating after the alert. */
  magnitude: number;
  intensity: number;
}

export interface AlertableEvent {
  id: number;
  originMs: number;
  latitude: number;
  longitude: number;
}

export class HomeAlerter {
  private readonly alerts = new Map<number, HomeAlert>();

  constructor(
    private readonly home: HomeLocation,
    private readonly rule: AlertRule,
    private readonly geometry: AlertGeometry,
  ) {}

  /** Predicted MMI at home for an event of this magnitude at this place. */
  intensityAtHome(event: Pick<AlertableEvent, 'latitude' | 'longitude'>, magnitude: number): number {
    const epicentralKm = haversineKm(this.home, event);
    return predictIntensity(magnitude, Math.hypot(epicentralKm, this.geometry.depthKm));
  }

  /**
   * Offers the event's current estimate. Returns the alert the first time the
   * threshold is crossed, and null otherwise — including on every later call
   * for an event already alerted, whose stored alert is updated in place.
   */
  evaluate(event: AlertableEvent, estimate: MagnitudeEstimate | null, nowMs: number): HomeAlert | null {
    if (estimate === null) return null;
    const intensity = this.intensityAtHome(event, estimate.magnitude);
    const existing = this.alerts.get(event.id);
    if (existing !== undefined) {
      existing.magnitude = estimate.magnitude;
      existing.intensity = intensity;
      return null;
    }
    if (intensity < this.rule.minIntensity) return null;

    const epicentralKm = haversineKm(this.home, event);
    const alert: HomeAlert = {
      eventId: event.id,
      alertedAtMs: nowMs,
      sArrivalAtHomeMs: event.originMs + (1000 * Math.hypot(epicentralKm, this.geometry.depthKm)) / this.geometry.sVelocityKmS,
      epicentralKm,
      magnitude: estimate.magnitude,
      intensity,
    };
    this.alerts.set(event.id, alert);
    return alert;
  }

  alertFor(eventId: number): HomeAlert | null {
    return this.alerts.get(eventId) ?? null;
  }
}
