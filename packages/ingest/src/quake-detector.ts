import {
  DEFAULT_ASSOCIATOR_PARAMS,
  QuakeAssociator,
  type AssociatedEvent,
  type AssociationVerdict,
  type AssociatorParams,
  type AssociatorStation,
} from './quake-associator';
import { DEFAULT_PICKER_PARAMS, StationPicker, type Pick, type PickerParams } from './quake-picker';

/**
 * The early-warning detector: per-station triggers feeding an associator.
 *
 * Feed it decoded records as they *arrive*, with the arrival instant, and it
 * returns any earthquake it has just become confident of. The same object runs
 * live (arrival = when the packet landed) and in replay (arrival = record end +
 * measured transit), which is the point: what replay measures is what live
 * would have done.
 *
 * Status: being validated against archived data (`scripts/replay-detector.ts`).
 * Nothing in the app calls it yet, and nothing it says is shown to anyone.
 */

export interface DetectorRecord {
  channelId: string;
  startTimeMs: number;
  sampleRateHz: number;
  samples: ArrayLike<number>;
}

export interface QuakeDetection extends AssociatedEvent {
  /** When the detector declared it: the arrival of the record that tipped it. */
  declaredAtMs: number;
}

export interface DetectorParams {
  picker: PickerParams;
  associator: AssociatorParams;
}

export const DEFAULT_DETECTOR_PARAMS: DetectorParams = {
  picker: DEFAULT_PICKER_PARAMS,
  associator: DEFAULT_ASSOCIATOR_PARAMS,
};

export class QuakeDetector {
  private readonly pickers = new Map<string, StationPicker>();
  private readonly associator: QuakeAssociator;

  constructor(stations: readonly AssociatorStation[], params: DetectorParams = DEFAULT_DETECTOR_PARAMS) {
    for (const station of stations) {
      this.pickers.set(station.channelId, new StationPicker(station.channelId, params.picker));
    }
    this.associator = new QuakeAssociator(stations, params.associator);
  }

  /**
   * Called for every pick with what the associator made of it. For tracing a
   * replay; live, nothing needs it.
   */
  onPick: ((pick: Pick, arrivedAtMs: number, verdict: AssociationVerdict) => void) | null = null;

  /** Records from channels outside the station list are ignored. */
  push(record: DetectorRecord, arrivedAtMs: number): QuakeDetection[] {
    const picker = this.pickers.get(record.channelId);
    if (picker === undefined) return [];
    const picks = picker.push(record.startTimeMs, record.sampleRateHz, record.samples);
    const declared: QuakeDetection[] = [];
    for (const pick of picks) {
      const event = this.associator.addPick(pick, arrivedAtMs, (channelId) => this.pickers.get(channelId)?.readyThroughMs ?? null);
      this.onPick?.(pick, arrivedAtMs, this.associator.lastVerdict);
      // The picks are copied: the associator keeps attaching later P picks to
      // its own event, and a detection should say what was known when declared.
      if (event !== null) declared.push({ ...event, picks: [...event.picks], declaredAtMs: arrivedAtMs });
    }
    return declared;
  }
}
