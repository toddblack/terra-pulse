import { haversineKm } from '@terra-pulse/schema';
import type { MiniSeedDataRecord } from './miniseed';
import type { QuakeDetection } from './quake-detector';

/**
 * Helpers for replaying archived waveforms through the detector and grading
 * the result against the catalogue. Pure, so the grading is testable apart
 * from any download.
 */

/**
 * Transit from a station to us, ms, on top of the record filling up. Measured
 * live 2026-09-11 at ~2 s; kept as a parameter of the replay rather than baked
 * in, because it is the one number here that depends on the network path.
 */
export const REPLAY_TRANSIT_MS = 2_000;

export interface ArrivingRecord {
  record: MiniSeedDataRecord;
  arrivedAtMs: number;
}

/**
 * When each record would have reached us live: a record ships only once full,
 * so it cannot leave the station before its last sample, and then it travels.
 *
 * **This is the whole of the replay's honesty about latency.** Feeding records
 * at their start time would hand the detector each record's samples seconds
 * before a live system could have had them — and the warning time it reported
 * would be flattered by exactly the delay this project measured and is trying
 * to beat.
 */
export function arrivalOrder(records: readonly MiniSeedDataRecord[], transitMs = REPLAY_TRANSIT_MS): ArrivingRecord[] {
  return records
    .map((record) => ({
      record,
      arrivedAtMs:
        record.startTimeMs + ((record.samples.length - 1) / record.sampleRateHz) * 1000 + transitMs,
    }))
    .sort((a, b) => a.arrivedAtMs - b.arrivedAtMs || a.record.startTimeMs - b.record.startTimeMs);
}

/** SeedLink 3 frames every record at exactly this size; see `seedlink.ts`. */
export const LIVE_RECORD_BYTES = 512;
const RECORD_HEADER_BYTES = 64;

/**
 * Re-cuts an archive record into the 512-byte records the live ring would have
 * sent, so a replay waits for each as long as live would have.
 *
 * **Needed because the archive does not always keep the live packaging.**
 * Measured on the Ridgecrest replay: CI, NN, PB and BC archive as 512-byte
 * records, but LB and SB as 4096-byte ones — median 7.4 s and 10.7 s of signal
 * per record, against 1.3 s for CI. Replayed as-is, those stations reached the
 * detector up to ~8x later than they would live, which made them look useless
 * and delayed declarations they would have helped.
 *
 * **An approximation, and it says so here.** A 512-byte record carries 448
 * bytes of samples against the big record's `recordBytes - 64`, so the samples
 * are split into that many equal parts. Steim packs quiet signal tighter than
 * loud, so live records would not be equal in duration — but the total and the
 * average are right, which is what the latency depends on.
 */
export function asLiveRecords(record: MiniSeedDataRecord, recordBytes: number): MiniSeedDataRecord[] {
  if (recordBytes <= LIVE_RECORD_BYTES) return [record];
  const parts = Math.ceil((recordBytes - RECORD_HEADER_BYTES) / (LIVE_RECORD_BYTES - RECORD_HEADER_BYTES));
  const per = Math.ceil(record.samples.length / parts);
  const out: MiniSeedDataRecord[] = [];
  for (let i = 0; i < record.samples.length; i += per) {
    out.push({
      ...record,
      startTimeMs: record.startTimeMs + (i / record.sampleRateHz) * 1000,
      samples: record.samples.subarray(i, i + per),
    });
  }
  return out;
}

/**
 * Approximate P travel time for a surface source, seconds, by distance in
 * degrees (IASP91, rounded). Only used to aim a replay window at a distant
 * quake's P arrival at home; an error of 20 s here costs nothing, since the
 * window has 30 s of lead. Beyond 100° the direct P is lost in the core shadow,
 * so the last entry stands in.
 *
 * **Below 20° it is a regional Pn line, not the table.** The table was written
 * for the replay script's distant great quakes, all well past 20°, and below
 * its first row it extrapolated: a Baja M7 500 km out came to 130 s against a
 * real ~65 s, which would aim the app's replay window past the P wave
 * entirely. ~8 km/s plus a few seconds of crust meets the table at 20° within
 * 6 s. The script's frozen distant cases stored their windows when drawn, so
 * this changes nothing already graded.
 */
export function teleseismicPSeconds(deltaDeg: number): number {
  if (deltaDeg < 20) return (deltaDeg * 111.19) / 8 + 5;
  const table: [number, number][] = [
    [20, 277], [30, 372], [40, 461], [50, 537], [60, 601], [70, 660], [80, 714], [90, 766], [100, 818],
  ];
  for (let i = 1; i < table.length; i += 1) {
    const [d1, t1] = table[i] as [number, number];
    const [d0, t0] = table[i - 1] as [number, number];
    if (deltaDeg <= d1) return t0 + ((deltaDeg - d0) / (d1 - d0)) * (t1 - t0);
  }
  return 818;
}

export interface CatalogueQuake {
  id: string;
  originMs: number;
  latitude: number;
  longitude: number;
  magnitude: number;
}

export interface MatchTolerance {
  /** Located epicentre to catalogue epicentre. */
  maxDistanceKm: number;
  /** Detected origin to catalogue origin. */
  maxOriginS: number;
}

/**
 * Generous on purpose: the detector uses one velocity and a fixed depth, so a
 * few seconds and a few tens of kilometres of error are expected and are what
 * is being *measured*. This only has to tell "the same earthquake" from
 * "a different one", not grade the location.
 */
export const DEFAULT_MATCH_TOLERANCE: MatchTolerance = { maxDistanceKm: 75, maxOriginS: 8 };

export interface MatchedDetection {
  detection: QuakeDetection;
  quake: CatalogueQuake;
  locationErrorKm: number;
  originErrorS: number;
  /** Declared minus true origin: how long after the quake began we knew. */
  declaredAfterOriginS: number;
}

export interface ReplayGrade {
  matched: MatchedDetection[];
  /** Declared with no catalogued earthquake to account for it: a false alarm. */
  spurious: QuakeDetection[];
  /** Catalogued, never declared. */
  missed: CatalogueQuake[];
}

/**
 * Pairs each detection with at most one catalogued quake, closest origin time
 * first, and each quake with at most one detection. A second detection of the
 * same quake (a duplicate) has nothing left to pair with and counts as
 * spurious — which is what it would be to a person receiving two alerts.
 */
export function gradeDetections(
  detections: readonly QuakeDetection[],
  catalogue: readonly CatalogueQuake[],
  tolerance: MatchTolerance = DEFAULT_MATCH_TOLERANCE,
): ReplayGrade {
  const pairs: { d: number; q: number; originErrorS: number; locationErrorKm: number }[] = [];
  detections.forEach((detection, d) => {
    catalogue.forEach((quake, q) => {
      const originErrorS = (detection.originMs - quake.originMs) / 1000;
      if (Math.abs(originErrorS) > tolerance.maxOriginS) return;
      const locationErrorKm = haversineKm(detection, quake);
      if (locationErrorKm > tolerance.maxDistanceKm) return;
      pairs.push({ d, q, originErrorS, locationErrorKm });
    });
  });
  pairs.sort((a, b) => Math.abs(a.originErrorS) - Math.abs(b.originErrorS));

  const usedD = new Set<number>();
  const usedQ = new Set<number>();
  const matched: MatchedDetection[] = [];
  for (const pair of pairs) {
    if (usedD.has(pair.d) || usedQ.has(pair.q)) continue;
    usedD.add(pair.d);
    usedQ.add(pair.q);
    const detection = detections[pair.d] as QuakeDetection;
    const quake = catalogue[pair.q] as CatalogueQuake;
    matched.push({
      detection,
      quake,
      locationErrorKm: pair.locationErrorKm,
      originErrorS: pair.originErrorS,
      declaredAfterOriginS: (detection.declaredAtMs - quake.originMs) / 1000,
    });
  }
  return {
    matched,
    spurious: detections.filter((_, d) => !usedD.has(d)),
    missed: catalogue.filter((_, q) => !usedQ.has(q)),
  };
}
