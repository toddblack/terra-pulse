import { ipcMain } from 'electron';
import {
  DEFAULT_ALERT_GEOMETRY,
  DEFAULT_DETECTOR_PARAMS,
  buildQuakeReplay,
  fetchChannelEpochs,
  fetchDataselect,
  homeNetwork,
  pArrivalAtHomeMs,
  replayWindow,
  runDetectorReplay,
  type FdsnTextRow,
} from '@terra-pulse/ingest';
import {
  HOME_LOCATION,
  replayEligibility,
  type QuakeReplay,
  type QuakeReplayProgress,
  type QuakeReplayRequest,
  type WaveformChannel,
  type WaveformStationCatalogue,
} from '@terra-pulse/schema';

/**
 * Replaying a past quake through the early-warning detector (§5.13): fetch
 * what the home network recorded, run the detector over it exactly as the
 * graded script does (`runDetectorReplay`), and hand the renderer a timeline it
 * can play back.
 *
 * **Everything is computed here, up front, and the renderer only plays it.**
 * That makes scrubbing free, keeps the detector in main (where it will run
 * live), and means the app shows the same detector the replay script grades —
 * not a second loop that happens to agree.
 *
 * User-triggered from the inspector, never automatic, and nothing persists: a
 * small in-memory cache makes re-watching instant within a session.
 *
 * **A new start supersedes the one in flight.** The reader clicked another
 * quake; finishing the old one would only cost requests nobody will look at.
 * The superseded call rejects with `ReplayCancelledError`, which the renderer
 * ignores because it stores results against the event they describe.
 */

/** Requests are split so no single POST asks for the whole network at once — the script's size. */
const STATIONS_PER_REQUEST = 25;
/** Channel epochs either side of the origin; gains are looked up at the origin itself. */
const EPOCH_MARGIN_MS = 24 * 60 * 60 * 1000;
const CACHE_SIZE = 5;

export class ReplayCancelledError extends Error {
  constructor() {
    super('replay superseded');
    this.name = 'ReplayCancelledError';
  }
}

/** Everything main receives from the renderer is checked; the rest is built here. */
export function parseQuakeReplayRequest(raw: unknown): QuakeReplayRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (typeof r['eventId'] !== 'string' || r['eventId'].length === 0 || r['eventId'].length > 64) return null;
  if (typeof r['place'] !== 'string' || r['place'].length > 200) return null;
  if (!finite(r['originMs']) || !finite(r['latitude']) || !finite(r['longitude']) || !finite(r['magnitude'])) return null;
  if (Math.abs(r['latitude']) > 90 || Math.abs(r['longitude']) > 180) return null;
  return {
    eventId: r['eventId'],
    place: r['place'],
    originMs: r['originMs'],
    latitude: r['latitude'],
    longitude: r['longitude'],
    magnitude: r['magnitude'],
  };
}

export interface QuakeReplayDeps {
  /** The waveform picker's station list — shared, hour-cached, so no second fetch. */
  catalogue: () => Promise<WaveformStationCatalogue>;
  onProgress: (progress: QuakeReplayProgress) => void;
  fetchEpochs?: (channels: readonly WaveformChannel[], startMs: number, endMs: number) => Promise<FdsnTextRow[] | null>;
  fetchWaveforms?: (channels: readonly WaveformChannel[], startMs: number, endMs: number) => Promise<Uint8Array>;
}

export interface QuakeReplayController {
  start(request: QuakeReplayRequest): Promise<QuakeReplay>;
  cancel(): void;
}

export function createQuakeReplayController(deps: QuakeReplayDeps): QuakeReplayController {
  const fetchEpochs = deps.fetchEpochs ?? ((channels, startMs, endMs) => fetchChannelEpochs(channels, startMs, endMs));
  const fetchWaveforms = deps.fetchWaveforms ?? ((channels, startMs, endMs) => fetchDataselect(channels, startMs, endMs));
  const cache = new Map<string, QuakeReplay>();
  let generation = 0;

  async function start(request: QuakeReplayRequest): Promise<QuakeReplay> {
    generation += 1;
    const mine = generation;
    const check = () => {
      if (mine !== generation) throw new ReplayCancelledError();
    };
    const progress = (phase: QuakeReplayProgress['phase'], done: number, total: number) => {
      if (mine === generation) deps.onProgress({ eventId: request.eventId, phase, done, total });
    };

    const cached = cache.get(request.eventId);
    if (cached !== undefined) return cached;

    // Re-checked here, not trusted from the renderer: the button's rule is the
    // only rule, and it lives in the schema both sides read.
    const eligibility = replayEligibility(request);
    if (!eligibility.eligible) throw new Error('not eligible for a replay');
    const kind = eligibility.kind;

    progress('stations', 0, 1);
    const catalogue = await deps.catalogue();
    check();
    if (catalogue.status !== 'ready') throw new Error(`no station list: ${catalogue.reason}`);
    const network = homeNetwork(catalogue.stations, HOME_LOCATION);
    if (network.length === 0) throw new Error('no 100 Hz stations on the ring within reach of home');

    const pArrival = pArrivalAtHomeMs(
      request,
      HOME_LOCATION,
      kind,
      DEFAULT_ALERT_GEOMETRY.depthKm,
      DEFAULT_DETECTOR_PARAMS.associator.pVelocityKmS,
    );
    const window = replayWindow(request, kind, pArrival);

    // A missing gain list is not fatal: the detector still detects (STA/LTA is
    // a ratio), it just cannot estimate a magnitude. The replay says so.
    progress('gains', 0, 1);
    const gains = await fetchEpochs(network, request.originMs - EPOCH_MARGIN_MS, request.originMs + EPOCH_MARGIN_MS);
    check();

    const chunks: Uint8Array[] = [];
    const requests = Math.ceil(network.length / STATIONS_PER_REQUEST);
    for (let i = 0; i < network.length; i += STATIONS_PER_REQUEST) {
      progress('waveforms', i / STATIONS_PER_REQUEST, requests);
      chunks.push(await fetchWaveforms(network.slice(i, i + STATIONS_PER_REQUEST), window.startMs, window.endMs));
      check();
    }

    progress('detector', 0, 1);
    const result = runDetectorReplay({
      chunks,
      stations: network,
      gains,
      gainAtMs: request.originMs,
      home: HOME_LOCATION,
    });
    const replay = buildQuakeReplay({ request, kind, home: HOME_LOCATION, network, window, result });
    check();

    cache.set(request.eventId, replay);
    if (cache.size > CACHE_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return replay;
  }

  return {
    start,
    cancel() {
      generation += 1;
    },
  };
}

export function registerQuakeReplayHandlers(controller: QuakeReplayController): void {
  ipcMain.handle('quake-replay:start', (_event, raw: unknown): Promise<QuakeReplay> => {
    const request = parseQuakeReplayRequest(raw);
    if (request === null) return Promise.reject(new Error('bad replay request'));
    return controller.start(request);
  });
  ipcMain.handle('quake-replay:cancel', () => {
    controller.cancel();
  });
}
