import { ipcMain } from 'electron';
import {
  fetchMagnetometerStations,
  fetchStationDisturbance,
  fetchStationSeries,
} from '@terra-pulse/ingest';
import type {
  MagnetometerReading,
  MagnetometerSeries,
  MagnetometerStation,
} from '@terra-pulse/schema';

/**
 * Ground magnetometer disturbance, polled from the USGS geomagnetism service.
 *
 * ## Why only ~30 stations, when INTERMAGNET lists 138
 *
 * INTERMAGNET's free service serves **definitive data only, and embargoes the
 * recent end** — measured: 2024 returns full minute data, 2025 onward returns
 * empty arrays, and the last few days come back with `embargo_applied: true`
 * and every value null. There is no free path to a dense *live* magnetometer
 * map. USGS is the only source that answers for right now.
 *
 * The cost is coverage, and it is worth stating because the map looks sparse:
 * measured against this app's own catalogue, **7.5%** of M7+ events have a USGS
 * station within 500 km, against 21.3% for INTERMAGNET's full network. The live
 * view is real but thin, and heavily northern — 10 of 31 stations sit below 45
 * degrees latitude.
 *
 * INTERMAGNET would have been the right source for the *past*, where its
 * definitive data and 138 stations are what a per-station analysis wants. That
 * analysis was **H4b, withdrawn unrun on 2026-08-20**, so the archive was never
 * built and this layer is deliberately all there is. It holds nothing on disk.
 *
 * ## Why it is cached in memory, like the aurora
 *
 * This is a reading of a transient, not a record — the disturbance in the last
 * hour is superseded by the next hour and no view can ask for it again. The
 * archive, when it lands, is where history belongs.
 */
let latest: MagnetometerReading[] = [];

/** How often the network is re-read. */
export const MAGNETOMETER_POLL_INTERVAL_MS = 5 * 60_000;

/** How far back each station's range is measured over. */
const WINDOW_MS = 60 * 60_000;

/**
 * The last station list that arrived, kept across polls.
 *
 * **A failed observatories request used to blank the whole feature**, and it
 * was reported as the timeline row "showing nothing for most earthquakes". The
 * poll assigns `latest` only after `fetchMagnetometerStations()` resolves, so a
 * single connect timeout — common on a flaky link, and this service is one of
 * five that time out together when a machine drops its route — left `latest`
 * empty. The globe layer merely looked sparse; the timeline row, which needs
 * the list just to find the *nearest* station, went completely silent and
 * stayed that way until a poll happened to succeed.
 *
 * Retaining the list separates the two failures that were being conflated: "we
 * do not know what stations exist" is a cold-start problem, while "we know the
 * stations but could not read them this cycle" is the ordinary case, and only
 * the first should silence the row.
 */
let knownStations: MagnetometerStation[] = [];

async function fetchStationsWithFallback(): Promise<MagnetometerStation[]> {
  try {
    const stations = await fetchMagnetometerStations();
    if (stations.length > 0) knownStations = stations;
    return stations;
  } catch (error: unknown) {
    // Rethrow only when there is nothing to fall back to, so the caller's
    // existing "nothing to draw" path still applies on a cold start.
    if (knownStations.length === 0) throw error;
    console.error('Magnetometer station list failed; reusing the last one', error);
    return knownStations;
  }
}

/**
 * Cached traces for the timeline row, keyed by station and window.
 *
 * **On demand, not polled** — the same call `tec.ts` makes and for a stronger
 * reason: this one's argument is a *window the reader chose*, so there is
 * nothing a timer could usefully pre-fetch. A trace is only wanted while the
 * magnetometer row is switched on and something is selected.
 *
 * Unlike TEC there is no publication cadence to expire against, because a past
 * window's data does not change — so entries are kept until the map is full
 * and then the oldest is dropped. `MAX_CACHED_SERIES` is small because a 30-day
 * trace is ~43,000 samples: scrubbing across the archive would otherwise
 * accumulate hundreds of megabytes in main.
 */
const MAX_CACHED_SERIES = 12;
const seriesCache = new Map<string, MagnetometerSeries | null>();
const seriesInFlight = new Map<string, Promise<MagnetometerSeries | null>>();

export function registerMagnetometerIpcHandlers(): void {
  // Pulled for the first read, like `aurora:latest`: the renderer asks when it
  // is ready, so there is no window in which a push arrives before anyone is
  // listening.
  ipcMain.handle('magnetometer:latest', (): MagnetometerReading[] => latest);

  /**
   * One station's horizontal-component trace over a window.
   *
   * Returns null when no USGS product covers it, which is an ordinary answer
   * rather than a failure — nothing is served before 1987, and the coverage
   * between products has real holes. See `MagnetometerProduct`.
   */
  ipcMain.handle(
    'magnetometer:series',
    async (
      _event,
      request: { code: string; startUtc: string; endUtc: string },
    ): Promise<MagnetometerSeries | null> => {
      const key = `${request.code}|${request.startUtc}|${request.endUtc}`;
      if (seriesCache.has(key)) return seriesCache.get(key) ?? null;

      // Share one request between concurrent askers. Scrubbing produces a burst
      // of identical asks, and each miss is up to four upstream requests.
      let pending = seriesInFlight.get(key);
      if (!pending) {
        pending = fetchStationSeries(
          request.code,
          new Date(request.startUtc),
          new Date(request.endUtc),
        )
          .then((series) => {
            if (seriesCache.size >= MAX_CACHED_SERIES) {
              const oldest = seriesCache.keys().next().value;
              if (oldest !== undefined) seriesCache.delete(oldest);
            }
            seriesCache.set(key, series);
            return series;
          })
          .finally(() => {
            seriesInFlight.delete(key);
          });
        seriesInFlight.set(key, pending);
      }

      try {
        return await pending;
      } catch (error: unknown) {
        // Not cached: a transport failure says nothing about whether the window
        // is covered, and caching it would make one dropped connection look
        // like a permanent gap in the record.
        console.error('Magnetometer series fetch failed', error);
        return null;
      }
    },
  );
}

/**
 * Polls the network and pushes each refresh to the renderer.
 *
 * Fires once immediately rather than waiting out the first interval, like the
 * other polls, so the layer is not blank for five minutes after launch.
 *
 * Station readings are fetched **concurrently and settled individually**:
 * measured, 13 of 31 stations report in any given hour, and observatories drop
 * out for maintenance constantly. One station failing must not cost the other
 * thirty their refresh — and a station with no reading is drawn as *no
 * reading*, never as quiet.
 */
export function startMagnetometerPolling(
  onReadings: (readings: MagnetometerReading[]) => void,
  intervalMs: number = MAGNETOMETER_POLL_INTERVAL_MS,
): () => void {
  let stopped = false;
  let inFlight = false;

  const tick = () => {
    if (inFlight) return;
    inFlight = true;

    void (async () => {
      try {
        // The station list barely changes, but it is one small request and
        // caching it across a session would mean a new observatory never
        // appearing until restart. It *is* retained on failure, though — see
        // `knownStations`.
        const stations = await fetchStationsWithFallback();
        const endUtc = new Date();
        const startUtc = new Date(endUtc.getTime() - WINDOW_MS);

        const readings = await Promise.all(
          stations.map(async (station) => {
            const disturbance = await fetchStationDisturbance(
              station.code,
              startUtc,
              endUtc,
            ).catch(() => null);
            return { station, disturbance };
          }),
        );

        if (stopped) return;
        latest = readings;
        onReadings(readings);
      } catch (error: unknown) {
        // The station list itself failed; nothing to draw. Kept rather than
        // cleared, so a blip does not empty a layer that was fine a moment ago.
        console.error('Magnetometer poll failed (will retry)', error);
      } finally {
        inFlight = false;
      }
    })();
  };

  tick();
  const timer = setInterval(tick, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
