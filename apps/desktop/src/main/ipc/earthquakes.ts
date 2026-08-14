import { ipcMain } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import {
  catalogSignature,
  findCandidateMatches,
  getEarthquakeById,
  insertEarthquakes,
  pruneEarthquakesBefore,
  queryAftershockSequence,
  queryAntipodalWindow,
  queryEarthquakes,
  queryRegionalRecurrence,
  signaturesMatch,
  type EarthquakeQuery,
} from '@terra-pulse/db';
import {
  DEDUPE_MAX_TIME_SECONDS,
  fetchEarthquakeFeed,
  fetchEmscEarthquakes,
  fetchRecentEarthquakes,
  isProbableDuplicate,
} from '@terra-pulse/ingest';
import type { LargeEventAlerter } from './large-event-alerts';
import { markSeenThrough } from './missed-events';
import {
  ingestPasses,
  longestCoverageHours,
  type AftershockSequence,
  type AntipodalWindow,
  type EarthquakeEvent,
  type RegionalRecurrence,
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

/**
 * The horizon the poll's change-detection looks at.
 *
 * Same span as retention, because that is exactly the range ingest writes to.
 * Anything older is archive: immutable once downloaded, and not something a
 * poll can have changed. Passing this keeps `catalogSignature` off a full-table
 * scan of ~300k rows twice every five minutes.
 */
function liveWindowStart(): string {
  return new Date(Date.now() - RETENTION_MS).toISOString();
}

/** The floor of the densest pass, used by the poll and the feed filter. */
const INGEST_MIN_MAGNITUDE = Math.min(...ingestPasses().map((pass) => pass.minMagnitude));

/**
 * How often the background poll runs.
 *
 * The summary feeds are CDN-cached with `Cache-Control: max-age=60`, so 60s is
 * the fastest rate that can return anything new — polling faster would just
 * re-read the same cached bytes.
 *
 * **This has been 60s, then 5 minutes, and is now 60s again.** The move to five
 * minutes was made because every poll that finds new events rebuilds the
 * earthquake layer, and a rebuild lands as a visible hitch while rotating the
 * globe. Two things changed since:
 *
 * - The **timer-driven** rebuild is gone. `useVisibleEarthquakes` used to key
 *   its memo on a 30-second clock, so the layer was rebuilt twice a minute
 *   whether or not anything had arrived. A quiet poll now rebuilds nothing at
 *   all, because the renderer only reloads when `result.changed`.
 * - `catalogSignature` is scoped to the live window rather than scanning the
 *   whole 306k-row table, so a finished archive download no longer flips it.
 *
 * And the arithmetic was never as bad as it looked: **the rebuild rate is
 * bounded by how often earthquakes happen, not by how often we ask.** At the
 * M1+ ingest floor the catalogue gains an event every three to five minutes, so
 * a faster poll mostly makes the same rebuilds prompter. It does lose some
 * batching — five events that arrived together used to land in one rebuild —
 * which is the real, and modest, cost.
 */
export const POLL_INTERVAL_MS = 60_000;

/**
 * EMSC is polled once every this many ticks, not every tick.
 *
 * It is a **gap-filler**, not the primary source: USGS reports everything at
 * M6+, and EMSC exists to catch smaller regional events USGS is slower on. It is
 * also *slow* — an FDSN database query rather than a static file, measured at
 * over five seconds for a single record, which is why its own tests trip
 * vitest's default timeout whenever the service is busy.
 *
 * So the two sources get the cadence each deserves: USGS every minute because
 * it is a CDN read that costs nothing, EMSC every five because hammering a slow
 * public query service every minute would be both impolite and pointless.
 */
export const EMSC_POLL_EVERY_N_TICKS = 5;

/** Whether a given tick should also ask EMSC. Tick 0 — launch — always does. */
export function shouldPollEmsc(tickIndex: number): boolean {
  return tickIndex % EMSC_POLL_EVERY_N_TICKS === 0;
}

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
    // The same threshold the predicate uses, passed explicitly so the SQL
    // window and `isProbableDuplicate` cannot disagree. A narrower window here
    // than the predicate's would make dedup silently miss duplicates; a wider
    // one only costs rows that get rejected anyway.
    const nearbyUsgs = findCandidateMatches(db, candidate, 'usgs', DEDUPE_MAX_TIME_SECONDS);
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
async function backfillEarthquakes(db: DatabaseSync): Promise<EarthquakeSyncResult> {
  const endUtc = new Date();
  const before = catalogSignature(db, liveWindowStart());

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
  // Events at or above the archive floor are exempt; see pruneEarthquakesBefore.
  pruneEarthquakesBefore(db, new Date(endUtc.getTime() - RETENTION_MS).toISOString());

  // Returns a sync result rather than the events themselves. Main no longer
  // waits for this before showing the window, so what it needs to know is
  // whether the renderer should re-query — not what was fetched. A `changed:
  // false` result leaves the globe alone, which matters because replacing the
  // event set rebuilds the layer and drops the user's selection.
  return {
    changed: !signaturesMatch(before, catalogSignature(db, liveWindowStart())),
    syncedAt: new Date().toISOString(),
  };
}

/**
 * One poll of the cached summary feed.
 *
 * An empty response is a normal quiet period, not an error and not a signal to
 * clear anything — the upsert simply has nothing to do.
 */
async function pollOnce(
  db: DatabaseSync,
  alerter?: LargeEventAlerter,
  includeEmsc = true,
): Promise<EarthquakeSyncResult> {
  const before = catalogSignature(db, liveWindowStart());

  const usgsEvents = await fetchEarthquakeFeed('1.0_day');
  insertEarthquakes(db, atOrAboveFloor(usgsEvents));

  // Alerts are raised from what this poll *fetched*, never from a query over
  // stored events (PROJECT_PLAN §5.8). That is what makes the launch backfill
  // structurally incapable of firing them, rather than something that has to be
  // defended against. USGS only — EMSC carries no PAGER alert or significance,
  // and at M6+ USGS reports everything anyway.
  alerter?.consider(usgsEvents);

  if (includeEmsc) {
    try {
      const emscEvents = await fetchEmscEarthquakes({
        startUtc: new Date(Date.now() - 24 * 60 * 60 * 1000),
        minMagnitude: INGEST_MIN_MAGNITUDE,
      });
      insertEmscFillingGaps(db, atOrAboveFloor(emscEvents));
    } catch (error: unknown) {
      console.error('EMSC poll failed; continuing with USGS only', error);
    }
  }

  const after = catalogSignature(db, liveWindowStart());

  // The watermark the launch digest reads. Advanced here rather than on quit
  // so a crash costs one interval instead of replaying a whole session as
  // "missed" — and the digest is for people who weren't there to quit tidily.
  markSeenThrough(db);

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
  alerter?: LargeEventAlerter,
): () => void {
  let stopped = false;
  let inFlight = false;
  let ticks = 0;

  const tick = () => {
    // **Skip rather than overlap.** At five minutes a poll could not outlast its
    // own interval; at sixty seconds it can — EMSC alone has been measured over
    // five seconds and is unbounded when the service is struggling. Without this
    // a slow run would let the next one start on top of it, and they would pile
    // up against the same database and the same alerter.
    if (inFlight) return;
    inFlight = true;

    const includeEmsc = shouldPollEmsc(ticks);
    ticks += 1;

    pollOnce(db, alerter, includeEmsc).then(
      (result) => {
        inFlight = false;
        if (!stopped) onResult(result);
      },
      (error: unknown) => {
        inFlight = false;
        console.error('Earthquake poll failed (will retry)', error);
      },
    );
  };

  // Polls once immediately rather than waiting out the first interval.
  //
  // `setInterval` alone meant the first poll landed five minutes after launch,
  // and the poll is the only thing that can raise an alert — so an M6 from
  // twenty minutes ago sat in the database, drawn on the globe, with the banner
  // that exists to announce it arriving five minutes later. Backfill doesn't
  // close that gap and shouldn't: keeping it out of alerting is what makes a
  // month of old news structurally unannounceable (PROJECT_PLAN §5.8).
  //
  // The extra request is one CDN-cached feed fetch against a `max-age=60`
  // endpoint, alongside a backfill already in flight. `ticks` starts at 0, so
  // this first run includes EMSC.
  tick();

  const interval = setInterval(tick, POLL_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

export function registerEarthquakeIpcHandlers(
  db: DatabaseSync,
  alerter?: LargeEventAlerter,
): void {
  ipcMain.handle('earthquakes:query', (_event, query: EarthquakeQuery = {}): EarthquakeEvent[] => {
    return queryEarthquakes(db, query);
  });

  /**
   * Polls USGS now, and returns only the sync result.
   *
   * It used to return `queryEarthquakes(db, {})` — the *entire* catalogue —
   * which the renderer then threw away, because the store issues its own
   * windowed query straight afterwards. Harmless at 30 days; with the archive
   * in the same table that became 306k rows, measured at 1.25 s to assemble
   * plus a ~100 MB structured-clone across the IPC boundary, every time anyone
   * pressed Refresh.
   *
   * The renderer asks for the window it actually wants. Main does not guess.
   */
  ipcMain.handle('earthquakes:refresh', async (): Promise<EarthquakeSyncResult> => {
    // A manual refresh is a poll, so it can raise an alert too — that is the
    // other half of "only on a live update or a user refresh".
    return await pollOnce(db, alerter);
  });

  /**
   * The observed aftershock sequence for one event (PROJECT_PLAN §5.9).
   *
   * Takes an **id**, not an event. The renderer has the object already, but a
   * spatial query built from renderer-supplied coordinates would be answering a
   * question about a mainshock that need not exist; looking it up here means the
   * window is always centred on a real catalogue row.
   *
   * `Date.now()` rather than the renderer's playhead, deliberately. What
   * followed an earthquake is a historical fact — scrubbing the timeline changes
   * which events are drawn, not whether the 2011 sequence happened.
   *
   * Measured against the real 307k-row catalogue: median 0.7 ms at M5, 9.6 ms at
   * M7, and 51 ms median / 88 ms worst at M8+ (Tohoku's 1,134 aftershocks take
   * 82 ms). It runs on a click rather than on a timer, so the handful of M8+
   * events in the catalogue can afford to block main for a frame or two.
   */
  ipcMain.handle(
    'earthquakes:sequence',
    (_event, eventId: string): AftershockSequence | null => {
      const mainshock = getEarthquakeById(db, eventId);
      if (mainshock === null) return null;
      return queryAftershockSequence(db, mainshock, Date.now());
    },
  );

  /**
   * Observed recurrence intervals for a region (PROJECT_PLAN §5.11).
   *
   * `Date.now()` rather than the renderer's playhead: how often earthquakes have
   * occurred somewhere is a fact about the record, not about where the scrubber
   * happens to sit.
   */
  ipcMain.handle(
    'earthquakes:recurrence',
    (
      _event,
      request: { latitude: number; longitude: number; radiusKm: number; minMagnitude: number },
    ): RegionalRecurrence => {
      return queryRegionalRecurrence(
        db,
        { latitude: request.latitude, longitude: request.longitude },
        request.radiusKm,
        request.minMagnitude,
        Date.now(),
      );
    },
  );
  /**
   * What the catalogue recorded near an event's antipode (PROJECT_PLAN §5.3).
   *
   * Observation only — the registered H5 test is a separate Analyze job. Takes
   * an id and looks the trigger up here, so the geometry is always centred on a
   * real catalogue row rather than on renderer-supplied coordinates.
   */
  ipcMain.handle(
    'earthquakes:antipodal',
    (_event, eventId: string): AntipodalWindow | null => {
      const trigger = getEarthquakeById(db, eventId);
      if (trigger === null) return null;
      return queryAntipodalWindow(db, trigger, Date.now());
    },
  );
}

export { backfillEarthquakes };