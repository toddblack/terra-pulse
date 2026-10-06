import { haversineKm } from './aftershocks';
import type { WaveformSegment, WaveformStation } from './seismic-waveforms';

/**
 * Replaying a past earthquake through the early-warning detector (§5.13): the
 * archived records the home network recorded, fed to the same detector, the
 * same magnitude and the same home alert the replay script grades — so the app
 * shows what live would have done, released at the instant each record could
 * have reached us.
 */

/**
 * Home, until the home-location prompt exists (Phase 6). One definition for
 * main, the renderer and the replay script: every grade, alert and DYFI
 * comparison so far was made against this point.
 */
export const HOME_LOCATION = { latitude: 34.1808, longitude: -118.309, label: 'Burbank, CA' } as const;

/** A local replay: within this distance of home. Past it, only great quakes. */
export const REPLAY_LOCAL_RADIUS_KM = 250;
/**
 * The user's floor for a local replay — "only large quakes, probably 4.5+".
 * Below it a replay is mostly a quiet network and a small blip.
 */
export const REPLAY_LOCAL_MIN_MAGNITUDE = 4.5;
/**
 * Distant replays are for great quakes only: "what your home network heard".
 * The interesting answer is that the detector stays quiet — distant P waves
 * have lost the high frequencies it listens for.
 */
export const REPLAY_DISTANT_MIN_MAGNITUDE = 7;

export type ReplayKind = 'local' | 'distant';

export type ReplayEligibility = { eligible: true; kind: ReplayKind; homeKm: number } | { eligible: false; homeKm: number };

/** Whether a quake gets a Replay button, and which kind of replay it would be. */
export function replayEligibility(
  quake: { latitude: number; longitude: number; magnitude: number },
  home: { latitude: number; longitude: number } = HOME_LOCATION,
): ReplayEligibility {
  const homeKm = haversineKm(quake, home);
  if (homeKm <= REPLAY_LOCAL_RADIUS_KM) {
    return quake.magnitude >= REPLAY_LOCAL_MIN_MAGNITUDE ? { eligible: true, kind: 'local', homeKm } : { eligible: false, homeKm };
  }
  return quake.magnitude >= REPLAY_DISTANT_MIN_MAGNITUDE ? { eligible: true, kind: 'distant', homeKm } : { eligible: false, homeKm };
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
  /** Predicted MMI at home from this estimate and the detector's location. */
  intensityAtHome: number;
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

export interface ReplayAlert {
  alertedAtMs: number;
  /** When the detector expected strong (S-wave) shaking at home. */
  sArrivalAtHomeMs: number;
  magnitude: number;
  /** Predicted MMI at home. */
  intensity: number;
}

export interface QuakeReplay {
  request: QuakeReplayRequest;
  kind: ReplayKind;
  windowStartMs: number;
  windowEndMs: number;
  home: { latitude: number; longitude: number; label: string };
  homeKm: number;
  /** From the catalogue's origin and place, with the detector's own velocities. */
  pArrivalAtHomeMs: number;
  /** Null for a distant quake: crustal speeds don't apply across the mantle. */
  sArrivalAtHomeMs: number | null;
  /** The speeds and depth the detector assumes, for drawing the wavefronts. */
  geometry: { depthKm: number; pVelocityKmS: number; sVelocityKmS: number };
  /** How many stations the detector listened through, and how many had data. */
  networkSize: number;
  stationsWithData: number;
  /** Records that would not decode. */
  badRecords: number;
  rows: ReplayRow[];
  /** Records for the rows on screen only, in arrival order. */
  arrivals: ReplayArrival[];
  /** Every pick on the rows on screen, in arrival order. */
  picks: ReplayPick[];
  /** Null: the detector never declared this quake. */
  detection: ReplayDetection | null;
  /** Null: it was declared but the predicted shaking at home stayed below the threshold. */
  alert: ReplayAlert | null;
  /** The alert threshold the replay ran with (predicted MMI at home). */
  alertThreshold: number;
  /** Predicted MMI at home from the final estimate — what "no alert" was weighed on. */
  finalIntensityAtHome: number | null;
  /** Other declarations in the window: false alarms, or other quakes. */
  otherDeclarations: number;
}

/** Pushed while a replay loads: the slow parts are the archive requests. */
export interface QuakeReplayProgress {
  eventId: string;
  phase: 'stations' | 'gains' | 'waveforms' | 'detector';
  done: number;
  total: number;
}
