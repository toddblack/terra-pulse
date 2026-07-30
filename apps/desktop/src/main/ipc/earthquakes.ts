import { ipcMain } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import {
  catalogSignature,
  findCandidateMatches,
  insertEarthquakes,
  pruneEarthquakesBefore,
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
import {
  ingestPasses,
  longestCoverageHours,
  type EarthquakeEvent,
  type EarthquakeSyncResult,
} from '@terra-pulse/schema';

/**
 * What gets fetched is derived from `COVERAGE_TIERS`, not declared here.
 *
 * The renderer's selectors read the same constant, so the set of views the UI
 * offers and the set the database actually holds cannot drift apart. Six tiers
 * collapse to two fetches — 7 days at M1+, 30 days at M2.5+ — because tiers
 * nest and `ingestPasses` keeps only the longest window per floor.
 *
 * The low floor exists because that's where swarm and induced seismicity live.
 * USGS alone is heavily US-biased there (86% at M1+, 6% at M4+); EMSC fills the
 * non-US gap. See PROJECT_PLAN §10.
 */
const HOUR_MS = 60 * 60 * 1000;

/** The oldest data worth keeping — anything past the longest tier is dead. */
const RETENTION_MS = longestCoverageHours() * HOUR_MS;

/** The floor of the densest pass, used by the poll and the feed filter. */
const INGEST_MIN_MAGNITUDE = Math.min(...ingestPasses().map((pass) => pass.minMagnitude));

/**
 * How often the background poll runs.
 *
 * The summary feeds are CDN-cached with `Cache-Control: max-age=60`, so 60s is
 * the *fastest* useful rate — this used to poll at exactly that, on the
 * reasoning that anything slower threw away real freshness.
 *
 * That reasoning only counted one side. Every poll that finds new events
 * rebuilds the earthquake layer, and a rebuild lands as a visible hitch if it
 * happens while the user is rotating the globe. Once a minute, that's often
 * enough to be intrusive during ordinary use. Five minutes is quiet enough not
 * to interrupt, and no earthquake becomes less interesting for having been on
 * screen four minutes later.
 *
 * The freshness that matters is on demand, not on a timer: the legend shows
 * how stale the data is and offers a Refresh button, so anyone who wants this
 * second's catalogue can have it without the app twitching all day.
 */
const POLL_INTERVAL_MS = 5 * 60_000;

/**
 * Feed bucket labels are approximate — a "2.5_day" response was observed
 * containing an M2.46, because USGS revises magnitudes after an event lands in
 * a bucket. Applying the floor here keeps the catalogue answerable with one
 * rule rather than "M1+, mostly". Adapters stay faithful to their source
 * (non-negotiable #7); policy lives at the call site.
 */
function atOrAboveFloor(
  events: EarthquakeEvent[],
  floor: number = INGEST_MIN_MAGNITUDE,
): EarthquakeEvent[] {
  return events.filter((event) => event.magnitude >= floor);
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
 * Backfill every coverage tier. Runs on every launch — this is what closes the
 * gap from the app having been shut, and FDSN's is the only endpoint taking an
 * arbitrary time range.
 *
 * One pass per distinct magnitude floor, shortest window first so the dense
 * recent data lands before the long sparse sweep. Passes overlap by design: the
 * 30-day pass re-reads the last 7 days at its own floor, and the upsert absorbs
 * that without duplicating rows.
 */
async function backfillEarthquakes(db: DatabaseSync): Promise<EarthquakeEvent[]> {
  const endUtc = new Date();
  const collected: EarthquakeEvent[] = [];

  for (const pass of ingestPasses()) {
    const startUtc = new Date(endUtc.getTime() - pass.windowHours * HOUR_MS);

    // USGS first and unconditionally — it is the authoritative source, so its
    // records must already be present before EMSC is tested against them.
    const usgsEvents = await fetchRecentEarthquakes({
      startUtc,
      endUtc,
      minMagnitude: pass.minMagnitude,
    });
    insertEarthquakes(db, atOrAboveFloor(usgsEvents, pass.minMagnitude));
    collected.push(...usgsEvents);

    // EMSC is supplementary: if it fails, the globe still works with USGS data.
    // Scoped per pass so a failure on the long sweep doesn't lose the short one.
    try {
      const emscEvents = await fetchEmscEarthquakes({
        startUtc,
        minMagnitude: pass.minMagnitude,
      });
      insertEmscFillingGaps(db, atOrAboveFloor(emscEvents, pass.minMagnitude));
    } catch (error: unknown) {
      console.error(
        `EMSC backfill failed for the ${pass.label} pass; continuing with USGS only`,
        error,
      );
    }
  }

  // Nothing here ever expires on its own — the upsert only ever adds. Without
  // this the "rolling window" would grow for the lifetime of the install.
  pruneEarthquakesBefore(db, new Date(endUtc.getTime() - RETENTION_MS).toISOString());

  return collected;
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
 * Starts the background poll loop. Returns a stop function for app shutdown.
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
