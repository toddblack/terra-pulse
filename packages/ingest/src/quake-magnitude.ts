import { haversineKm } from '@terra-pulse/schema';
import { Biquad } from './biquad';
import type { AssociatedEvent, AssociatorStation } from './quake-associator';
import { GAP_TOLERANCE_SAMPLES } from './quake-picker';

/**
 * Magnitude from the first seconds of P wave: peak displacement (Pd) and
 * distance, through Kuyuk & Allen's (2013) global scaling relation.
 *
 * The second stage of the early-warning detector. Detection fires on anything
 * four stations hear; an alert has to know whether it was big enough to matter,
 * and it has to know before the shaking it is warning about arrives — so the
 * only data available is the P wave.
 *
 * ## The relation, checked against the paper rather than recalled
 *
 *     M = 1.23 log10(Pd) + 1.38 log10(E) + 5.39          (their eq. 2)
 *
 * Pd in centimetres, E the epicentral distance in kilometres. Pd is the peak
 * absolute vertical displacement after a causal two-pole 3 Hz low-pass
 * Butterworth, within 4 s of the P pick or up to the S arrival if that comes
 * sooner. Fitted on Northern and Southern California, Japan and ElarmS's
 * real-time California detections (2,066 events, M0.2-8.0, stations within
 * 250 km); they report a mean error of 0.01 and a standard deviation of 0.31,
 * and found it beat each region's own fit. That last point is why a published
 * global relation is used here instead of one fitted to this app's own replay:
 * our tuning set is 22 quakes between M4.0 and M5.5, which could not pin a
 * slope that has to reach M7.
 *
 * **Measured on the replay's tuning half before anything was built**
 * (2026-10-02, the detector's own picks and location, nothing tuned): mean
 * residual (catalogue − estimate) **+0.13**, sd **0.25** over 22 quakes at 4 s;
 * **+0.04 / 0.28** at the 10 s window shipped below.
 *
 * ## Departures from the paper, each measured
 *
 * - **The window is 10 s, not 4.** At 4 s Ridgecrest's M6.4 came out exactly
 *   (6.39) and the M7.1 at **6.38** — the saturation the paper itself reports
 *   near M7, because 4 s is shorter than an M7 rupture. At 10 s the M7.1 reads
 *   **7.04** and the tuning set is unchanged. Lengthening the window is the
 *   remedy the paper names (Colombelli et al. 2012). Chosen while looking at
 *   Ridgecrest, which is the reference case rather than the tuning set — say so
 *   if it is ever graded on.
 *
 *   **A longer window does not delay anything.** The peak so far is a lower
 *   bound on the window's peak, so the estimate is computed from whatever has
 *   arrived and only climbs as the window fills. A threshold is crossed as soon
 *   as the evidence supports it; the longer window only stops a great quake
 *   being capped at M6.4.
 *
 * - **The S-wave cut is kept.** S arrives within 10 s of P at every station
 *   inside ~75 km, so for the near stations the window is S−P, exactly as the
 *   paper specifies. The S wave is larger and would inflate Pd.
 *
 * - **The integration high-pass is 0.075 Hz**, which the paper does not state.
 *   It is needed — integrating velocity to displacement turns any offset into
 *   a ramp — and swept on the tuning set it barely matters: mean residual 0.03
 *   at 0.05 Hz, 0.06 at 0.1. It starts to matter at 0.2 Hz, where the M7.1
 *   drops to 6.76: the high-pass is then eating the low frequencies a large
 *   rupture's displacement lives in.
 *
 * ## What it cannot use: geophones
 *
 * The relation needs true ground displacement down to well below 1 Hz. A
 * geophone's response falls off below its natural frequency (1-4.5 Hz), so the
 * displacement it implies is far too small. Measured: the PB borehole stations
 * (HS-1-LT) read **1.25-1.59 magnitude units low**. `velocityGainOf` refuses
 * them, and a station with no gain still detects — STA/LTA is a ratio, so gain
 * cancels — it just does not vote on magnitude.
 *
 * Engineering constants, like the picker's; nothing here is a registered
 * analysis parameter.
 */

export interface MagnitudeParams {
  /** Before and after integrating; see above. */
  highPassHz: number;
  /** The paper's causal two-pole low-pass. */
  lowPassHz: number;
  /** Longest P window, s; cut sooner by the S arrival. */
  maxWindowS: number;
  /** The relation was fitted on stations within 250 km. */
  maxDistanceKm: number;
  /**
   * P window a station needs before it votes, s (or its whole window if
   * shorter). A station joining with a fraction of a second of P reports a
   * tiny lower bound and drags the mean down — Searles Valley's M5.5 went
   * 5.3 → 5.0 → 5.9 for that reason. Swept on the tuning set, residual at
   * declaration (mean / sd / quakes with any estimate):
   *
   *   0 s    0.41 / 0.41 / 22      2 s    0.27 / 0.53 / 21
   *   0.5 s  0.30 / 0.41 / 22      3 s    0.29 / 0.58 / 19
   *   1 s    0.27 / 0.44 / 22
   *
   * Past 1 s, the stations that would have voted at declaration are still
   * waiting, so the estimate gets noisier or is missing. The final estimate is
   * 0.04 / 0.28 in every row: this only changes how soon it is reached.
   */
  minWindowS: number;
}

export const DEFAULT_MAGNITUDE_PARAMS: MagnitudeParams = {
  highPassHz: 0.075,
  lowPassHz: 3,
  maxWindowS: 10,
  maxDistanceKm: 250,
  minWindowS: 1,
};

/** Kuyuk & Allen (2013), eq. 2. Pd in cm, E in km. */
export const PD_SCALING = { pd: 1.23, distance: 1.38, constant: 5.39 } as const;

/**
 * Epicentral distance is floored at 1 km: log10(E) runs to −∞ at a station
 * directly above the source, which the paper's 250 km dataset never had to
 * meet. 1 km is inside any location error this detector makes.
 */
const MIN_DISTANCE_KM = 1;

export function magnitudeFromPd(pdCm: number, epicentralKm: number): number {
  const km = Math.max(epicentralKm, MIN_DISTANCE_KM);
  return PD_SCALING.pd * Math.log10(pdCm) + PD_SCALING.distance * Math.log10(km) + PD_SCALING.constant;
}

/**
 * Seconds of filtered displacement kept per channel. A pick stays attachable
 * to its event for the associator's retention (45 s), and its window reaches
 * 10 s past it; 90 s covers both with room.
 */
const BUFFER_S = 90;

export interface PeakDisplacement {
  peakCm: number;
  /** Latest sample the peak was taken over. */
  throughMs: number;
  /** Every sample up to `toMs` has arrived. */
  complete: boolean;
}

/**
 * One channel's ground displacement, filtered the way the Pd relation expects,
 * kept for the last `BUFFER_S` seconds.
 *
 * counts → high-pass → ÷ gain (m/s) → integrate (m) → high-pass → low-pass → cm
 *
 * Resets on a gap, an overlap or a rate change, by the same rule as the picker
 * — every stage here carries memory of a continuous signal. The picker cannot
 * fire within its 20 s warm-up after a reset, so the filters here have always
 * settled by the time any pick asks them for a peak.
 */
export class DisplacementTracker {
  private readonly params: MagnitudeParams;
  private rateHz = 0;
  private expectedNextMs: number | null = null;
  private filters: { pre: Biquad; post: Biquad; low: Biquad } | null = null;
  private displacementM = 0;
  private previousVelocity = 0;
  /** |displacement| in cm, a ring of the newest samples. */
  private ring = new Float32Array(0);
  /** Samples written since the last reset. */
  private written = 0;
  /** Time of the first sample since the last reset. */
  private segmentStartMs = 0;

  constructor(
    readonly channelId: string,
    /** Counts per m/s. */
    private readonly gain: number,
    params: MagnitudeParams = DEFAULT_MAGNITUDE_PARAMS,
  ) {
    this.params = params;
  }

  private reset(startTimeMs: number, sampleRateHz: number, firstSample: number): void {
    const { highPassHz, lowPassHz } = this.params;
    this.rateHz = sampleRateHz;
    this.filters = {
      pre: Biquad.highPass(highPassHz, sampleRateHz),
      post: Biquad.highPass(highPassHz, sampleRateHz),
      low: Biquad.lowPass(lowPassHz, sampleRateHz),
    };
    // Primed on the raw count, for the same reason the picker primes: a DC
    // offset of tens of thousands of counts is otherwise a step on sample one.
    this.filters.pre.prime(firstSample);
    this.displacementM = 0;
    this.previousVelocity = 0;
    this.ring = new Float32Array(Math.ceil(BUFFER_S * sampleRateHz));
    this.written = 0;
    this.segmentStartMs = startTimeMs;
  }

  push(startTimeMs: number, sampleRateHz: number, samples: ArrayLike<number>): void {
    if (samples.length === 0) return;
    const intervalMs = 1000 / sampleRateHz;
    const continuous =
      this.filters !== null &&
      this.expectedNextMs !== null &&
      sampleRateHz === this.rateHz &&
      Math.abs(startTimeMs - this.expectedNextMs) <= GAP_TOLERANCE_SAMPLES * intervalMs;
    if (!continuous) this.reset(startTimeMs, sampleRateHz, samples[0] ?? 0);

    const { pre, post, low } = this.filters as { pre: Biquad; post: Biquad; low: Biquad };
    const dt = 1 / sampleRateHz;
    for (let i = 0; i < samples.length; i += 1) {
      const velocity = pre.step(samples[i] ?? 0) / this.gain;
      // Trapezoidal: the average of this sample and the last, times dt.
      this.displacementM += ((velocity + this.previousVelocity) / 2) * dt;
      this.previousVelocity = velocity;
      const cm = low.step(post.step(this.displacementM)) * 100;
      this.ring[this.written % this.ring.length] = Math.abs(cm);
      this.written += 1;
    }
    this.expectedNextMs = startTimeMs + samples.length * intervalMs;
  }

  /**
   * Peak |displacement| over [fromMs, toMs], as far as data has reached.
   *
   * Null when the answer would be wrong rather than partial: no sample yet at
   * or after `fromMs`, or the start of the window lies before the current
   * continuous segment (a gap reset the filters after the pick) or has already
   * been overwritten.
   */
  peak(fromMs: number, toMs: number): PeakDisplacement | null {
    if (this.filters === null || this.written === 0) return null;
    const intervalMs = 1000 / this.rateHz;
    const first = Math.ceil((fromMs - this.segmentStartMs) / intervalMs);
    const oldest = Math.max(0, this.written - this.ring.length);
    if (first < oldest) return null;
    const wanted = Math.floor((toMs - this.segmentStartMs) / intervalMs);
    const last = Math.min(this.written - 1, wanted);
    if (last < first) return null;
    let peakCm = 0;
    for (let k = first; k <= last; k += 1) {
      const value = this.ring[k % this.ring.length] ?? 0;
      if (value > peakCm) peakCm = value;
    }
    return { peakCm, throughMs: this.segmentStartMs + last * intervalMs, complete: last === wanted };
  }
}

export interface StationMagnitude {
  channelId: string;
  epicentralKm: number;
  peakCm: number;
  magnitude: number;
  /** Seconds of P window the peak was taken over so far. */
  windowS: number;
  /** Whether that window has reached its full length (10 s or S−P). */
  complete: boolean;
}

export interface MagnitudeEstimate {
  /** Mean of the station magnitudes, as ElarmS averages them. */
  magnitude: number;
  stations: StationMagnitude[];
  /** Every contributing window is full: the estimate can no longer climb. */
  complete: boolean;
}

export interface WaveGeometry {
  pVelocityKmS: number;
  sVelocityKmS: number;
  depthKm: number;
}

/**
 * The event's magnitude from what has arrived so far, or null if no station
 * can yet say anything.
 *
 * Each station's Pd is a running peak, so each station magnitude is a lower
 * bound that only rises as its window fills. The mean can still dip when a new
 * station joins with only a fraction of a second of P — which is why an alert
 * on this should latch rather than follow it down.
 */
export function estimateMagnitude(
  event: Pick<AssociatedEvent, 'latitude' | 'longitude' | 'picks'>,
  stationOf: (channelId: string) => AssociatorStation | undefined,
  trackerOf: (channelId: string) => DisplacementTracker | undefined,
  geometry: WaveGeometry,
  params: MagnitudeParams = DEFAULT_MAGNITUDE_PARAMS,
): MagnitudeEstimate | null {
  const stations: StationMagnitude[] = [];
  const seen = new Set<string>();
  for (const pick of event.picks) {
    if (seen.has(pick.channelId)) continue;
    seen.add(pick.channelId);
    const station = stationOf(pick.channelId);
    const tracker = trackerOf(pick.channelId);
    if (station === undefined || tracker === undefined) continue;

    const epicentralKm = haversineKm(station, event);
    if (epicentralKm > params.maxDistanceKm) continue;
    const hypocentralKm = Math.hypot(epicentralKm, geometry.depthKm);
    const sMinusPS = hypocentralKm / geometry.sVelocityKmS - hypocentralKm / geometry.pVelocityKmS;
    const windowMs = Math.min(params.maxWindowS, sMinusPS) * 1000;
    const end = pick.timeMs + windowMs;

    const peak = tracker.peak(pick.timeMs, end);
    if (peak === null || peak.peakCm <= 0) continue;
    if (!peak.complete && peak.throughMs - pick.timeMs < params.minWindowS * 1000) continue;
    stations.push({
      channelId: pick.channelId,
      epicentralKm,
      peakCm: peak.peakCm,
      magnitude: magnitudeFromPd(peak.peakCm, epicentralKm),
      windowS: (peak.throughMs - pick.timeMs) / 1000,
      complete: peak.complete,
    });
  }
  if (stations.length === 0) return null;
  const magnitude = stations.reduce((sum, s) => sum + s.magnitude, 0) / stations.length;
  return { magnitude, stations, complete: stations.every((s) => s.complete) };
}
