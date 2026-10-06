import { ipcMain } from 'electron';
import {
  buildStationCatalogue,
  fetchRingInventory,
  fetchStationListing,
  type StationListing,
} from '@terra-pulse/ingest';
import type { WaveformStation, WaveformStationCatalogue } from '@terra-pulse/schema';

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
  inventory: CachedLoader<Set<string>>;
  catalogue: () => Promise<WaveformStationCatalogue>;
}

export interface WaveformStationSourceOptions {
  fetchInventory?: () => Promise<Set<string> | null>;
  fetchListing?: () => Promise<StationListing | null>;
  now?: () => number;
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
    now = () => Date.now(),
  } = options;

  const inventory = createCachedLoader(fetchInventory, WAVEFORM_STATIONS_TTL_MS, now);

  let lastFailure = '';
  const stations = createCachedLoader<{ stations: WaveformStation[]; fetchedAtMs: number }>(
    async () => {
      const [onRing, listing] = await Promise.all([inventory.get(), fetchListing()]);
      if (onRing === null) {
        lastFailure = "the ring's stream list could not be fetched";
        return null;
      }
      if (listing === null) {
        lastFailure = 'station coordinates could not be fetched from the FDSN station service';
        return null;
      }
      const list = buildStationCatalogue(listing.channelRows, listing.stationRows, onRing);
      // Both services answered and agree on nothing: one of them has changed
      // what it means by a channel id. Not "no stations anywhere".
      if (list.length === 0) {
        lastFailure = 'none of the listed stations matched the ring — a format may have changed';
        return null;
      }
      return { stations: list, fetchedAtMs: now() };
    },
    WAVEFORM_STATIONS_TTL_MS,
    now,
  );

  return {
    inventory,
    async catalogue() {
      const result = await stations.get();
      return result === null
        ? { status: 'unavailable', reason: lastFailure || 'the station list could not be fetched' }
        : { status: 'ready', ...result };
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
