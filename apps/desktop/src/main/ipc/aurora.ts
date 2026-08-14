import { ipcMain } from 'electron';
import { fetchAuroraGrid } from '@terra-pulse/ingest';
import { AURORA_POLL_INTERVAL_MS, type AuroraGrid } from '@terra-pulse/schema';

/**
 * The auroral oval, polled from NOAA SWPC.
 *
 * ## Why it is cached in memory rather than in SQLite
 *
 * Everything else this app stores is a *record* — an earthquake happened, and it
 * stays true. This is a **forecast of a transient**: a grid describing the next
 * hour, superseded every five minutes and worthless once it is. Writing it to
 * disk would grow the database by 65 KB a poll — 19 MB a day — to hold data no
 * view can ever ask for again. Nothing about the layer is historical, so there
 * is nothing to keep.
 *
 * The consequence, stated plainly: **the aurora layer shows nothing until the
 * first successful fetch, and nothing at all offline.** That is honest. A stale
 * oval presented as current would be worse than an empty one, which is also why
 * the grid carries its own timestamps to the renderer.
 */
let latest: AuroraGrid | null = null;

export function registerAuroraIpcHandlers(): void {
  // Pulled rather than pushed for the first read, like `earthquakes:missed`:
  // the renderer asks when it is ready, so there is no window in which a send
  // arrives before anyone is listening.
  ipcMain.handle('aurora:latest', (): AuroraGrid | null => latest);
}

/**
 * Polls SWPC and pushes each new grid to the renderer.
 *
 * Returns a stop function, and — like the earthquake poll — **fires once
 * immediately** rather than waiting out the first interval, so the layer isn't
 * blank for five minutes after launch.
 *
 * Failures are logged and retried on the next tick rather than surfaced: the
 * layer is off by default and a space-weather feed being briefly unreachable is
 * not something to interrupt anyone over. `latest` is deliberately **not**
 * cleared on failure — the renderer decides what is too old to draw, using the
 * timestamps it already has.
 */
export function startAuroraPolling(
  onGrid: (grid: AuroraGrid) => void,
  intervalMs: number = AURORA_POLL_INTERVAL_MS,
): () => void {
  let stopped = false;

  const tick = () => {
    fetchAuroraGrid().then(
      (grid) => {
        if (stopped) return;
        latest = grid;
        onGrid(grid);
      },
      (error: unknown) => {
        console.error('Aurora poll failed (will retry)', error);
      },
    );
  };

  tick();
  const timer = setInterval(tick, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Test seam: drops the cached grid between cases. */
export function resetAuroraCache(): void {
  latest = null;
}
