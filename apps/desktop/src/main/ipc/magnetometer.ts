import { ipcMain } from 'electron';
import { fetchMagnetometerStations, fetchStationDisturbance } from '@terra-pulse/ingest';
import type { MagnetometerReading } from '@terra-pulse/schema';

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

export function registerMagnetometerIpcHandlers(): void {
  // Pulled for the first read, like `aurora:latest`: the renderer asks when it
  // is ready, so there is no window in which a push arrives before anyone is
  // listening.
  ipcMain.handle('magnetometer:latest', (): MagnetometerReading[] => latest);
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
        // appearing until restart.
        const stations = await fetchMagnetometerStations();
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
