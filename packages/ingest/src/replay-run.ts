import {
  bearingDeg,
  channelIdOf,
  haversineKm,
  type QuakeReplay,
  type QuakeReplayRequest,
  type ReplayKind,
  type ReplayRow,
  type WaveformStation,
} from '@terra-pulse/schema';
import { arrivalOrder, asLiveRecords, gradeDetections, teleseismicPSeconds, type ArrivingRecord } from './detector-replay';
import { velocityGainAt, type FdsnTextRow } from './fdsn-stations';
import { parseMiniSeedRecord, splitMiniSeedRecords, type MiniSeedDataRecord } from './miniseed';
import {
  DEFAULT_ALERT_GEOMETRY,
  DEFAULT_ALERT_RULE,
  HomeAlerter,
  type AlertGeometry,
  type AlertRule,
  type HomeAlert,
  type HomeLocation,
} from './quake-alert';
import type { AssociationVerdict } from './quake-associator';
import { DEFAULT_DETECTOR_PARAMS, QuakeDetector, type DetectorParams, type QuakeDetection } from './quake-detector';
import type { MagnitudeEstimate } from './quake-magnitude';
import type { Pick } from './quake-picker';

/**
 * One replay of archived waveforms through the detector, the magnitude and the
 * home alert — shared by `scripts/replay-detector.ts`, which grades it, and the
 * app, which shows it. Lifted out of the script unchanged in behaviour, and
 * checked that way: the script's tuning and reference summaries are identical
 * before and after. Two copies of this loop would drift, and the app would then
 * be showing a detector that was never graded.
 */

/** Stations the detector listens to: what can hear a quake that matters at home. */
export const HOME_NETWORK_RADIUS_KM = 300;

/**
 * 100 Hz only. Slower channels pack 2.5-5 s per record even in strong shaking,
 * which is too slow to be among the first stations an alert waits on.
 */
export const HOME_NETWORK_MIN_RATE_HZ = 100;

/** The stations a home-centred detector listens through, from the ring's catalogue. */
export function homeNetwork(stations: readonly WaveformStation[], home: HomeLocation): WaveformStation[] {
  return stations.filter(
    (s) => s.sampleRateHz >= HOME_NETWORK_MIN_RATE_HZ && haversineKm(s, home) <= HOME_NETWORK_RADIUS_KM,
  );
}

export interface DetectorReplayPick extends Pick {
  /** When the record carrying the pick would have reached us live. */
  arrivedAtMs: number;
}

export interface MagnitudeStep {
  /** The arrival that changed the estimate. */
  atMs: number;
  estimate: MagnitudeEstimate;
}

export interface DetectorReplayInput {
  /** Raw miniSEED as fetched: concatenated records, in any number of blocks. */
  chunks: readonly Uint8Array[];
  stations: readonly WaveformStation[];
  /** Channel epochs for the gains; null runs the detector with no magnitude. */
  gains: readonly FdsnTextRow[] | null;
  /** The instant whose channel epochs apply — sensors get swapped. */
  gainAtMs: number;
  home: HomeLocation;
  rule?: AlertRule;
  geometry?: AlertGeometry;
  params?: DetectorParams;
  /** Every pick with the associator's verdict, for tracing. */
  onPick?: (pick: Pick, arrivedAtMs: number, verdict: AssociationVerdict) => void;
}

export interface DetectorReplayResult {
  /** Decoded data records, re-cut to live size, in the order they would have arrived. */
  records: ArrivingRecord[];
  /** Records that would not decode; counted, never guessed at. */
  badRecords: number;
  detections: QuakeDetection[];
  /** Every detection's magnitude, one entry per change. */
  estimates: Map<number, MagnitudeStep[]>;
  /** Every alert as it was raised — a false detection's included. */
  alerts: HomeAlert[];
  picks: DetectorReplayPick[];
  /** For `alertFor(id)`: an alert keeps updating after it is raised. */
  alerter: HomeAlerter;
}

export function runDetectorReplay(input: DetectorReplayInput): DetectorReplayResult {
  const records: MiniSeedDataRecord[] = [];
  let badRecords = 0;
  for (const bytes of input.chunks) {
    for (const raw of splitMiniSeedRecords(bytes)) {
      try {
        const r = parseMiniSeedRecord(raw);
        // Archive packaging is not always live packaging; see asLiveRecords.
        if (r.kind === 'data') records.push(...asLiveRecords(r, raw.byteLength));
      } catch {
        badRecords += 1;
      }
    }
  }

  const detector = new QuakeDetector(
    input.stations.map((s) => ({
      channelId: channelIdOf(s),
      latitude: s.latitude,
      longitude: s.longitude,
      velocityGain: input.gains === null ? null : velocityGainAt(input.gains, channelIdOf(s), input.gainAtMs),
    })),
    input.params ?? DEFAULT_DETECTOR_PARAMS,
  );
  const picks: DetectorReplayPick[] = [];
  detector.onPick = (pick, arrivedAtMs, verdict) => {
    picks.push({ ...pick, arrivedAtMs });
    input.onPick?.(pick, arrivedAtMs, verdict);
  };

  // Every detection's estimate, recorded each time it changes, so a grade can
  // say what was known at declaration and how far it climbed after.
  const detections: QuakeDetection[] = [];
  const estimates = new Map<number, MagnitudeStep[]>();
  const alerter = new HomeAlerter(input.home, input.rule ?? DEFAULT_ALERT_RULE, input.geometry ?? DEFAULT_ALERT_GEOMETRY);
  const alerts: HomeAlert[] = [];
  const arriving = arrivalOrder(records);
  for (const { record, arrivedAtMs } of arriving) {
    detections.push(...detector.push(record, arrivedAtMs));
    for (const d of detections) {
      const estimate = detector.magnitudeOf(d.id);
      const alert = alerter.evaluate(d, estimate, arrivedAtMs);
      if (alert !== null) alerts.push(alert);
      if (estimate === null) continue;
      const steps = estimates.get(d.id) ?? [];
      const last = steps[steps.length - 1];
      if (last?.estimate.magnitude !== estimate.magnitude || last.estimate.complete !== estimate.complete) {
        steps.push({ atMs: arrivedAtMs, estimate });
      }
      estimates.set(d.id, steps);
    }
  }

  return { records: arriving, badRecords, detections, estimates, alerts, picks, alerter };
}

// ---------------------------------------------------------------------------
// The app's replay: which window, which rows, and what to hand the renderer.
// Pure, so every choice is a test; main only fetches.
// ---------------------------------------------------------------------------

/**
 * Lead before the first arrival of interest, and how long after it — **the
 * window every graded case used** (60 s lead, 180 s in all), and it has to be.
 *
 * A first version led by 30 s, and Ridgecrest M7.1 came back declared 11.5 s
 * *before* its origin, from four picks in the lead-in, unmatched to the quake.
 * The picker's 20 s LTA warms up on whatever it is given: 30 s of lead left it
 * a 20 s baseline taken minutes into the M5.4 foreshock's aftershocks, and the
 * next small one tripped four stations at once. With the graded 60 s the same
 * replay matches what the script measured. A replay is only worth watching if
 * it runs the detector under the conditions that were graded.
 */
export const REPLAY_LEAD_MS = 60_000;
export const REPLAY_FOLLOW_MS = 120_000;
/** Rows on screen: the cap the live view uses. */
export const REPLAY_ROWS = 10;
/**
 * How far before its predicted P arrival a station's pick may still count as
 * the quake: the detector's single velocity and fixed depth are approximate,
 * and so is a catalogue origin. Anything earlier is something else.
 */
export const REPLAY_PICK_GRACE_MS = 3_000;

/** The P wave's arrival at home, from the catalogue's origin and place. */
export function pArrivalAtHomeMs(
  request: QuakeReplayRequest,
  home: HomeLocation,
  kind: ReplayKind,
  depthKm: number,
  pVelocityKmS: number,
): number {
  const homeKm = haversineKm(request, home);
  if (kind === 'distant') return request.originMs + 1000 * teleseismicPSeconds(homeKm / 111.19);
  return request.originMs + (1000 * Math.hypot(homeKm, depthKm)) / pVelocityKmS;
}

/**
 * What a replay fetches. Local: from 30 s before the origin, so the rows open
 * on quiet ground. Distant: aimed at the P wave's arrival at home — the origin
 * is minutes earlier and thousands of kilometres away, and a window starting
 * there would show three minutes of nothing.
 */
export function replayWindow(
  request: QuakeReplayRequest,
  kind: ReplayKind,
  homePArrivalMs: number,
): { startMs: number; endMs: number } {
  const anchor = kind === 'local' ? request.originMs : homePArrivalMs;
  return { startMs: anchor - REPLAY_LEAD_MS, endMs: anchor + REPLAY_FOLLOW_MS };
}

/**
 * The rows: **the first stations to trigger**, in trigger order — so the P wave
 * visibly sweeps down the panel and the detector can be watched counting to
 * four. Fewer than `count` triggered (a small or distant quake): the rest are
 * the nearest to the epicentre, so the panel is never short of rows.
 *
 * Ordered by onset, not by arrival: the onset is when the ground moved there,
 * which is what the sweep down the rows should show.
 *
 * **A pick counts only from that station's predicted P arrival** (less a
 * grace). Measured on Ridgecrest M7.1: a station 179 km out triggered 0.3 s
 * *before* the origin — a noisy site, ~29 s ahead of any wave from the quake —
 * and a bare "after the origin" rule ranked it third, ahead of stations that
 * heard the quake. Its row then shows a pick that means nothing.
 */
export function chooseReplayRows(
  picks: readonly { channelId: string; timeMs: number }[],
  network: readonly WaveformStation[],
  epicentre: { latitude: number; longitude: number },
  earliestPickMs: (station: WaveformStation) => number,
  count = REPLAY_ROWS,
  /**
   * Filler rows prefer stations that recorded anything: today's network is
   * not the network of the day replayed — Tohoku 2011 found 9 of 74 with data
   * — and a row of nothing would take a place from a row of something.
   */
  hasData: (channelId: string) => boolean = () => true,
): ReplayRow[] {
  const byId = new Map(network.map((s) => [channelIdOf(s), s]));
  const firstPick = new Map<string, number>();
  for (const pick of picks) {
    const station = byId.get(pick.channelId);
    if (station === undefined || pick.timeMs < earliestPickMs(station)) continue;
    const seen = firstPick.get(pick.channelId);
    if (seen === undefined || pick.timeMs < seen) firstPick.set(pick.channelId, pick.timeMs);
  }
  const chosen = [...firstPick.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id).slice(0, count);

  const rest = network
    .filter((s) => !chosen.includes(channelIdOf(s)))
    .sort(
      (a, b) =>
        Number(hasData(channelIdOf(b))) - Number(hasData(channelIdOf(a))) ||
        haversineKm(epicentre, a) - haversineKm(epicentre, b),
    )
    .slice(0, Math.max(0, count - chosen.length))
    .map(channelIdOf);

  return [...chosen, ...rest].flatMap((id) => {
    const s = byId.get(id);
    return s === undefined ? [] : [{ ...s, distanceKm: haversineKm(epicentre, s), bearingDeg: bearingDeg(epicentre, s) }];
  });
}

export interface QuakeReplayInput {
  request: QuakeReplayRequest;
  kind: ReplayKind;
  home: HomeLocation & { label: string };
  network: readonly WaveformStation[];
  window: { startMs: number; endMs: number };
  result: DetectorReplayResult;
  rule?: AlertRule;
  geometry?: AlertGeometry;
  params?: DetectorParams;
}

/**
 * Everything the renderer needs to play a replay back, from one detector run.
 *
 * The rows' samples are **copied out of their records**. A record re-cut by
 * `asLiveRecords` is a *view* onto the archive record's larger sample array,
 * and structured clone copies a view's whole underlying buffer — sending the
 * views as they are would ship each 4096-byte archive record up to eight times
 * over.
 */
export function buildQuakeReplay(input: QuakeReplayInput): QuakeReplay {
  const { request, kind, home, network, window, result } = input;
  const rule = input.rule ?? DEFAULT_ALERT_RULE;
  const geometry = input.geometry ?? DEFAULT_ALERT_GEOMETRY;
  const pVelocityKmS = (input.params ?? DEFAULT_DETECTOR_PARAMS).associator.pVelocityKmS;
  const homeKm = haversineKm(request, home);

  const grade = gradeDetections(result.detections, [
    { id: request.eventId, originMs: request.originMs, latitude: request.latitude, longitude: request.longitude, magnitude: request.magnitude },
  ]);
  const match = grade.matched[0] ?? null;
  const steps = match === null ? [] : (result.estimates.get(match.detection.id) ?? []);
  const lastStep = steps[steps.length - 1];
  const alert = match === null ? null : result.alerter.alertFor(match.detection.id);

  // For a distant quake the window is aimed at the P wave reaching home, and
  // every home station is about as far from the source, so that arrival is the
  // floor for all of them.
  const homeP = pArrivalAtHomeMs(request, home, kind, geometry.depthKm, pVelocityKmS);
  const earliestPickMs = (s: WaveformStation) =>
    (kind === 'distant'
      ? homeP
      : request.originMs + (1000 * Math.hypot(haversineKm(request, s), geometry.depthKm)) / pVelocityKmS) -
    REPLAY_PICK_GRACE_MS;
  const withData = new Set(result.records.map((r) => r.record.channelId));
  const rows = chooseReplayRows(result.picks, network, request, earliestPickMs, REPLAY_ROWS, (id) => withData.has(id));
  const onRows = new Set(rows.map(channelIdOf));

  return {
    request,
    kind,
    windowStartMs: window.startMs,
    windowEndMs: window.endMs,
    home: { latitude: home.latitude, longitude: home.longitude, label: home.label },
    homeKm,
    pArrivalAtHomeMs: homeP,
    // No S time for a distant quake: crustal speeds do not apply across the
    // mantle, and nothing here needs a teleseismic S.
    sArrivalAtHomeMs: kind === 'local' ? request.originMs + (1000 * Math.hypot(homeKm, geometry.depthKm)) / geometry.sVelocityKmS : null,
    geometry: { depthKm: geometry.depthKm, pVelocityKmS, sVelocityKmS: geometry.sVelocityKmS },
    networkSize: network.length,
    stationsWithData: withData.size,
    badRecords: result.badRecords,
    rows,
    arrivals: result.records
      .filter((r) => onRows.has(r.record.channelId))
      .map(({ record, arrivedAtMs }) => ({
        segment: {
          channelId: record.channelId,
          startTimeMs: record.startTimeMs,
          sampleRateHz: record.sampleRateHz,
          samples: Int32Array.from(record.samples),
        },
        arrivedAtMs,
      })),
    picks: result.picks
      .filter((p) => onRows.has(p.channelId))
      .map((p) => ({ channelId: p.channelId, timeMs: p.timeMs, arrivedAtMs: p.arrivedAtMs })),
    detection:
      match === null
        ? null
        : {
            declaredAtMs: match.detection.declaredAtMs,
            originMs: match.detection.originMs,
            latitude: match.detection.latitude,
            longitude: match.detection.longitude,
            locationErrorKm: match.locationErrorKm,
            originErrorS: match.originErrorS,
            stationsAtDeclaration: new Set(match.detection.picks.map((p) => p.channelId)).size,
            magnitudeSteps: steps.map(({ atMs, estimate }) => ({
              atMs,
              magnitude: estimate.magnitude,
              stations: estimate.stations.length,
              complete: estimate.complete,
              intensityAtHome: result.alerter.intensityAtHome(match.detection, estimate.magnitude),
            })),
          },
    alert:
      alert === null
        ? null
        : { alertedAtMs: alert.alertedAtMs, sArrivalAtHomeMs: alert.sArrivalAtHomeMs, magnitude: alert.magnitude, intensity: alert.intensity },
    alertThreshold: rule.minIntensity,
    finalIntensityAtHome:
      match === null || lastStep === undefined ? null : result.alerter.intensityAtHome(match.detection, lastStep.estimate.magnitude),
    otherDeclarations: result.detections.length - (match === null ? 0 : 1),
  };
}
