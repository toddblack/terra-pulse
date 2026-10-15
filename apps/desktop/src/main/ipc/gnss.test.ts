import { describe, expect, it, vi } from 'vitest';
import type { NglStationPage, NglStationRecord } from '@terra-pulse/ingest';
import type { GnssDailyPosition, GnssRequest, GnssVelocity } from '@terra-pulse/schema';

// `gnss.ts` imports ipcMain at module load; nothing under test touches Electron.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

const {
  coversQuake,
  createKeyedCache,
  lookUpGnss,
  parseGnssRequest,
  rankCandidates,
  recordSpansQuake,
  windowOf,
} = await import('./gnss');

const DAY = 86_400_000;
// Ridgecrest M7.1.
const ORIGIN = Date.parse('2019-07-06T03:19:53Z');
const QUAKE_DAY = Date.UTC(2019, 6, 6);
const RIDGECREST = { latitude: 35.77, longitude: -117.6 };

function station(id: string, latitude: number, longitude: number, overrides: Partial<NglStationRecord> = {}): NglStationRecord {
  return {
    station: id,
    latitude,
    longitude,
    beginMs: Date.UTC(2005, 0, 1),
    endMs: Date.UTC(2026, 9, 1),
    ...overrides,
  };
}

/** Days from `fromDay` to `toDay` relative to the quake day, inclusive, skipping any in `missing`. */
function days(fromDay: number, toDay: number, missing: number[] = []): GnssDailyPosition[] {
  const positions: GnssDailyPosition[] = [];
  for (let d = fromDay; d <= toDay; d += 1) {
    if (missing.includes(d)) continue;
    positions.push({ dayMs: QUAKE_DAY + d * DAY, eastM: d, northM: 0, upM: 0 });
  }
  return positions;
}

const REQUEST: GnssRequest = {
  eventId: 'ci38457511',
  latitude: RIDGECREST.latitude,
  longitude: RIDGECREST.longitude,
  magnitude: 7.1,
  originUtc: new Date(ORIGIN).toISOString(),
};

function sources({
  stations,
  series,
  pages = {},
  velocities = new Map<string, GnssVelocity>(),
}: {
  stations: NglStationRecord[] | null;
  series: Record<string, GnssDailyPosition[] | null>;
  pages?: Record<string, NglStationPage | null>;
  velocities?: Map<string, GnssVelocity> | null;
}) {
  const seriesCalls: string[] = [];
  return {
    seriesCalls,
    value: {
      stationList: { get: () => Promise.resolve(stations) },
      velocities: { get: () => Promise.resolve(velocities) },
      series: (id: string) => {
        seriesCalls.push(id);
        return Promise.resolve(series[id] ?? null);
      },
      // `in`, not `??`: an explicit null is a page that could not be read.
      page: (id: string) => Promise.resolve(id in pages ? (pages[id] ?? null) : { doi: null, steps: [] }),
    },
  };
}

describe('recordSpansQuake', () => {
  it('needs a month before the quake day and a whole day after it', () => {
    expect(recordSpansQuake(station('A', 0, 0), ORIGIN)).toBe(true);
    expect(recordSpansQuake(station('A', 0, 0, { beginMs: QUAKE_DAY - 29 * DAY }), ORIGIN)).toBe(false);
    // Ending on the quake's own day is not "after" it.
    expect(recordSpansQuake(station('A', 0, 0, { endMs: QUAKE_DAY }), ORIGIN)).toBe(false);
    expect(recordSpansQuake(station('A', 0, 0, { endMs: QUAKE_DAY + DAY }), ORIGIN)).toBe(true);
  });
});

describe('rankCandidates', () => {
  it('orders covering stations by distance and leaves out the rest', () => {
    const ranked = rankCandidates(
      [
        station('FAR_', 36.5, -117.6),
        station('NEAR', 35.8, -117.6),
        station('GONE', 35.77, -117.61, { endMs: Date.UTC(2018, 0, 1) }),
      ],
      RIDGECREST,
      ORIGIN,
    );
    expect(ranked.map((c) => c.record.station)).toEqual(['NEAR', 'FAR_']);
    expect(ranked[0]?.distanceKm).toBeCloseTo(3.3, 1);
  });
});

describe('windowOf and coversQuake', () => {
  it('keeps a year before to 30 days after', () => {
    const window = windowOf(days(-400, 60), ORIGIN);
    expect(window[0]?.dayMs).toBe(QUAKE_DAY - 365 * DAY);
    expect(window.at(-1)?.dayMs).toBe(QUAKE_DAY + 30 * DAY);
  });

  it('wants ten days in the month before and one after', () => {
    expect(coversQuake(days(-30, 5), ORIGIN)).toBe(true);
    expect(coversQuake(days(-30, 0), ORIGIN)).toBe(false); // the quake day is not after
    expect(coversQuake(days(-9, 5), ORIGIN)).toBe(false); // nine days before
    expect(coversQuake(days(-10, 5), ORIGIN)).toBe(true);
  });
});

describe('lookUpGnss', () => {
  const near = station('NEAR', 35.8, -117.6);
  const mid = station('MID_', 36.0, -117.6);
  const far = station('FAR_', 36.5, -117.6);

  it('returns the nearest three, nearest first, with their windows', async () => {
    const s = sources({
      stations: [far, near, mid, station('LAST', 37, -117.6)],
      series: { NEAR: days(-400, 60), MID_: days(-400, 60), FAR_: days(-400, 60), LAST: days(-400, 60) },
    });
    const result = await lookUpGnss(REQUEST, s.value);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.stations.map((x) => x.station)).toEqual(['NEAR', 'MID_', 'FAR_']);
    expect(s.seriesCalls).toEqual(['NEAR', 'MID_', 'FAR_']); // one round, nothing extra
    expect(result.stations[0]?.positions).toHaveLength(396);
  });

  it('skips a station with a gap over the quake and tries the next', async () => {
    // 18% of real downloads fail this; the window must not show a station
    // that recorded nothing near the quake.
    const s = sources({
      stations: [near, mid, far, station('LAST', 37, -117.6)],
      series: { NEAR: days(-400, 60, [...Array(60).keys()].map((k) => k - 30)), MID_: days(-400, 60), FAR_: days(-400, 60), LAST: days(-400, 60) },
    });
    const result = await lookUpGnss(REQUEST, s.value);
    expect(result.status === 'available' && result.stations.map((x) => x.station)).toEqual(['MID_', 'FAR_', 'LAST']);
    expect(s.seriesCalls).toEqual(['NEAR', 'MID_', 'FAR_', 'LAST']);
  });

  it('shows one id per site', async () => {
    const twin = station('TWIN', 35.8001, -117.6001);
    const s = sources({
      stations: [near, twin, mid],
      series: { NEAR: days(-400, 60), TWIN: days(-400, 60), MID_: days(-400, 60) },
    });
    const result = await lookUpGnss(REQUEST, s.value);
    expect(result.status === 'available' && result.stations.map((x) => x.station)).toEqual(['NEAR', 'MID_']);
    expect(s.seriesCalls).not.toContain('TWIN');
  });

  it('says none, with the nearest recording station, when nothing is in reach', async () => {
    // M7.1 reaches ~575 km; this station is ~1,100 km away.
    const s = sources({ stations: [station('AWAY', 45.7, -117.6)], series: {} });
    const result = await lookUpGnss(REQUEST, s.value);
    expect(result.status).toBe('none');
    expect(result.status === 'none' && Math.round(result.nearestKm ?? 0)).toBeGreaterThan(1000);
    expect(s.seriesCalls).toEqual([]);
  });

  it('says none when every candidate has a gap', async () => {
    const s = sources({ stations: [near], series: { NEAR: days(-400, -60) } });
    expect((await lookUpGnss(REQUEST, s.value)).status).toBe('none');
  });

  it('throws when the station list cannot be fetched, rather than saying none', async () => {
    const s = sources({ stations: null, series: {} });
    await expect(lookUpGnss(REQUEST, s.value)).rejects.toThrow(/station list/);
  });

  it('carries velocity, DOI and only the steps inside the window', async () => {
    const s = sources({
      stations: [near],
      series: { NEAR: days(-400, 60) },
      velocities: new Map([['NEAR', { eastMPerYr: -0.0188, northMPerYr: -0.0025, upMPerYr: -0.0007 }]]),
      pages: {
        NEAR: {
          doi: 'https://doi.org/10.7283/T5C24TDR',
          steps: [
            { dayMs: QUAKE_DAY - 2000 * DAY, kind: 'equipment', detail: 'Antenna_Type_Changed', magnitude: null, distanceKm: null },
            { dayMs: QUAKE_DAY, kind: 'earthquake', detail: 'ci38457511', magnitude: 7.1, distanceKm: 19.5 },
          ],
        },
      },
    });
    const result = await lookUpGnss(REQUEST, s.value);
    if (result.status !== 'available') throw new Error('expected stations');
    const only = result.stations[0];
    expect(only?.velocity?.eastMPerYr).toBe(-0.0188);
    expect(only?.doi).toBe('https://doi.org/10.7283/T5C24TDR');
    expect(only?.steps?.map((step) => step.detail)).toEqual(['ci38457511']);
  });

  it('reports steps as unknown, not as none, when the page could not be read', async () => {
    const s = sources({ stations: [near], series: { NEAR: days(-400, 60) }, pages: { NEAR: null } });
    const result = await lookUpGnss(REQUEST, s.value);
    expect(result.status === 'available' && result.stations[0]?.steps).toBeNull();
  });

  it('still answers without velocities, leaving the drift in', async () => {
    const s = sources({ stations: [near], series: { NEAR: days(-400, 60) }, velocities: null });
    const result = await lookUpGnss(REQUEST, s.value);
    expect(result.status === 'available' && result.stations[0]?.velocity).toBeNull();
  });
});

describe('createKeyedCache', () => {
  it('shares one request per key and reuses the answer', async () => {
    const load = vi.fn((key: string) => Promise.resolve(key.toLowerCase()));
    const get = createKeyedCache(load, { ttlMs: 1000, limit: 4 }, () => 0);
    expect(await Promise.all([get('A'), get('A')])).toEqual(['a', 'a']);
    await get('A');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never caches a failure', async () => {
    let fail = true;
    const get = createKeyedCache(
      () => (fail ? Promise.reject(new Error('down')) : Promise.resolve('ok')),
      { ttlMs: 1000, limit: 4 },
      () => 0,
    );
    await expect(get('A')).rejects.toThrow('down');
    fail = false;
    await expect(get('A')).resolves.toBe('ok');
  });

  it('drops the least recently fetched past its limit', async () => {
    const load = vi.fn((key: string) => Promise.resolve(key));
    const get = createKeyedCache(load, { ttlMs: 1000, limit: 2 }, () => 0);
    await get('A');
    await get('B');
    await get('C');
    await get('A');
    expect(load.mock.calls.map(([key]) => key)).toEqual(['A', 'B', 'C', 'A']);
  });

  it('refetches once an answer is older than its TTL', async () => {
    let clock = 0;
    const load = vi.fn(() => Promise.resolve('x'));
    const get = createKeyedCache(load, { ttlMs: 1000, limit: 2 }, () => clock);
    await get('A');
    clock = 1500;
    await get('A');
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('parseGnssRequest', () => {
  it('accepts a well-formed request', () => {
    expect(parseGnssRequest(REQUEST)).toEqual(REQUEST);
  });

  it('refuses anything malformed, rather than answering "no station"', () => {
    expect(parseGnssRequest(null)).toBeNull();
    expect(parseGnssRequest({ ...REQUEST, latitude: Number.NaN })).toBeNull();
    expect(parseGnssRequest({ ...REQUEST, latitude: 91 })).toBeNull();
    expect(parseGnssRequest({ ...REQUEST, longitude: '-117' })).toBeNull();
    expect(parseGnssRequest({ ...REQUEST, magnitude: 11 })).toBeNull();
    expect(parseGnssRequest({ ...REQUEST, originUtc: 'yesterday' })).toBeNull();
    expect(parseGnssRequest({ ...REQUEST, eventId: 'a b' })).toBeNull();
  });
});
