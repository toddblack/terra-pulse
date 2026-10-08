import {
  bearingDeg,
  channelIdOf,
  haversineKm,
  type QuakeReplay,
  type QuakeReplayRequest,
  type ReplayRow,
  type WaveformStation,
  travelSeconds,
} from '@terra-pulse/schema';
import { arrivalOrder, asLiveRecords, gradeDetections, type ArrivingRecord } from './detector-replay';
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
  /** Where the home alert is judged. Omitted, nothing alerts: the app's replays show no warning. */
  home?: HomeLocation;
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
  /** For `alertFor(id)`: an alert keeps updating after it is raised. Null with no home. */
  alerter: HomeAlerter | null;
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
  const alerter =
    input.home === undefined
      ? null
      : new HomeAlerter(input.home, input.rule ?? DEFAULT_ALERT_RULE, input.geometry ?? DEFAULT_ALERT_GEOMETRY);
  const alerts: HomeAlert[] = [];
  const arriving = arrivalOrder(records);
  for (const { record, arrivedAtMs } of arriving) {
    detections.push(...detector.push(record, arrivedAtMs));
    for (const d of detections) {
      const estimate = detector.magnitudeOf(d.id);
      const alert = alerter?.evaluate(d, estimate, arrivedAtMs) ?? null;
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
// The app's replay: which stations, which window, which rows, and what to hand
// the renderer. Pure, so every choice is a test; main only fetches.
//
// **Centred on the quake.** It began centred on home (`homeNetwork`, which the
// graded script still uses); on 2026-10-07 the user asked for any M5+ anywhere.
// Two station sets, because they answer different questions:
//   - the detector listens to the stations near the epicentre, where it can
//     work at all (`replayDetectorNetwork`);
//   - the rows show the nearest stations at any distance, so there is almost
//     always something to watch the wave reach (`replayRowCandidates`).
// Measured over 5,137 M5+ quakes (2024-2026): only 13% have four stations
// within 300 km, while 82% have ten within 2,000 km.
// ---------------------------------------------------------------------------

/**
 * The detector's listening radius around an epicentre — the graded home
 * network's — and **every** station inside it, uncapped.
 *
 * A cap at the nearest 80 was built first and measured worse: Ridgecrest M7.1
 * came out **M6.0, 24 km off** against the graded M7.1, 5 km. In a dense
 * network the nearest 80 all sit within ~100 km, where the S wave arrives
 * inside the 10 s P window and cuts it short — the saturation Kuyuk & Allen
 * report for large quakes — so only the farther stations the cap dropped could
 * measure an M7. Uncapped, over the 24 tuning and reference quakes: 24/24
 * found, median +14.2 s, final magnitude 0.02 from the catalogue — the same as
 * the 100 Hz-only home network, at ~80 stations median.
 */
export const REPLAY_DETECTOR_RADIUS_KM = HOME_NETWORK_RADIUS_KM;
/**
 * Slower than this is not a seismometer the picker was built for. Note the
 * graded network was 100 Hz only; outside Southern California most stations
 * are 20-50 Hz, so the detector listens to them too, and records that take
 * longer to fill make it later — which the replay shows honestly.
 */
export const REPLAY_MIN_RATE_HZ = 20;
/** Rows on screen: the cap the live view uses. */
export const REPLAY_ROWS = 10;
/** Stations fetched for the rows; more than shown, because today's network is not the network of the day replayed. */
export const REPLAY_ROW_CANDIDATES = 16;
/** Rows come from no farther than this. Past it, a row is the quake arriving in a different region. */
export const REPLAY_MAX_ROW_KM = 3000;

/**
 * Lead before the origin, and the least the window runs after it — **the
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
/** Past the S wave reaching the farthest row, so its shaking is on screen rather than at the edge. */
export const REPLAY_TAIL_MS = 30_000;

function nearestFirst(
  stations: readonly WaveformStation[],
  epicentre: { latitude: number; longitude: number },
  maxKm: number,
  count: number,
): WaveformStation[] {
  return stations
    .filter((s) => s.sampleRateHz >= REPLAY_MIN_RATE_HZ)
    .map((s) => ({ s, km: haversineKm(epicentre, s) }))
    .filter(({ km }) => km <= maxKm)
    .sort((a, b) => a.km - b.km)
    .slice(0, count)
    .map(({ s }) => s);
}

/** The stations the detector listens to for a replay: near the epicentre, nearest first. */
export function replayDetectorNetwork(
  stations: readonly WaveformStation[],
  epicentre: { latitude: number; longitude: number },
): WaveformStation[] {
  return nearestFirst(stations, epicentre, REPLAY_DETECTOR_RADIUS_KM, Number.POSITIVE_INFINITY);
}

/** The stations the rows are chosen from: the nearest, at any distance up to `REPLAY_MAX_ROW_KM`. */
export function replayRowCandidates(
  stations: readonly WaveformStation[],
  epicentre: { latitude: number; longitude: number },
): WaveformStation[] {
  return nearestFirst(stations, epicentre, REPLAY_MAX_ROW_KM, REPLAY_ROW_CANDIDATES);
}

/**
 * What a replay fetches: from a minute before the origin until the S wave has
 * reached the farthest row — but never less than the graded three minutes.
 * Arrival times are IASP91's, not the detector's crustal speed: at 2,000 km
 * that speed would put the P wave 50 s late and the window would end before it.
 */
export function replayWindow(request: QuakeReplayRequest, farthestRowKm: number): { startMs: number; endMs: number } {
  const sDoneMs = 1000 * travelSeconds('S', farthestRowKm) + REPLAY_TAIL_MS;
  return { startMs: request.originMs - REPLAY_LEAD_MS, endMs: request.originMs + Math.max(REPLAY_FOLLOW_MS, sDoneMs) };
}

/**
 * The rows: **the nearest stations that recorded anything, nearest first**, so
 * the P wave visibly sweeps down the panel — and with real travel times it does
 * so at the pace the Earth sets, not the order stations happened to trigger.
 * Stations with no archived data fill in only when there are not enough with:
 * today's network is not the network of the day replayed (Tohoku 2011 found 9
 * of 74 with data), and a row of nothing would take a place from a row of
 * something.
 */
export function chooseReplayRows(
  candidates: readonly WaveformStation[],
  epicentre: { latitude: number; longitude: number },
  hasData: (channelId: string) => boolean,
  listened: (channelId: string) => boolean,
  count = REPLAY_ROWS,
): ReplayRow[] {
  return candidates
    .map((s) => ({ s, km: haversineKm(epicentre, s), data: hasData(channelIdOf(s)) }))
    .sort((a, b) => Number(b.data) - Number(a.data) || a.km - b.km)
    .slice(0, count)
    .sort((a, b) => a.km - b.km)
    .map(({ s, km }) => ({ ...s, distanceKm: km, bearingDeg: bearingDeg(epicentre, s), listened: listened(channelIdOf(s)) }));
}

export interface QuakeReplayInput {
  request: QuakeReplayRequest;
  /** What the detector listened to (`replayDetectorNetwork`). */
  detectorNetwork: readonly WaveformStation[];
  /** What the rows were chosen from (`replayRowCandidates`). */
  rowCandidates: readonly WaveformStation[];
  window: { startMs: number; endMs: number };
  /** The detector's run over everything fetched; it ignores stations outside its network. */
  result: DetectorReplayResult;
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
  const { request, detectorNetwork, rowCandidates, window, result } = input;
  const params = input.params ?? DEFAULT_DETECTOR_PARAMS;

  const grade = gradeDetections(result.detections, [
    { id: request.eventId, originMs: request.originMs, latitude: request.latitude, longitude: request.longitude, magnitude: request.magnitude },
  ]);
  const match = grade.matched[0] ?? null;
  const steps = match === null ? [] : (result.estimates.get(match.detection.id) ?? []);

  const withData = new Set(result.records.map((r) => r.record.channelId));
  const listenedIds = new Set(detectorNetwork.map(channelIdOf));
  const listenedWithData = detectorNetwork.filter((s) => withData.has(channelIdOf(s)));
  const nearest = listenedWithData[0];

  const rows = chooseReplayRows(
    rowCandidates,
    request,
    (id) => withData.has(id),
    (id) => listenedIds.has(id),
  );
  const onRows = new Set(rows.map(channelIdOf));

  return {
    request,
    windowStartMs: window.startMs,
    windowEndMs: window.endMs,
    detector: {
      radiusKm: REPLAY_DETECTOR_RADIUS_KM,
      stations: detectorNetwork.length,
      stationsWithData: listenedWithData.length,
      // The network is nearest first, so the first with data is the nearest.
      nearestKm: nearest === undefined ? null : haversineKm(request, nearest),
      minStations: params.associator.minStations,
      maxNearestStationKm: params.associator.maxNearestStationKm,
    },
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
            })),
          },
    otherDetections: result.detections
      .filter((d) => d !== match?.detection)
      .map((d) => ({
        declaredAtMs: d.declaredAtMs,
        originMs: d.originMs,
        latitude: d.latitude,
        longitude: d.longitude,
        distanceKm: haversineKm(request, d),
      })),
  };
}
