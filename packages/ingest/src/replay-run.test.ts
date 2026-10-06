import { describe, expect, it } from 'vitest';
import { channelIdOf, haversineKm, type WaveformStation } from '@terra-pulse/schema';
import { DEFAULT_HOME } from './quake-alert';
import {
  HOME_NETWORK_RADIUS_KM,
  REPLAY_LEAD_MS,
  chooseReplayRows,
  homeNetwork,
  pArrivalAtHomeMs,
  replayWindow,
  runDetectorReplay,
} from './replay-run';

const ORIGIN = Date.parse('2019-07-06T03:19:53Z');
const REQUEST = { eventId: 'ci38457511', originMs: ORIGIN, latitude: 35.77, longitude: -117.6, magnitude: 7.1, place: 'Ridgecrest' };

function station(code: string, latitude: number, longitude: number, sampleRateHz = 100): WaveformStation {
  return { network: 'CI', station: code, location: '', channel: 'HHZ', latitude, longitude, sampleRateHz, site: code };
}

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

describe('replayWindow', () => {
  it('opens a local replay 30 s before the origin', () => {
    const p = pArrivalAtHomeMs(REQUEST, DEFAULT_HOME, 'local', 8, 6.2);
    expect(replayWindow(REQUEST, 'local', p).startMs).toBe(ORIGIN - REPLAY_LEAD_MS);
    // Ridgecrest to Burbank is ~190 km: the P wave needs ~30 s at 6.2 km/s.
    expect((p - ORIGIN) / 1000).toBeGreaterThan(25);
    expect((p - ORIGIN) / 1000).toBeLessThan(35);
  });

  it('aims a distant replay at the P wave reaching home, not at the origin', () => {
    const tohoku = { ...REQUEST, latitude: 38.3, longitude: 142.37, magnitude: 9.1 };
    const p = pArrivalAtHomeMs(tohoku, DEFAULT_HOME, 'distant', 8, 6.2);
    // ~76° away: P arrives around 11 minutes after the origin.
    expect((p - ORIGIN) / 60_000).toBeGreaterThan(10);
    expect(replayWindow(tohoku, 'distant', p).startMs).toBe(p - REPLAY_LEAD_MS);
  });
});

describe('chooseReplayRows', () => {
  const network = [
    station('AAA', 35.8, -117.6), // at the epicentre
    station('BBB', 35.0, -117.6), // ~85 km south
    station('CCC', 34.2, -118.2), // ~180 km, near home
    station('DDD', 36.5, -117.6), // ~80 km north
  ];
  const id = (code: string) => channelIdOf(station(code, 0, 0));
  /** The predicted P arrival at 6.2 km/s from an 8 km source, less 3 s. */
  const earliest = (s: WaveformStation) =>
    ORIGIN + (1000 * Math.hypot(haversineKm(REQUEST, s), 8)) / 6.2 - 3_000;

  it('orders by first trigger, not by distance', () => {
    const picks = [
      { channelId: id('BBB'), timeMs: ORIGIN + 14_000 },
      { channelId: id('AAA'), timeMs: ORIGIN + 2_000 },
      { channelId: id('BBB'), timeMs: ORIGIN + 40_000 }, // a later re-trigger does not move it
    ];
    const rows = chooseReplayRows(picks, network, REQUEST, earliest, 2);
    expect(rows.map((r) => r.station)).toEqual(['AAA', 'BBB']);
  });

  it('fills with the nearest to the epicentre when too few triggered', () => {
    const picks = [{ channelId: id('CCC'), timeMs: ORIGIN + 30_000 }];
    const rows = chooseReplayRows(picks, network, REQUEST, earliest, 3);
    expect(rows.map((r) => r.station)).toEqual(['CCC', 'AAA', 'DDD']);
    expect(rows[1]?.distanceKm).toBeLessThan(5);
  });

  it('fills with stations that recorded something before ones that did not', () => {
    // AAA is nearest but has no data that day; DDD recorded.
    const rows = chooseReplayRows([], network, REQUEST, earliest, 1, (channelId) => channelId !== id('AAA'));
    expect(rows.map((r) => r.station)).toEqual(['DDD']);
  });

  it('ignores a far station that triggered before the wave could reach it', () => {
    // Measured on Ridgecrest M7.1: a station 179 km out picked 0.3 s *before*
    // the origin, ~29 s ahead of the P wave. It is noise, not the quake.
    const picks = [
      { channelId: id('CCC'), timeMs: ORIGIN - 300 },
      { channelId: id('AAA'), timeMs: ORIGIN + 2_000 },
    ];
    const rows = chooseReplayRows(picks, network, REQUEST, earliest, 1);
    expect(rows.map((r) => r.station)).toEqual(['AAA']);
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
});
