import { ipcMain } from 'electron';
import { fetchTecGrid } from '@terra-pulse/ingest';
import { TEC_CADENCE_MS, type TecGrid } from '@terra-pulse/schema';

/**
 * Total electron content, fetched **on demand** rather than polled.
 *
 * ## Why this one is pulled and the aurora is pushed
 *
 * Every other space-weather feed here runs on a timer in main and pushes to the
 * renderer. This one does not, and the reason is size: a GloTEC map is **2.4
 * MB**, against 65 KB for an auroral grid — 37 times heavier. Polling it every
 * ten minutes regardless of whether anyone is looking would be roughly **14 MB
 * an hour** spent on a layer that is off by default.
 *
 * So the renderer asks, and only while its layer is mounted. Main caches the
 * answer for one publication cadence, which means several asks in the same
 * ten-minute window cost one fetch — and a reader who never enables the layer
 * costs nothing at all.
 *
 * ## Why it is not persisted
 *
 * Same reason as the aurora: this is the state of a transient. SWPC indexes
 * about a month of maps, so history exists upstream, but nothing in the app can
 * ask for a past map yet — and writing 2.4 MB every ten minutes would be 350 MB
 * a day for data no view requests. If a TEC archive is ever wanted, it wants a
 * deliberate backfill like the earthquake one, not a poll that never forgets.
 */
let cached: { grid: TecGrid; fetchedAtMs: number } | null = null;
let inFlight: Promise<TecGrid> | null = null;

export function registerTecIpcHandlers(): void {
  ipcMain.handle('tec:latest', async (): Promise<TecGrid | null> => {
    const now = Date.now();

    if (cached && now - cached.fetchedAtMs < TEC_CADENCE_MS) return cached.grid;

    // Share one request between concurrent askers. Two layers mounting in the
    // same commit would otherwise pull 4.8 MB to display one map.
    inFlight ??= fetchTecGrid()
      .then((grid) => {
        cached = { grid, fetchedAtMs: Date.now() };
        return grid;
      })
      .finally(() => {
        inFlight = null;
      });

    try {
      return await inFlight;
    } catch (error: unknown) {
      console.error('TEC fetch failed', error);
      // The stale grid rather than nothing: a map twenty minutes old is far
      // more use than an empty globe, and the renderer has the timestamp and
      // decides what is too old to draw.
      return cached?.grid ?? null;
    }
  });
}
