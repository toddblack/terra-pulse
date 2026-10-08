import { ipcMain } from 'electron';
import {
  REPLAY_MAX_ROW_KM,
  buildQuakeReplay,
  fetchChannelEpochs,
  fetchDataselect,
  replayDetectorNetwork,
  replayRowCandidates,
  replayWindow,
  runDetectorReplay,
  type FdsnTextRow,
} from '@terra-pulse/ingest';
import {
  channelIdOf,
  haversineKm,
  replayEligible,
  serverOf,
  type QuakeReplay,
  type QuakeReplayProgress,
  type QuakeReplayRequest,
  type WaveformChannel,
  type WaveformStation,
  type WaveformStationCatalogue,
} from '@terra-pulse/schema';

/**
 * Replaying a past quake (§5.13): fetch what the stations around its epicentre
 * recorded, run the detector over the near ones exactly as the graded script
 * does (`runDetectorReplay`), and hand the renderer a timeline it can play
 * back. No home and no alert — a replay shows the quake unfolding.
 *
 * **Everything is computed here, up front, and the renderer only plays it.**
 * That makes scrubbing free, keeps the detector in main (where it will run
 * live), and means the app shows the same detector the replay script grades —
 * not a second loop that happens to agree.
 *
 * User-triggered from the inspector, never automatic, and **nothing is kept**:
 * the user asked for no retained replay data, so re-watching a quake fetches
 * it again (a few seconds). The renderer holds only the replay on screen.
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

    // Re-checked here, not trusted from the renderer: the button's rule is the
    // only rule, and it lives in the schema both sides read.
    if (!replayEligible(request)) throw new Error('not eligible for a replay');

    progress('stations', 0, 1);
    const catalogue = await deps.catalogue();
    check();
    if (catalogue.status !== 'ready') throw new Error(`no station list: ${catalogue.reason}`);
    // EarthScope's stations only: the archive read below is EarthScope's
    // dataselect, which holds nothing for GeoNet's ring (2026-10-08). Each
    // other server's archive is its own data centre's — a later step.
    const archived = catalogue.stations.filter((s) => serverOf(s) === 'earthscope');
    const detectorNetwork = replayDetectorNetwork(archived, request);
    const rowCandidates = replayRowCandidates(archived, request);
    if (rowCandidates.length === 0) {
      throw new Error(`no public stations within ${REPLAY_MAX_ROW_KM.toLocaleString('en-US')} km of this quake`);
    }
    // Both sets, once each: in a dense network the rows are the detector's
    // nearest stations anyway.
    const fetched = new Map<string, WaveformStation>();
    for (const s of [...detectorNetwork, ...rowCandidates]) fetched.set(channelIdOf(s), s);
    const stations = [...fetched.values()];
    const farthestRowKm = Math.max(...rowCandidates.map((s) => haversineKm(request, s)));
    const window = replayWindow(request, farthestRowKm);

    // A missing gain list is not fatal: the detector still detects (STA/LTA is
    // a ratio), it just cannot estimate a magnitude. The replay says so.
    progress('gains', 0, 1);
    const gains =
      detectorNetwork.length === 0
        ? null
        : await fetchEpochs(detectorNetwork, request.originMs - EPOCH_MARGIN_MS, request.originMs + EPOCH_MARGIN_MS);
    check();

    const chunks: Uint8Array[] = [];
    const requests = Math.ceil(stations.length / STATIONS_PER_REQUEST);
    for (let i = 0; i < stations.length; i += STATIONS_PER_REQUEST) {
      progress('waveforms', i / STATIONS_PER_REQUEST, requests);
      chunks.push(await fetchWaveforms(stations.slice(i, i + STATIONS_PER_REQUEST), window.startMs, window.endMs));
      check();
    }

    // Every record is decoded and timed, but only the detector's own network
    // is listened to — it ignores channels outside its station list.
    progress('detector', 0, 1);
    const result = runDetectorReplay({ chunks, stations: detectorNetwork, gains, gainAtMs: request.originMs });
    const replay = buildQuakeReplay({ request, detectorNetwork, rowCandidates, window, result });
    check();
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
