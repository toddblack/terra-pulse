/**
 * Per-station P-wave trigger: a high-pass filter, then a recursive STA/LTA.
 *
 * The first stage of the early-warning detector (see `quake-detector.ts`). It
 * answers one question per station — "did the ground just start moving much
 * harder than it has been?" — and reports the instant it did. Whether that was
 * an earthquake is not its call: a passing truck, a door slam or a data glitch
 * all trigger one station, and it is the associator's job to require several
 * stations to agree before anything is believed.
 *
 * **Raw counts are fine here, and that is why STA/LTA is the right tool for a
 * first pass.** It is a ratio of a signal's energy to its own recent energy,
 * so the instrument gain cancels: a broadband at ~20,000 counts per µm/s and a
 * short-period at ~400 trigger on the same relative change. Magnitude needs
 * real units and will need the gains; detection does not.
 *
 * Nothing here is a registered analysis parameter. These are engineering
 * constants for a detector, tuned against archived data — and tuned only on
 * the tuning half of the replay set, never on the half it is graded on.
 */
import { Biquad } from './biquad';

export interface PickerParams {
  /**
   * High-pass corner, Hz. Removes ocean microseism (0.1-0.5 Hz), which
   * dominates a quiet broadband and says nothing about a local quake — and,
   * set high enough, the low-frequency P waves of distant great quakes too,
   * which was the larger effect on real data (see the defaults). Two cascaded
   * second-order sections make it 4th order.
   */
  highPassHz: number;
  /** Short-term average window, seconds: how fast the trigger reacts. */
  staSeconds: number;
  /** Long-term average window, seconds: what "normal" means for this station. */
  ltaSeconds: number;
  /** STA/LTA ratio that declares a pick. */
  triggerRatio: number;
  /** Ratio the trigger must fall back below before it can fire again. */
  detriggerRatio: number;
  /**
   * Longest a trigger may hold, s, before the station is released and its
   * LTA re-based on the shaking it is in. `Infinity` disables it.
   *
   * **Without it a station near any quake was blind for well over a minute.**
   * The LTA is frozen while triggered (see `push`), so the coda has to fall
   * to twice the *pre-quake* noise before release. Measured 2026-10-02 on the
   * tuning and reference sets: median trigger 81-88 s at every magnitude from
   * M4 to M7 — and that is capped by the 2-minute replay window — with nearly
   * every station within 100 km still triggered 60-90 s after even an M4.0.
   * A second quake in that time could not be picked at all.
   *
   * Released, the LTA becomes the current shaking, so a second quake has to
   * stand out against the first one's coda rather than against quiet ground.
   * Swept on the `sequence` set with the associator's coda rules on, second
   * quakes found of 17: 15 s → 10, **20 s → 11**, 25 s → 10, all with no
   * false alarm. On its own, with those rules off, release moved 9 → 10.
   */
  maxTriggerS: number;
}

/**
 * **3 Hz and a ratio of 8, chosen by sweep on the replay's tuning halves**
 * (2026-10-02; 22 local M4+ quakes and 8 distant M7.5+ ones):
 *
 *   corner  ratio  local found  false (local set)  false (distant quakes)
 *   1 Hz    5      21/22        3                  27
 *   1 Hz    8      22/22        0                  21
 *   2 Hz    8      22/22        0                   1
 *   3 Hz    8      22/22        0                   0
 *   5 Hz    8      22/22        1                   0
 *
 * The distant-quake column is the one that moved, and the physics says why:
 * a great quake's P wave crossing thousands of kilometres has lost its high
 * frequencies, while a local quake's has not. At 1 Hz every one of the
 * distant quakes produced false alarms; at 3 Hz none did. Median declaration
 * time was ~14.3 s in every row, so none of this cost speed. 3/8 sits inside a
 * good region rather than on its edge — both neighbours are nearly as good.
 */
export const DEFAULT_PICKER_PARAMS: PickerParams = {
  highPassHz: 3,
  staSeconds: 0.5,
  ltaSeconds: 20,
  triggerRatio: 8,
  detriggerRatio: 2,
  maxTriggerS: 20,
};

/** One station's trigger: the instant its STA/LTA crossed the threshold. */
export interface Pick {
  channelId: string;
  timeMs: number;
  /** STA/LTA at the moment of the pick — how decisively it fired. */
  ratio: number;
}

/** Gap allowance: a record starting this many sample intervals off is a gap. */
export const GAP_TOLERANCE_SAMPLES = 1.5;

/**
 * One channel's streaming trigger.
 *
 * Feed it records in time order; it returns any picks they contain. A gap, an
 * overlap or a change of sample rate resets it, because every piece of state
 * here — filter memory, both averages — describes a continuous signal, and
 * carrying it across a break would compare the ground now against the ground
 * before an outage.
 */
export class StationPicker {
  private readonly params: PickerParams;
  private rateHz = 0;
  private expectedNextMs: number | null = null;
  private sections: [Biquad, Biquad] | null = null;
  private sta = 0;
  private lta = 0;
  private staAlpha = 0;
  private ltaAlpha = 0;
  /** Samples since the last reset; no pick until the LTA means something. */
  private warm = 0;
  private warmupSamples = 0;
  private triggered = false;
  /** Samples since the current trigger fired. */
  private triggeredSamples = 0;
  private maxTriggerSamples = Number.POSITIVE_INFINITY;

  /** Latest sample time this picker has seen, or null before any data. */
  latestSampleMs: number | null = null;

  /**
   * How far this channel's data reaches *as evidence that it could have
   * picked*: the latest sample, once warmed up and while not already
   * triggered. Null otherwise, because silence from a station that could not
   * have fired means nothing:
   *
   * - **warming up** after a start or a gap, its LTA is not yet meaningful;
   * - **already triggered**, it cannot fire again until the shaking subsides.
   *   Found replaying Ridgecrest's M7.1, which came 3.5 minutes after an M5.4:
   *   seven nearby stations still mid-trigger from the foreshock were counted
   *   as having heard nothing, and held the declaration back. A station that
   *   is busy shaking is the opposite of silent.
   */
  get readyThroughMs(): number | null {
    if (this.sections === null || this.warm < this.warmupSamples || this.triggered) return null;
    return this.latestSampleMs;
  }

  constructor(
    readonly channelId: string,
    params: PickerParams = DEFAULT_PICKER_PARAMS,
  ) {
    this.params = params;
  }

  private reset(sampleRateHz: number, firstSample: number): void {
    this.rateHz = sampleRateHz;
    this.sections = [
      Biquad.highPass(this.params.highPassHz, sampleRateHz),
      Biquad.highPass(this.params.highPassHz, sampleRateHz),
    ];
    this.sections[0].prime(firstSample);
    this.sections[1].prime(0);
    this.staAlpha = 1 / (this.params.staSeconds * sampleRateHz);
    this.ltaAlpha = 1 / (this.params.ltaSeconds * sampleRateHz);
    this.sta = 0;
    this.lta = 0;
    this.warm = 0;
    this.warmupSamples = Math.ceil(this.params.ltaSeconds * sampleRateHz);
    this.triggered = false;
    this.triggeredSamples = 0;
    this.maxTriggerSamples = this.params.maxTriggerS * sampleRateHz;
  }

  push(startTimeMs: number, sampleRateHz: number, samples: ArrayLike<number>): Pick[] {
    if (samples.length === 0) return [];
    const intervalMs = 1000 / sampleRateHz;
    const continuous =
      this.sections !== null &&
      this.expectedNextMs !== null &&
      sampleRateHz === this.rateHz &&
      Math.abs(startTimeMs - this.expectedNextMs) <= GAP_TOLERANCE_SAMPLES * intervalMs;
    if (!continuous) this.reset(sampleRateHz, samples[0] ?? 0);

    const [first, second] = this.sections as [Biquad, Biquad];
    const { triggerRatio, detriggerRatio } = this.params;
    const picks: Pick[] = [];

    for (let i = 0; i < samples.length; i += 1) {
      const filtered = second.step(first.step(samples[i] ?? 0));
      const energy = filtered * filtered;
      this.sta += (energy - this.sta) * this.staAlpha;
      // The LTA is frozen while triggered. Left running, it climbs toward the
      // earthquake's own energy and the trigger releases mid-shaking — and
      // then fires again on the S wave as though it were a new event.
      if (!this.triggered) this.lta += (energy - this.lta) * this.ltaAlpha;
      if (this.warm < this.warmupSamples) {
        this.warm += 1;
        continue;
      }
      if (this.lta <= 0) continue;

      const ratio = this.sta / this.lta;
      if (!this.triggered && ratio >= triggerRatio) {
        this.triggered = true;
        this.triggeredSamples = 0;
        picks.push({ channelId: this.channelId, timeMs: startTimeMs + i * intervalMs, ratio });
      } else if (this.triggered && ratio < detriggerRatio) {
        this.triggered = false;
      } else if (this.triggered && (this.triggeredSamples += 1) >= this.maxTriggerSamples) {
        // Held too long: release, and make the shaking it is in the new
        // normal. A second quake then has to stand out against this coda
        // rather than against the quiet ground before the first one.
        this.triggered = false;
        this.lta = this.sta;
      }
    }

    this.expectedNextMs = startTimeMs + samples.length * intervalMs;
    this.latestSampleMs = this.expectedNextMs - intervalMs;
    return picks;
  }
}
