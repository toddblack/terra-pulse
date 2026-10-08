import { ipcMain } from 'electron';
import {
  SEEDLINK_SERVERS,
  buildStationCatalogue,
  fetchRingInventory,
  fetchSeedLinkInventory,
  fetchStationListing,
  type StationListing,
} from '@terra-pulse/ingest';
import {
  SEEDLINK_SERVER_IDS,
  type SeedLinkServerId,
  type WaveformStation,
  type WaveformStationCatalogue,
} from '@terra-pulse/schema';

/**
 * The station list behind the waveform picker, and the ring inventory it is
 * built from — both cached here so that first opening the waveform tab costs
 * one fetch of each rather than one per asker.
 *
 * The inventory has two consumers: the stream controller (to mark absent
 * channels `rejected`) and the catalogue (to keep only stations the ring
 * carries). Without sharing it, starting the stream would pull the same 1.2 MB
 * list twice, in parallel.
 */

/** Stations join and leave the ring over days, so an hour is plenty fresh. */
export const WAVEFORM_STATIONS_TTL_MS = 60 * 60_000;

export interface CachedLoader<T> {
  /** The cached value if fresh, else the in-flight load, else a new one. */
  get(): Promise<T | null>;
}

/**
 * A TTL cache around an async load that can fail.
 *
 * Two properties carry the weight, and both come from `tec.ts`'s cache:
 *
 * - **One in-flight load is shared** between every caller that arrives while it
 *   runs. StrictMode double-mounts every effect, so "two at once" is the normal case
 *   in development, not an edge.
 * - **A failure is not cached.** One dropped connection must not look like a
 *   permanent absence for the next hour; the next caller simply tries again.
 */
export function createCachedLoader<T>(
  load: () => Promise<T | null>,
  ttlMs: number,
  now: () => number = () => Date.now(),
): CachedLoader<T> {
  let cached: { atMs: number; value: T } | null = null;
  let inFlight: Promise<T | null> | null = null;

  return {
    get() {
      if (cached !== null && now() - cached.atMs < ttlMs) return Promise.resolve(cached.value);
      inFlight ??= load()
        .then((value) => {
          if (value !== null) cached = { atMs: now(), value };
          return value;
        })
        .catch(() => null)
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

export interface WaveformStationSources {
  /** EarthScope's ring inventory. */
  inventory: CachedLoader<Set<string>>;
  /** Any server's ring inventory — what its stream controller marks channels against. */
  inventoryFor: (server: SeedLinkServerId) => CachedLoader<Set<string>>;
  catalogue: () => Promise<WaveformStationCatalogue>;
}

export interface ServerFetchers {
  fetchInventory: () => Promise<Set<string> | null>;
  fetchListing: () => Promise<StationListing | null>;
}

export interface WaveformStationSourceOptions {
  /** EarthScope's fetchers. */
  fetchInventory?: () => Promise<Set<string> | null>;
  fetchListing?: () => Promise<StationListing | null>;
  /** Servers beyond EarthScope, merged into the catalogue. None when absent. */
  others?: Partial<Record<SeedLinkServerId, ServerFetchers>>;
  now?: () => number;
}

/** The real fetchers for a server, from `SEEDLINK_SERVERS`. */
export function serverFetchers(id: SeedLinkServerId): ServerFetchers {
  const server = SEEDLINK_SERVERS[id];
  return {
    fetchInventory:
      server.inventory === 'streamids'
        ? () => fetchRingInventory(fetch, server.host, server.port)
        : () => fetchSeedLinkInventory(server.host, server.port),
    fetchListing: () => fetchStationListing({ serviceUrl: server.stationServiceUrl, networks: server.networks }),
  };
}

/**
 * The shared inventory, and the catalogue built on it.
 *
 * **The two fetches run side by side** and meet only at the join: measured
 * ~3.1 s for the ring's list and ~2.8 s for the station service, so in sequence
 * the picker had nothing for ~6 s after the stream started, and together ~3 s.
 * When the stream starts the controller has usually already started the
 * inventory fetch, and this joins that one rather than starting another.
 *
 * The catalogue says *which* half failed, because the two fail for different
 * reasons and point at different services: the ring's list comes from the
 * SeedLink host itself, the coordinates from the FDSN station service.
 */
export function createWaveformStationSources(
  options: WaveformStationSourceOptions = {},
): WaveformStationSources {
  const {
    fetchInventory = () => fetchRingInventory(),
    fetchListing = () => fetchStationListing(),
    others = {},
    now = () => Date.now(),
  } = options;

  const fetchers = new Map<SeedLinkServerId, ServerFetchers>([['earthscope', { fetchInventory, fetchListing }]]);
  for (const id of SEEDLINK_SERVER_IDS) {
    const extra = others[id];
    if (id !== 'earthscope' && extra !== undefined) fetchers.set(id, extra);
  }

  const inventories = new Map<SeedLinkServerId, CachedLoader<Set<string>>>();
  const inventoryFor = (id: SeedLinkServerId): CachedLoader<Set<string>> => {
    let loader = inventories.get(id);
    if (loader === undefined) {
      const fetchOne = fetchers.get(id)?.fetchInventory ?? (() => Promise.resolve(null));
      loader = createCachedLoader(fetchOne, WAVEFORM_STATIONS_TTL_MS, now);
      inventories.set(id, loader);
    }
    return loader;
  };

  /** One server's stations, or why not — each cached on its own. */
  const failures = new Map<SeedLinkServerId, string>();
  const perServer = new Map<SeedLinkServerId, CachedLoader<WaveformStation[]>>();
  for (const [id, fetcher] of fetchers) {
    perServer.set(
      id,
      createCachedLoader<WaveformStation[]>(
        async () => {
          const [onRing, listing] = await Promise.all([inventoryFor(id).get(), fetcher.fetchListing()]);
          if (onRing === null) {
            failures.set(id, "the ring's stream list could not be fetched");
            return null;
          }
          if (listing === null) {
            failures.set(id, 'station coordinates could not be fetched from the FDSN station service');
            return null;
          }
          const list = buildStationCatalogue(listing.channelRows, listing.stationRows, onRing, id);
          // Both services answered and agree on nothing: one of them has changed
          // what it means by a channel id. Not "no stations anywhere".
          if (list.length === 0) {
            failures.set(id, 'none of the listed stations matched the ring — a format may have changed');
            return null;
          }
          return list;
        },
        WAVEFORM_STATIONS_TTL_MS,
        now,
      ),
    );
  }

  return {
    inventory: inventoryFor('earthscope'),
    inventoryFor,
    /**
     * Every server that answered, merged. A server that failed is left out
     * rather than failing the whole list — New Zealand being unreachable must
     * not take California with it — and the list is unavailable only when every
     * server failed, with EarthScope's reason, since that is the one most
     * readers depend on.
     *
     * A station on two servers is kept once, **EarthScope's copy first**:
     * replays and gains have worked against its archive and station service
     * since the start, and choosing per server would make a row's source depend
     * on which list answered first.
     */
    async catalogue() {
      const lists = await Promise.all(
        [...perServer.entries()].map(async ([id, loader]) => ({ id, stations: await loader.get() })),
      );
      const merged: WaveformStation[] = [];
      const seen = new Set<string>();
      for (const { stations } of lists) {
        for (const station of stations ?? []) {
          const key = `${station.network}_${station.station}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(station);
        }
      }
      if (merged.length === 0) {
        return {
          status: 'unavailable',
          reason: failures.get('earthscope') ?? [...failures.values()][0] ?? 'the station list could not be fetched',
        };
      }
      for (const { id, stations } of lists) {
        if (stations === null) console.warn(`Station list from ${SEEDLINK_SERVERS[id].label} unavailable: ${failures.get(id) ?? 'unknown'}`);
      }
      return { status: 'ready', stations: merged, fetchedAtMs: now() };
    },
  };
}

/**
 * `waveforms:stations`. Pulled by the renderer once the waveform stream is
 * first asked for — nothing fetches this at launch, for the same reason nothing
 * opens the socket then.
 *
 * ~3,200 stations is ~300 KB of structured clone, once per Explore mount; the
 * fetch itself is cached above, so switching modes back and forth costs only
 * that.
 */
export function registerWaveformStationHandlers(sources: WaveformStationSources): void {
  ipcMain.handle('waveforms:stations', (): Promise<WaveformStationCatalogue> => sources.catalogue());
}
