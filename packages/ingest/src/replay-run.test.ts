import { describe, expect, it } from 'vitest';
import { channelIdOf, travelSeconds, type WaveformStation } from '@terra-pulse/schema';
import { DEFAULT_HOME } from './quake-alert';
import {
  HOME_NETWORK_RADIUS_KM,
  REPLAY_FOLLOW_MS,
  REPLAY_LEAD_MS,
  buildQuakeReplay,
  chooseReplayRows,
  homeNetwork,
  replayDetectorNetwork,
  replayRowCandidates,
  replayWindow,
  runDetectorReplay,
} from './replay-run';

const ORIGIN = Date.parse('2019-07-06T03:19:53Z');
const REQUEST = { eventId: 'ci38457511', originMs: ORIGIN, latitude: 35.77, longitude: -117.6, magnitude: 7.1, place: 'Ridgecrest' };

function station(code: string, latitude: number, longitude: number, sampleRateHz = 100): WaveformStation {
  return { network: 'CI', station: code, location: '', channel: 'HHZ', latitude, longitude, sampleRateHz, site: code };
}
const id = (code: string) => channelIdOf(station(code, 0, 0));

describe('homeNetwork', () => {
  it('keeps 100 Hz stations within the radius of home and nothing else', () => {
    const near = station('NEAR', 34.2, -118.2); // ~10 km from Burbank
    const slow = station('SLOW', 34.2, -118.2, 40); // close, but 40 Hz records fill too slowly
    const far = station('FAR', 37.8, -122.4); // San Francisco, ~560 km
    expect(homeNetwork([near, slow, far], DEFAULT_HOME).map((s) => s.station)).toEqual(['NEAR']);
  });

  it('is the 300 km the graded replays used', () => {
    // Every grade in CLAUDE.md was made on this network; changing the radius
    // changes what "the detector" is.
    expect(HOME_NETWORK_RADIUS_KM).toBe(300);
  });
});

describe('replayDetectorNetwork', () => {
  it('listens near the epicentre, nearest first, slower stations included', () => {
    const list = [
      station('FAR', 37.8, -122.4), // ~460 km: outside
      station('MID', 35.0, -117.6), // ~85 km
      station('SLOW', 35.8, -117.6, 40), // at the epicentre, 40 Hz
      station('LP', 35.8, -117.7, 1), // 1 Hz: not a seismometer the picker was built for
    ];
    expect(replayDetectorNetwork(list, REQUEST).map((s) => s.station)).toEqual(['SLOW', 'MID']);
  });

  it('keeps every station in reach — a nearest-N cap starves the magnitude of far stations', () => {
    // 150 stations spread north over ~270 km: all of them, nearest first.
    const many = Array.from({ length: 150 }, (_, i) => station(`S${String(i)}`, 35.77 + i * 0.016, -117.6));
    const net = replayDetectorNetwork(many, REQUEST);
    expect(net).toHaveLength(150);
    expect(net[0]?.station).toBe('S0');
  });
});

describe('replayRowCandidates', () => {
  it('reaches far past the detector, for a quake with nothing nearby', () => {
    // Mid-Pacific: the nearest are a thousand kilometres and more away.
    const pacific = { latitude: 20, longitude: -140 };
    const hawaii = station('HAW', 19.7, -155.5); // ~1,600 km
    const mainland = station('LA', 34, -118); // ~2,600 km
    const tooFar = station('JPN', 35.7, 139.7); // ~6,800 km
    expect(replayRowCandidates([tooFar, mainland, hawaii], pacific).map((s) => s.station)).toEqual(['HAW', 'LA']);
    expect(replayDetectorNetwork([tooFar, mainland, hawaii], pacific)).toEqual([]);
  });
});

describe('replayWindow', () => {
  it('opens a minute before the origin and keeps the graded three minutes for a near row', () => {
    const w = replayWindow(REQUEST, 50);
    expect(w.startMs).toBe(ORIGIN - REPLAY_LEAD_MS);
    expect(w.endMs).toBe(ORIGIN + REPLAY_FOLLOW_MS);
  });

  it('runs on until the S wave has reached the farthest row', () => {
    const w = replayWindow(REQUEST, 2000);
    expect(w.endMs).toBeGreaterThan(ORIGIN + 1000 * travelSeconds('S', 2000));
    // S at 2,000 km is ~7.5 minutes out, not the ~9 a crustal 3.6 km/s would say.
    expect((w.endMs - ORIGIN) / 60_000).toBeLessThan(9);
  });
});

describe('chooseReplayRows', () => {
  const candidates = [
    station('CCC', 34.2, -118.2), // ~180 km
    station('AAA', 35.8, -117.6), // at the epicentre
    station('DDD', 36.5, -117.6), // ~80 km north
    station('BBB', 35.0, -117.6), // ~85 km south
  ];
  const all = () => true;

  it('orders nearest first, so the wave sweeps down the rows', () => {
    const rows = chooseReplayRows(candidates, REQUEST, all, all, 3);
    expect(rows.map((r) => r.station)).toEqual(['AAA', 'DDD', 'BBB']);
    expect(rows[0]?.distanceKm).toBeLessThan(5);
  });

  it('prefers stations that recorded something to nearer ones that did not', () => {
    // AAA is nearest but has no data that day.
    const rows = chooseReplayRows(candidates, REQUEST, (channelId) => channelId !== id('AAA'), all, 2);
    expect(rows.map((r) => r.station)).toEqual(['DDD', 'BBB']);
  });

  it('says which rows the detector was listening to', () => {
    const rows = chooseReplayRows(candidates, REQUEST, all, (channelId) => channelId !== id('CCC'), 4);
    expect(rows.find((r) => r.station === 'CCC')?.listened).toBe(false);
    expect(rows.find((r) => r.station === 'AAA')?.listened).toBe(true);
  });
});

describe('runDetectorReplay', () => {
  it('runs on nothing and declares nothing', () => {
    // The loop itself is checked against the script's graded output (identical
    // tuning and reference summaries before and after it was lifted out); this
    // pins only the empty case the app hits when the archive holds no data.
    const result = runDetectorReplay({
      chunks: [],
      stations: [station('NEAR', 34.2, -118.2)],
      gains: null,
      gainAtMs: 0,
      home: DEFAULT_HOME,
    });
    expect(result.detections).toEqual([]);
    expect(result.records).toEqual([]);
    expect(result.picks).toEqual([]);
    expect(result.badRecords).toBe(0);
  });

  it('alerts nobody without a home', () => {
    const result = runDetectorReplay({ chunks: [], stations: [], gains: null, gainAtMs: 0 });
    expect(result.alerter).toBeNull();
    expect(result.alerts).toEqual([]);
  });
});

describe('buildQuakeReplay', () => {
  it('reports when there was nothing for the detector to hear', () => {
    const network = [station('AAA', 35.8, -117.6)];
    const result = runDetectorReplay({ chunks: [], stations: network, gains: null, gainAtMs: ORIGIN });
    const replay = buildQuakeReplay({
      request: REQUEST,
      detectorNetwork: network,
      rowCandidates: network,
      window: replayWindow(REQUEST, 5),
      result,
    });
    expect(replay.detection).toBeNull();
    expect(replay.detector).toMatchObject({ stations: 1, stationsWithData: 0, nearestKm: null, minStations: 4 });
    expect(replay.rows.map((r) => r.station)).toEqual(['AAA']);
    expect(replay.arrivals).toEqual([]);
  });
});
