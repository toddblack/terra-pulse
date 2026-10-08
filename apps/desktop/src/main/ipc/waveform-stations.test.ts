import { describe, expect, it, vi } from 'vitest';
import type { StationListing } from '@terra-pulse/ingest';
import type { WaveformStation } from '@terra-pulse/schema';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import {
  WAVEFORM_STATIONS_TTL_MS,
  createCachedLoader,
  createWaveformStationSources,
} from './waveform-stations';

const RATT: WaveformStation = {
  network: 'UW',
  station: 'RATT',
  location: '',
  channel: 'HHZ',
  latitude: 47.6,
  longitude: -122.3,
  site: 'Rattlesnake Mountain',
  sampleRateHz: 100,
};

/** A promise whose resolution the test controls. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('createCachedLoader', () => {
  it('shares one in-flight load between callers, which StrictMode makes the normal case', async () => {
    const pending = deferred<string | null>();
    const load = vi.fn(() => pending.promise);
    const loader = createCachedLoader(load, 1_000);

    const first = loader.get();
    const second = loader.get();
    pending.resolve('list');

    expect(await first).toBe('list');
    expect(await second).toBe('list');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('serves a fresh value from cache and reloads once it expires', async () => {
    let clock = 0;
    const load = vi.fn(() => Promise.resolve('list'));
    const loader = createCachedLoader(load, 1_000, () => clock);

    await loader.get();
    clock = 999;
    await loader.get();
    expect(load).toHaveBeenCalledTimes(1);

    clock = 1_000;
    await loader.get();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failure, so one dropped connection is not an hour of absence', async () => {
    const load = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce(null).mockResolvedValue('list');
    const loader = createCachedLoader(load, 1_000);

    expect(await loader.get()).toBeNull();
    expect(await loader.get()).toBe('list');
  });

  it('turns a thrown load into null rather than a rejection', async () => {
    const loader = createCachedLoader(() => Promise.reject(new Error('boom')), 1_000);
    expect(await loader.get()).toBeNull();
  });
});

/** What the station service says about RATT, before the ring join. */
const RATT_LISTING: StationListing = {
  channelRows: [
    {
      Network: 'UW',
      Station: 'RATT',
      Location: '',
      Channel: 'HHZ',
      Latitude: '47.6',
      Longitude: '-122.3',
      SampleRate: '100',
    },
  ],
  stationRows: [{ Network: 'UW', Station: 'RATT', SiteName: 'Rattlesnake Mountain' }],
};
const RATT_ON_RING = () => Promise.resolve(new Set(['UW_RATT__HHZ']));

describe('createWaveformStationSources', () => {
  it('builds the catalogue on the shared inventory, fetching each once', async () => {
    const onRing = new Set(['UW_RATT__HHZ']);
    const fetchInventory = vi.fn(() => Promise.resolve(onRing));
    const fetchListing = vi.fn(() => Promise.resolve(RATT_LISTING));
    const sources = createWaveformStationSources({ fetchInventory, fetchListing, now: () => 5 });

    // The stream controller and the picker both ask on mount.
    const [inventory, catalogue] = await Promise.all([sources.inventory.get(), sources.catalogue()]);

    expect(inventory).toBe(onRing);
    expect(catalogue).toEqual({ status: 'ready', stations: [RATT], fetchedAtMs: 5 });
    expect(fetchInventory).toHaveBeenCalledTimes(1);
    expect(fetchListing).toHaveBeenCalledTimes(1);
  });

  it("starts the station service fetch without waiting for the ring's list", async () => {
    // Measured ~3.1 s and ~2.8 s: in sequence the picker waited ~6 s.
    const ring = deferred<Set<string> | null>();
    const fetchListing = vi.fn(() => Promise.resolve(RATT_LISTING));
    const sources = createWaveformStationSources({ fetchInventory: () => ring.promise, fetchListing });

    const pending = sources.catalogue();
    expect(fetchListing).toHaveBeenCalledTimes(1);

    ring.resolve(new Set(['UW_RATT__HHZ']));
    expect((await pending).status).toBe('ready');
  });

  it("says the ring's list was the missing half when that is what failed", async () => {
    const sources = createWaveformStationSources({
      fetchInventory: () => Promise.resolve(null),
      fetchListing: () => Promise.resolve(RATT_LISTING),
    });
    expect(await sources.catalogue()).toEqual({
      status: 'unavailable',
      reason: "the ring's stream list could not be fetched",
    });
  });

  it('says the station service was the missing half when that is what failed', async () => {
    const sources = createWaveformStationSources({
      fetchInventory: RATT_ON_RING,
      fetchListing: () => Promise.resolve(null),
    });
    const result = await sources.catalogue();
    expect(result.status).toBe('unavailable');
    expect(result.status === 'unavailable' && result.reason).toMatch(/station service/);
  });

  it('treats two answers that share no station as a failure, not as an empty world', async () => {
    const sources = createWaveformStationSources({
      fetchInventory: () => Promise.resolve(new Set(['CI_ADO__HHZ'])),
      fetchListing: () => Promise.resolve(RATT_LISTING),
    });
    const result = await sources.catalogue();
    expect(result.status).toBe('unavailable');
    expect(result.status === 'unavailable' && result.reason).toMatch(/matched the ring/);
  });

  it('retries after a failure rather than reporting it for the rest of the hour', async () => {
    const fetchListing = vi
      .fn<() => Promise<StationListing | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(RATT_LISTING);
    const sources = createWaveformStationSources({ fetchInventory: RATT_ON_RING, fetchListing });

    expect((await sources.catalogue()).status).toBe('unavailable');
    expect((await sources.catalogue()).status).toBe('ready');
  });

  it('keeps a good list for the TTL', async () => {
    let clock = 0;
    const fetchListing = vi.fn(() => Promise.resolve(RATT_LISTING));
    const sources = createWaveformStationSources({
      fetchInventory: RATT_ON_RING,
      fetchListing,
      now: () => clock,
    });

    await sources.catalogue();
    clock = WAVEFORM_STATIONS_TTL_MS - 1;
    await sources.catalogue();
    expect(fetchListing).toHaveBeenCalledTimes(1);
  });
});

describe('createWaveformStationSources with more than one server', () => {
  const WEL_LISTING: StationListing = {
    channelRows: [
      {
        Network: 'NZ',
        Station: 'WEL',
        Location: '10',
        Channel: 'HHZ',
        Latitude: '-41.28',
        Longitude: '174.77',
        SampleRate: '100',
      },
    ],
    stationRows: [],
  };
  const geonet = (listing: StationListing | null = WEL_LISTING) => ({
    fetchInventory: () => Promise.resolve(new Set(['NZ_WEL_10_HHZ'])),
    fetchListing: () => Promise.resolve(listing),
  });

  it("merges every server's stations, each tagged with its own", async () => {
    const sources = createWaveformStationSources({
      fetchInventory: RATT_ON_RING,
      fetchListing: () => Promise.resolve(RATT_LISTING),
      others: { geonet: geonet() },
    });
    const catalogue = await sources.catalogue();
    if (catalogue.status !== 'ready') throw new Error('expected a list');
    expect(catalogue.stations.map((s) => [s.station, s.server ?? 'earthscope'])).toEqual([
      ['RATT', 'earthscope'],
      ['WEL', 'geonet'],
    ]);
    expect([...((await sources.inventoryFor('geonet').get()) ?? [])]).toEqual(['NZ_WEL_10_HHZ']);
  });

  it("keeps one server's stations when another fails, so New Zealand cannot take California with it", async () => {
    const sources = createWaveformStationSources({
      fetchInventory: RATT_ON_RING,
      fetchListing: () => Promise.resolve(RATT_LISTING),
      others: { geonet: geonet(null) },
    });
    const catalogue = await sources.catalogue();
    expect(catalogue.status === 'ready' ? catalogue.stations.map((s) => s.station) : catalogue).toEqual(['RATT']);
  });

  it('is unavailable only when every server failed, with EarthScope’s reason', async () => {
    const sources = createWaveformStationSources({
      fetchInventory: () => Promise.resolve(null),
      fetchListing: () => Promise.resolve(RATT_LISTING),
      others: { geonet: geonet(null) },
    });
    expect(await sources.catalogue()).toEqual({
      status: 'unavailable',
      reason: "the ring's stream list could not be fetched",
    });
  });

  it("keeps EarthScope's copy of a station both servers list", async () => {
    const sources = createWaveformStationSources({
      fetchInventory: RATT_ON_RING,
      fetchListing: () => Promise.resolve(RATT_LISTING),
      others: {
        geonet: {
          fetchInventory: RATT_ON_RING,
          fetchListing: () => Promise.resolve(RATT_LISTING),
        },
      },
    });
    const catalogue = await sources.catalogue();
    if (catalogue.status !== 'ready') throw new Error('expected a list');
    expect(catalogue.stations).toHaveLength(1);
    expect(catalogue.stations[0]).not.toHaveProperty('server');
  });
});
