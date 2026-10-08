import type { WaveformSegment, WaveformStation } from './seismic-waveforms';

/**
 * Replaying a past earthquake (§5.13): what the stations around its epicentre
 * recorded, fetched from the permanent archive and played back with each record
 * released at the instant it could have reached us live — with the
 * early-warning detector listening to the ones close enough for it to use.
 *
 * **Centred on the quake, not on home.** It began as "what the stations around
 * Burbank heard", for M4.5+ within 250 km or M7+ anywhere; the user's call on
 * 2026-10-07 was any M5+ anywhere, to watch the quake unfold. No alert and no
 * home: a replay shows the progression, not a warning.
 */

/**
 * Home, until the home-location prompt exists (Phase 6). Read by the replay
 * script, whose grades, alerts and DYFI comparisons were all made against this
 * point. The app's replay no longer uses it.
 */
export const HOME_LOCATION = { latitude: 34.1808, longitude: -118.309, label: 'Burbank, CA' } as const;

/**
 * Any quake at or above this gets a Replay button, wherever it is — the
 * user's floor. Below it a replay is mostly a quiet network and a small blip.
 */
export const REPLAY_MIN_MAGNITUDE = 5;

/** Whether a quake gets a Replay button. */
export function replayEligible(quake: { magnitude: number }): boolean {
  return quake.magnitude >= REPLAY_MIN_MAGNITUDE;
}

/** What the renderer asks main to replay — the catalogue's account of the quake. */
export interface QuakeReplayRequest {
  eventId: string;
  originMs: number;
  latitude: number;
  longitude: number;
  magnitude: number;
  place: string;
}

/** A row on screen: a station, and where it sits from the epicentre. */
export interface ReplayRow extends WaveformStation {
  distanceKm: number;
  /** From the epicentre to the station, 0 = north, clockwise. */
  bearingDeg: number;
  /** Whether the detector was listening to it. Far rows are only watched. */
  listened: boolean;
}

/** A decoded record and the instant it would have reached us live. */
export interface ReplayArrival {
  segment: WaveformSegment;
  arrivedAtMs: number;
}

export interface ReplayPick {
  channelId: string;
  /** The onset, on the record's own clock. */
  timeMs: number;
  /** When the record carrying it would have arrived — before then, it was unknown. */
  arrivedAtMs: number;
}

export interface ReplayMagnitudeStep {
  /** The arrival that changed the estimate. */
  atMs: number;
  magnitude: number;
  /** Stations voting on it. */
  stations: number;
  /** Every voting station's window is full; it will not climb further. */
  complete: boolean;
}

/** The detector's declaration of the replayed quake. */
export interface ReplayDetection {
  declaredAtMs: number;
  originMs: number;
  latitude: number;
  longitude: number;
  /** Detector's epicentre against the catalogue's. */
  locationErrorKm: number;
  /** Detector's origin minus the catalogue's, seconds. */
  originErrorS: number;
  /** Stations whose picks the declaration rested on. */
  stationsAtDeclaration: number;
  magnitudeSteps: ReplayMagnitudeStep[];
}

/**
 * The stations the detector listened to, and whether it could have declared
 * this quake from them at all. Most of the world's M5+ quakes are too far from
 * any public station for it to: measured over 5,137 of them (2024-2026), only
 * 13% had four stations within 300 km.
 */
export interface ReplayDetectorReach {
  /** Its listening radius around the epicentre. */
  radiusKm: number;
  /** Stations inside it, and how many of those had archived data. */
  stations: number;
  stationsWithData: number;
  /** Nearest station with data, or null when none had any. */
  nearestKm: number | null;
  /** Stations that must agree before it declares. */
  minStations: number;
  /** It only locates quakes within this distance of a station. */
  maxNearestStationKm: number;
}

export interface QuakeReplay {
  request: QuakeReplayRequest;
  windowStartMs: number;
  windowEndMs: number;
  detector: ReplayDetectorReach;
  /** Records that would not decode. */
  badRecords: number;
  /** Nearest stations first, so the P wave sweeps down the panel. */
  rows: ReplayRow[];
  /** Records for the rows on screen only, in arrival order. */
  arrivals: ReplayArrival[];
  /** Every pick on the rows on screen, in arrival order. */
  picks: ReplayPick[];
  /** Null: the detector never declared this quake. */
  detection: ReplayDetection | null;
  /**
   * Everything else it declared in the window, in order: false alarms, other
   * quakes — or, offshore, this quake placed near the stations, too far from
   * the catalogue's epicentre to count as found. Shown with where it was placed,
   * so the reader can judge which.
   */
  otherDetections: ReplayOtherDetection[];
}

export interface ReplayOtherDetection {
  declaredAtMs: number;
  originMs: number;
  latitude: number;
  longitude: number;
  /** From the replayed quake's catalogue epicentre. */
  distanceKm: number;
}

/**
 * What stops the detector from catching this quake, if anything:
 * - `too-few-stations`: fewer with data within its radius than must agree, so
 *   it can declare nothing at all;
 * - `too-far`: enough stations, but none within the distance it searches for a
 *   source, so at best it places the quake near them (an offshore quake behind
 *   a dense coast).
 */
export function detectorLimit(reach: ReplayDetectorReach): 'too-few-stations' | 'too-far' | null {
  if (reach.stationsWithData < reach.minStations) return 'too-few-stations';
  if (reach.nearestKm === null || reach.nearestKm > reach.maxNearestStationKm) return 'too-far';
  return null;
}

/** Pushed while a replay loads: the slow parts are the archive requests. */
export interface QuakeReplayProgress {
  eventId: string;
  phase: 'stations' | 'gains' | 'waveforms' | 'detector';
  done: number;
  total: number;
}
