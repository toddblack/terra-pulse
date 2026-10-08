/**
 * The live watch (§5.13): one pin on the globe, the stations around it streamed
 * through the early-warning detector for as long as the app is open, and an
 * alert when a quake large enough to matter is predicted to be felt at the pin.
 *
 * The user's design, 2026-10-07/08:
 * - **one pin**, dropped from the location panel or the quake inspector; it
 *   stays put while the globe is browsed, and is remembered across launches;
 * - **no pin on first launch** — nothing is watched until someone asks;
 * - **Stop removes the pin.** One state: a pin on the globe means it is
 *   watching, and there is no paused-but-present pin to misread;
 * - the alert is M4.5+ *and* felt at the pin (`WATCH_ALERT_RULE` in ingest).
 *
 * Main holds all of it; the renderer only shows status and alerts.
 */

export interface WatchPin {
  latitude: number;
  longitude: number;
  /** What the reader picked — a place name, or the coordinate when there is none. */
  label: string;
}

/** Labels are shown in chrome and notifications; anything longer is truncated. */
export const WATCH_PIN_LABEL_MAX = 120;

/** A pin from the renderer or from storage, checked; null if it is not one. */
export function parseWatchPin(raw: unknown): WatchPin | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const { latitude, longitude, label } = r;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90) return null;
  if (typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return null;
  if (typeof label !== 'string') return null;
  return { latitude, longitude, label: label.slice(0, WATCH_PIN_LABEL_MAX) };
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'] as const;

/** The Roman numeral for a continuous MMI: rounded to the nearest level, clamped I-X. */
export function intensityNumeral(mmi: number): string {
  const index = Math.min(ROMAN.length, Math.max(1, Math.round(mmi))) - 1;
  return ROMAN[index] as string;
}

/** "34.18°N 118.31°W" — the label for a spot with no name. */
export function coordinateLabel(point: { latitude: number; longitude: number }): string {
  const lat = `${Math.abs(point.latitude).toFixed(2)}°${point.latitude >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(point.longitude).toFixed(2)}°${point.longitude >= 0 ? 'E' : 'W'}`;
  return `${lat} ${lon}`;
}

/**
 * Why a pin can or cannot be watched — `detectorLimit` measured from the pin
 * rather than from an epicentre:
 * - `too-few-stations`: fewer public stations within the radius than must
 *   agree, so the detector can declare nothing at all;
 * - `too-far`: enough stations, but none within the distance it searches for a
 *   source, so quakes *at* the pin are out of its reach — it can catch only
 *   quakes near the stations, which may still shake the pin if large;
 * - null: quakes near the pin are inside its reach.
 */
export type WatchLimit = 'too-few-stations' | 'too-far' | null;

export interface QuakeWatchStatus {
  pin: WatchPin | null;
  /**
   * - `off`: no pin;
   * - `starting`: fetching the station list and gains;
   * - `watching`: streaming (see `connected` for whether data is flowing now);
   * - `unavailable`: a pin, but it cannot run — no station list, or nothing on
   *   the ring near it. `reason` says which.
   */
  state: 'off' | 'starting' | 'watching' | 'unavailable';
  reason: string | null;
  limit: WatchLimit;
  /** Stations the detector listens to. */
  stations: number;
  /** Of those, delivering data now. */
  liveStations: number;
  /** Of those, with a gain — able to vote on magnitude. */
  magnitudeStations: number;
  /** Nearest listened station to the pin, km. */
  nearestKm: number | null;
  connected: boolean;
  /** Consecutive reconnects since data last flowed. */
  retries: number;
  /** Quakes declared since the pin was dropped — reassurance that it is listening. */
  detections: number;
}

export const WATCH_STATUS_OFF: QuakeWatchStatus = {
  pin: null,
  state: 'off',
  reason: null,
  limit: null,
  stations: 0,
  liveStations: 0,
  magnitudeStations: 0,
  nearestKm: null,
  connected: false,
  retries: 0,
  detections: 0,
};

/**
 * An alert, raised once per quake and then updated in place as the running
 * magnitude climbs (it latches: it is never withdrawn).
 */
export interface QuakeWatchAlert {
  /** Unique across the session; a detector id is only unique within one pin. */
  id: string;
  pin: WatchPin;
  alertedAtMs: number;
  /** The detector's origin and epicentre. */
  originMs: number;
  latitude: number;
  longitude: number;
  /** From the pin. */
  epicentralKm: number;
  /** When the S wave — the strong shaking — is expected at the pin. */
  sArrivalAtPinMs: number;
  /** Latest values. */
  magnitude: number;
  intensity: number;
  /** Stations voting on the magnitude. */
  magnitudeStations: number;
}
