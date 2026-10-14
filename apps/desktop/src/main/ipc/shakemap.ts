import { ipcMain } from 'electron';
import { fetchShakeMapContours } from '@terra-pulse/ingest';
import type { ShakeMapResult } from '@terra-pulse/schema';

/**
 * Shaking-intensity lines for one earthquake, fetched **when asked for**.
 *
 * Pulled, like the ionosphere map and the magnetometer traces, and for the
 * same reason: nobody is looking at most quakes' lines, so nothing is fetched
 * until a reader turns the lines on with a quake selected.
 *
 * Not stored. A recent quake's map is revised many times in its first days —
 * Panama 2026 was on version 10 within three days — so a saved copy would be
 * the first guess presented as the answer, and every request is two small
 * reads against a CDN.
 */

/** How long an answer is reused. Long enough to click away and back; short enough to pick up a revision. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * How many quakes' answers are kept.
 *
 * Bounded because the lines stay on as the reader moves between quakes, and
 * working down an event list would otherwise keep every map it passed —
 * 5 to 100 KB each, for as long as the app stayed open.
 */
const CACHE_LIMIT = 24;

type Fetcher = (eventId: string) => Promise<ShakeMapResult>;

export interface ShakeMapLookup {
  get(eventId: string): Promise<ShakeMapResult>;
}

/**
 * A small cache in front of the fetch.
 *
 * - **One request per quake at a time.** The inspector and the globe can both
 *   ask in the same commit; the second gets the first's promise.
 * - **A failure is never cached.** One dropped connection must not become
 *   "no map" for ten minutes. `none` *is* cached: that is USGS answering.
 */
export function createShakeMapLookup(
  fetcher: Fetcher,
  now: () => number = Date.now,
): ShakeMapLookup {
  const cached = new Map<string, { result: ShakeMapResult; atMs: number }>();
  const inFlight = new Map<string, Promise<ShakeMapResult>>();

  return {
    get(eventId) {
      const hit = cached.get(eventId);
      if (hit && now() - hit.atMs < CACHE_TTL_MS) return Promise.resolve(hit.result);

      const running = inFlight.get(eventId);
      if (running) return running;

      const request = fetcher(eventId)
        .then((result) => {
          // Re-inserted so the map's insertion order is "least recently
          // fetched first", which is what the trim below drops.
          cached.delete(eventId);
          cached.set(eventId, { result, atMs: now() });
          while (cached.size > CACHE_LIMIT) {
            const oldest = cached.keys().next().value;
            if (oldest === undefined) break;
            cached.delete(oldest);
          }
          return result;
        })
        .finally(() => {
          inFlight.delete(eventId);
        });

      inFlight.set(eventId, request);
      return request;
    },
  };
}

/** USGS event ids are short and plain; anything else is not one. */
const EVENT_ID = /^[A-Za-z0-9_.-]{1,80}$/;

export function registerShakeMapIpcHandlers(): void {
  const lookup = createShakeMapLookup((eventId) => fetchShakeMapContours(eventId));

  ipcMain.handle('shakemap:contours', (_event, eventId: unknown): Promise<ShakeMapResult> => {
    // The id goes into a URL. It is validated here, in main, rather than
    // trusted because the renderer happened to send it.
    if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) {
      return Promise.resolve({ status: 'none' });
    }
    return lookup.get(eventId);
  });
}
