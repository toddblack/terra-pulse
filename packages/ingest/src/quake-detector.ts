import {
  DEFAULT_ASSOCIATOR_PARAMS,
  QuakeAssociator,
  type AssociatedEvent,
  type AssociationVerdict,
  type AssociatorParams,
  type AssociatorStation,
} from './quake-associator';
import {
  DEFAULT_MAGNITUDE_PARAMS,
  DisplacementTracker,
  estimateMagnitude,
  type MagnitudeEstimate,
  type MagnitudeParams,
} from './quake-magnitude';
import { DEFAULT_PICKER_PARAMS, StationPicker, type Pick, type PickerParams } from './quake-picker';

/**
 * The early-warning detector: per-station triggers feeding an associator, and
 * a magnitude from the P waves of the stations that located it.
 *
 * Feed it decoded records as they *arrive*, with the arrival instant, and it
 * returns any earthquake it has just become confident of. The same object runs
 * live (arrival = when the packet landed) and in replay (arrival = record end +
 * measured transit), which is the point: what replay measures is what live
 * would have done.
 *
 * Status: validated against archived data (`scripts/replay-detector.ts`),
 * shown in the app as a replay of a past quake (`replay-run.ts`, through main's
 * `quake-replay.ts`), and **live since 2026-10-08** as the "Watch here" pin
 * (`quake-watch.ts`, through main's `ipc/quake-watch.ts`).
 */

export interface DetectorRecord {
  channelId: string;
  startTimeMs: number;
  sampleRateHz: number;
  samples: ArrayLike<number>;
}

export interface DetectorStation extends AssociatorStation {
  /**
   * Counts per m/s, from `velocityGainOf`. Null or absent: the station still
   * detects (STA/LTA is a ratio, so gain cancels) but does not vote on
   * magnitude.
   */
  velocityGain?: number | null;
}

export interface QuakeDetection extends AssociatedEvent {
  /** When the detector declared it: the arrival of the record that tipped it. */
  declaredAtMs: number;
  /** The estimate at declaration, from whatever P wave had arrived by then. */
  magnitude: MagnitudeEstimate | null;
}

export interface DetectorParams {
  picker: PickerParams;
  associator: AssociatorParams;
  magnitude: MagnitudeParams;
}

export const DEFAULT_DETECTOR_PARAMS: DetectorParams = {
  picker: DEFAULT_PICKER_PARAMS,
  associator: DEFAULT_ASSOCIATOR_PARAMS,
  magnitude: DEFAULT_MAGNITUDE_PARAMS,
};

/**
 * How long a declared event stays open for magnitude updates, after its
 * origin. The farthest voting station is 250 km out — ~40 s of P travel —
 * plus a 10 s window; past this nothing can change the estimate.
 */
const MAGNITUDE_OPEN_MS = 90_000;

export class QuakeDetector {
  private readonly pickers = new Map<string, StationPicker>();
  private readonly trackers = new Map<string, DisplacementTracker>();
  private readonly stations = new Map<string, DetectorStation>();
  private readonly associator: QuakeAssociator;
  private readonly params: DetectorParams;
  /**
   * The associator's own event objects, which it keeps attaching later P picks
   * to — so the magnitude can draw on stations that triggered after
   * declaration. Keyed by event id.
   */
  private readonly open = new Map<number, AssociatedEvent>();

  constructor(stations: readonly DetectorStation[], params: DetectorParams = DEFAULT_DETECTOR_PARAMS) {
    this.params = params;
    for (const station of stations) {
      this.stations.set(station.channelId, station);
      this.pickers.set(station.channelId, new StationPicker(station.channelId, params.picker));
      const gain = station.velocityGain;
      if (gain !== null && gain !== undefined && gain > 0) {
        this.trackers.set(station.channelId, new DisplacementTracker(station.channelId, gain, params.magnitude));
      }
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
    // Displacement first: a pick in this record may declare an event, and the
    // estimate at declaration should include the samples that made the pick.
    this.trackers.get(record.channelId)?.push(record.startTimeMs, record.sampleRateHz, record.samples);
    const picks = picker.push(record.startTimeMs, record.sampleRateHz, record.samples);
    const declared: QuakeDetection[] = [];
    for (const pick of picks) {
      const event = this.associator.addPick(pick, arrivedAtMs, (channelId) => this.pickers.get(channelId)?.readyThroughMs ?? null);
      this.onPick?.(pick, arrivedAtMs, this.associator.lastVerdict);
      if (event === null) continue;
      this.open.set(event.id, event);
      // The picks are copied: the associator keeps attaching later P picks to
      // its own event, and a detection should say what was known when declared.
      declared.push({
        ...event,
        picks: [...event.picks],
        declaredAtMs: arrivedAtMs,
        magnitude: this.estimate(event),
      });
    }
    for (const [id, event] of this.open) {
      if (arrivedAtMs - event.originMs > MAGNITUDE_OPEN_MS) this.open.delete(id);
    }
    return declared;
  }

  /**
   * A declared event's magnitude from everything that has arrived so far, or
   * null once the event has closed (or if no voting station has data yet).
   * Call it after each `push` to follow the estimate as P windows fill.
   */
  magnitudeOf(eventId: number): MagnitudeEstimate | null {
    const event = this.open.get(eventId);
    return event === undefined ? null : this.estimate(event);
  }

  private estimate(event: AssociatedEvent): MagnitudeEstimate | null {
    return estimateMagnitude(
      event,
      (id) => this.stations.get(id),
      (id) => this.trackers.get(id),
      this.params.associator,
      this.params.magnitude,
    );
  }
}
