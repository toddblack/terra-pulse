import { ipcMain } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import {
  catalogSignature,
  findCandidateMatches,
  insertEarthquakes,
  queryEarthquakes,
  signaturesMatch,
  type EarthquakeQuery,
} from '@terra-pulse/db';
import {
  fetchEarthquakeFeed,
  fetchEmscEarthquakes,
  fetchRecentEarthquakes,
  isProbableDuplicate,
} from '@terra-pulse/ingest';
import type { EarthquakeEvent, EarthquakeSyncResult } from '@terra-pulse/schema';

/**
 * The widest range the UI can ask for. Everything the user selects is a subset
 * of this, which is why changing the range never needs a fetch.
 *
 * The floor is M1.0 rather than the display default because the low end is
 * where swarm and induced seismicity live. USGS alone is heavily US-biased
 * there (86% at M1+, 6% at M4+); EMSC fills the non-US gap. See PROJECT_PLAN
 * §10 for the measurements.
 */
const INGEST_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;
const INGEST_MIN_MAGNITUDE = 1.0;

/**
 * The summary feeds are CDN-cached with `Cache-Control: max-age=60`, so
 * polling faster returns byte-identical data. 60s is the ceiling on useful
 * freshness, not a compromise.
 */
const POLL_INTERVAL_MS = 60_000;

/**
 * Feed bucket labels are approximate — a "2.5_day" response was observed
 * containing an M2.46, because USGS revises magnitudes after an event lands in
 * a bucket. Applying the floor here keeps the catalogue answerable with one
 * rule rather than "M1+, mostly". Adapters stay faithful to their source
 * (non-negotiable #7); policy lives at the call site.
 */
function atOrAboveFloor(events: EarthquakeEvent[]): EarthquakeEvent[] {
  return events.filter((event) => event.magnitude >= INGEST_MIN_MAGNITUDE);
}

/**
 * Stores EMSC events that aren't already covered by a USGS record.
 *
 * USGS wins every match: it carries PAGER alert, tsunami flag and
 * significance, none of which EMSC provides. EMSC exists purely to fill the
 * sub-M4 coverage gap outside the United States.
 *
 * Matching consults the *database*, not just the current batch — an EMSC event
 * may duplicate a USGS record ingested on an earlier poll. `findCandidateMatches`
 * narrows via the R-Tree so this stays cheap across hundreds of candidates.
 */
function insertEmscFillingGaps(db: DatabaseSync, emscEvents: EarthquakeEvent[]): void {
  const novel = emscEvents.filter((candidate) => {
    const nearbyUsgs = findCandidateMatches(db, candidate, 'usgs');
    return !nearbyUsgs.some((known) => isProbableDuplicate(candidate, known));
  });

  insertEarthquakes(db, novel);
}

/**
 * Backfill the full display window. Runs on every launch — this is what closes
 * the gap from the app having been shut, and it's the only endpoint that takes
 * an arbitrary time range.
 */
async function backfillEarthquakes(db: DatabaseSync): Promise<EarthquakeEvent[]> {
  const endUtc = new Date();
  const startUtc = new Date(endUtc.getTime() - INGEST_WINDOW_MS);
  // USGS first and unconditionally — it is the authoritative source, so its
  // records must already be present before EMSC is tested against them.
  const usgsEvents = await fetchRecentEarthquakes({
    startUtc,
    endUtc,
    minMagnitude: INGEST_MIN_MAGNITUDE,
  });
  insertEarthquakes(db, atOrAboveFloor(usgsEvents));

  // EMSC is supplementary: if it fails, the globe still works with USGS data.
  try {
    const emscEvents = await fetchEmscEarthquakes({
      startUtc,
      minMagnitude: INGEST_MIN_MAGNITUDE,
    });
    insertEmscFillingGaps(db, atOrAboveFloor(emscEvents));
  } catch (error: unknown) {
    console.error('EMSC backfill failed; continuing with USGS only', error);
  }

  return usgsEvents;
}

/**
 * One poll of the cached summary feed.
 *
 * An empty response is a normal quiet period, not an error and not a signal to
 * clear anything — the upsert simply has nothing to do.
 */
async function pollOnce(db: DatabaseSync): Promise<EarthquakeSyncResult> {
  const before = catalogSignature(db);

  const usgsEvents = await fetchEarthquakeFeed('1.0_day');
  insertEarthquakes(db, atOrAboveFloor(usgsEvents));

  try {
    const emscEvents = await fetchEmscEarthquakes({
      startUtc: new Date(Date.now() - 24 * 60 * 60 * 1000),
      minMagnitude: INGEST_MIN_MAGNITUDE,
    });
    insertEmscFillingGaps(db, atOrAboveFloor(emscEvents));
  } catch (error: unknown) {
    console.error('EMSC poll failed; continuing with USGS only', error);
  }

  const after = catalogSignature(db);

  return {
    changed: !signaturesMatch(before, after),
    syncedAt: new Date().toISOString(),
  };
}

/**
 * Starts the 60s poll loop. Returns a stop function for app shutdown.
 *
 * `onResult` fires on every *successful* poll, changed or not, so the UI's
 * freshness indicator stays honest through quiet periods. Failures are logged
 * and swallowed: a dropped network must not kill the loop.
 */
export function startEarthquakePolling(
  db: DatabaseSync,
  onResult: (result: EarthquakeSyncResult) => void,
): () => void {
  let stopped = false;

  const tick = () => {
    pollOnce(db).then(
      (result) => {
        if (!stopped) onResult(result);
      },
      (error: unknown) => {
        console.error('Earthquake poll failed (will retry)', error);
      },
    );
  };

  const interval = setInterval(tick, POLL_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

export function registerEarthquakeIpcHandlers(db: DatabaseSync): void {
  ipcMain.handle('earthquakes:query', (_event, query: EarthquakeQuery = {}): EarthquakeEvent[] => {
    return queryEarthquakes(db, query);
  });

  ipcMain.handle('earthquakes:refresh', async (): Promise<EarthquakeEvent[]> => {
    await pollOnce(db);
    return queryEarthquakes(db, {});
  });
}

export { backfillEarthquakes };
