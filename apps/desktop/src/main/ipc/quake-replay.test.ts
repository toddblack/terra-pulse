import { describe, expect, it, vi } from 'vitest';
import type { QuakeReplayProgress, QuakeReplayRequest, WaveformStation } from '@terra-pulse/schema';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { ReplayCancelledError, createQuakeReplayController, parseQuakeReplayRequest } from './quake-replay';

const NEAR_HOME: WaveformStation = {
  network: 'CI',
  station: 'NEAR',
  location: '',
  channel: 'HHZ',
  latitude: 34.2,
  longitude: -118.2,
  site: 'Near home',
  sampleRateHz: 100,
};

const RIDGECREST: QuakeReplayRequest = {
  eventId: 'ci38457511',
  originMs: Date.parse('2019-07-06T03:19:53Z'),
  latitude: 35.77,
  longitude: -117.6,
  magnitude: 7.1,
  place: 'Ridgecrest',
};

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function controller(overrides: Partial<Parameters<typeof createQuakeReplayController>[0]> = {}) {
  const progress: QuakeReplayProgress[] = [];
  const fetchWaveforms = vi.fn(() => Promise.resolve(new Uint8Array(0)));
  const c = createQuakeReplayController({
    catalogue: () => Promise.resolve({ status: 'ready', stations: [NEAR_HOME], fetchedAtMs: 0 }),
    onProgress: (p) => progress.push(p),
    fetchEpochs: () => Promise.resolve([]),
    fetchWaveforms,
    ...overrides,
  });
  return { c, progress, fetchWaveforms };
}

describe('parseQuakeReplayRequest', () => {
  it('accepts a well-formed request and rejects anything else', () => {
    expect(parseQuakeReplayRequest(RIDGECREST)).toEqual(RIDGECREST);
    expect(parseQuakeReplayRequest(null)).toBeNull();
    expect(parseQuakeReplayRequest({ ...RIDGECREST, latitude: 91 })).toBeNull();
    expect(parseQuakeReplayRequest({ ...RIDGECREST, originMs: Number.NaN })).toBeNull();
    expect(parseQuakeReplayRequest({ ...RIDGECREST, eventId: '' })).toBeNull();
  });
});

describe('createQuakeReplayController', () => {
  it('runs a replay end to end, reporting each phase', async () => {
    const { c, progress } = controller();
    const replay = await c.start(RIDGECREST);
    // ~180 km from the epicentre: listened to, and a row.
    expect(replay.detector.stations).toBe(1);
    expect(replay.rows.map((r) => r.station)).toEqual(['NEAR']);
    // An archive that held nothing: no data, no declaration — said, not hidden.
    expect(replay.detector.stationsWithData).toBe(0);
    expect(replay.detection).toBeNull();
    expect(progress.map((p) => p.phase)).toEqual(['stations', 'gains', 'waveforms', 'detector']);
  });

  it('replays a quake anywhere, from whatever stations are nearest it', async () => {
    // Tohoku: Burbank's station is ~8,400 km away — not a row, not listened to.
    const tokyo: WaveformStation = { ...NEAR_HOME, network: 'IU', station: 'MAJO', latitude: 36.55, longitude: 138.2 };
    const { c, fetchWaveforms } = controller({
      catalogue: () => Promise.resolve({ status: 'ready', stations: [NEAR_HOME, tokyo], fetchedAtMs: 0 }),
    });
    const replay = await c.start({ ...RIDGECREST, eventId: 'tohoku', latitude: 38.3, longitude: 142.37, magnitude: 9.1 });
    expect(replay.rows.map((r) => r.station)).toEqual(['MAJO']);
    // ~380 km: past the detector's reach, so only watched.
    expect(replay.rows[0]?.listened).toBe(false);
    expect(replay.detector.stations).toBe(0);
    expect(fetchWaveforms).toHaveBeenCalledWith([tokyo], expect.any(Number), expect.any(Number));
  });

  it('says so when no public station is anywhere near', async () => {
    const { c } = controller();
    // Southern Indian Ocean, thousands of kilometres from the one station.
    await expect(c.start({ ...RIDGECREST, latitude: -50, longitude: 80 })).rejects.toThrow('no public stations within');
  });

  it('refuses a quake the button would not have offered', async () => {
    const { c } = controller();
    await expect(c.start({ ...RIDGECREST, magnitude: 4.9 })).rejects.toThrow('not eligible');
  });

  it('says why when there is no station list', async () => {
    const { c } = controller({ catalogue: () => Promise.resolve({ status: 'unavailable', reason: 'ring down' }) });
    await expect(c.start(RIDGECREST)).rejects.toThrow('ring down');
  });

  it('lets a newer start supersede one still loading', async () => {
    const gate = deferred<{ status: 'ready'; stations: WaveformStation[]; fetchedAtMs: number }>();
    let calls = 0;
    const { c } = controller({
      catalogue: () => {
        calls += 1;
        return calls === 1 ? gate.promise : Promise.resolve({ status: 'ready', stations: [NEAR_HOME], fetchedAtMs: 0 });
      },
    });
    const first = c.start(RIDGECREST);
    const second = c.start({ ...RIDGECREST, eventId: 'ci38443183', magnitude: 6.4 });
    gate.resolve({ status: 'ready', stations: [NEAR_HOME], fetchedAtMs: 0 });
    await expect(first).rejects.toBeInstanceOf(ReplayCancelledError);
    await expect(second).resolves.toMatchObject({ request: { eventId: 'ci38443183' } });
  });

  it('keeps nothing: a repeat replay fetches again', async () => {
    // The user asked for no retained replay data.
    const { c, fetchWaveforms } = controller();
    await c.start(RIDGECREST);
    await c.start(RIDGECREST);
    expect(fetchWaveforms).toHaveBeenCalledTimes(2);
  });
});
