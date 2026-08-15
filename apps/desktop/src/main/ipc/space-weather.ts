import { ipcMain } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import {
  fetchGfzKpArchive,
  fetchGfzKpNowcast,
  fetchLatestSolarWind,
  fetchOmniYear,
  fetchRecentSolarWind,
} from '@terra-pulse/ingest';
import {
  DST_START_YEAR,
  KP_START_YEAR,
  type SpaceWeatherProgress,
  type SpaceWeatherSample,
} from '@terra-pulse/schema';
import {
  insertSpaceWeather,
  querySpaceWeather,
  readAppState,
  spaceWeatherCoverage,
  spaceWeatherYearsPresent,
  writeAppState,
} from '@terra-pulse/db';

/** How often the live Kp tail is refreshed. Kp is a three-hour index. */
const KP_POLL_INTERVAL_MS = 15 * 60_000;

/**
 * Which OMNI columns the stored rows were parsed for.
 *
 * ## Why presence alone cannot answer "is this year done?"
 *
 * The Dst loop skips a year that already holds Dst. That was a complete test
 * while Dst was the only thing this adapter took from OMNI — and it silently
 * stopped being one the moment the adapter also started reading solar wind
 * speed and Bz. A database backfilled before that change holds every Dst year,
 * so the loop would skip all sixty-three and never fetch the wind columns, with
 * no error and a panel reporting complete.
 *
 * The obvious repair — test for `wind_speed` presence instead — is wrong in a
 * way worth spelling out, because it looks right: solar wind coverage is
 * genuinely 32-42% through 1985-1994, so *absent* and *never fetched* are
 * indistinguishable per year. A year with no wind data would be refetched
 * forever.
 *
 * So the record is what the *parser* asked for, not what the data contains.
 * Bump this string whenever a column is added and every year is refetched once.
 */
const OMNI_FIELDS_KEY = 'omni_fields';
const OMNI_FIELDS_VERSION = 'dst,wind_speed,density,bz_gsm';

/**
 * Every year the **Dst** backfill covers, oldest first.
 *
 * Kp has no equivalent list: GFZ serves the whole record in one request, so
 * there is nothing to iterate and nothing to resume.
 *
 * Oldest first for the same reason the earthquake archive is: an interrupted
 * run leaves a contiguous span rather than scattered years, so what you have is
 * describable in one sentence.
 */
export function dstBackfillYears(throughYear: number): number[] {
  const years: number[] = [];
  for (let year = DST_START_YEAR; year <= throughYear; year += 1) years.push(year);
  return years;
}

export interface SpaceWeatherController {
  status(): SpaceWeatherProgress;
  start(): Promise<SpaceWeatherProgress>;
  cancel(): SpaceWeatherProgress;
}

/**
 * The Kp/Dst backfill.
 *
 * ## Two indices, two very different downloads
 *
 * **Kp** comes from GFZ Potsdam as a single ~5.5 MB file covering 1932 to a day
 * or two ago — one request, 829,416 hourly samples, measured at 781 ms to
 * insert. It runs first because it is nearly free and because it is the index
 * with the longer record.
 *
 * **Dst** comes from Kyoto via NASA's OMNI2, one ~2.9 MB file per year from
 * 1963. That is the ~184 MB the panel warns about, and the reason this whole
 * thing is user-triggered rather than automatic.
 *
 * ## Why resume needs no bookkeeping table
 *
 * The earthquake archive needs `archive_chunks` because "did we finish 1974?"
 * cannot be answered from the events themselves — a quiet year and an unfetched
 * year look identical. Here it can: the hour is the primary key and every year
 * has ~8,760 of them, so `spaceWeatherYearsPresent` *is* the bookkeeping.
 *
 * That query is asked **per index**, which is load-bearing. Kp's single request
 * puts samples in every year from 1932, so a Dst loop asking "does this year
 * hold anything?" would skip all sixty-three years and never fetch Dst again —
 * with no error and a plausible-looking completion.
 *
 * The **current year is always refetched**, because it isn't finished, and
 * because recent Dst is provisional and gets revised.
 */
export function createSpaceWeatherController(
  db: DatabaseSync,
  onProgress: (progress: SpaceWeatherProgress) => void,
): SpaceWeatherController {
  let state: SpaceWeatherProgress['state'] = 'idle';
  let phase: SpaceWeatherProgress['phase'] = null;
  let currentYear: number | null = null;
  let error: string | null = null;
  let cancelled = false;

  /**
   * Years the loop has passed this run, fetched or skipped.
   *
   * Progress cannot be derived from what is in the table during a refetch, and
   * both ways of trying are wrong: the marker that says "refetch everything"
   * stays stale until the run finishes, so testing it pins the count at 0 for
   * the whole download — and counting years already present reports ~63 of 64
   * from the first second, because a refetch re-reads years that are all there
   * already. Only the loop knows how far the loop has got.
   */
  let yearsSettled = 0;

  /**
   * The fields that cost a table scan, measured while idle and frozen during a
   * run.
   *
   * Measured on the real 829k-row table: `spaceWeatherYearsPresent` is 125 ms
   * for Kp and 57 ms for Dst, and the coverage count 66 ms — 248 ms per
   * snapshot. Snapshot runs two to three times per year, so a 64-year backfill
   * spent **roughly 32 seconds** re-scanning the table purely to report
   * progress, all of it synchronous on the main process and therefore blocking
   * the window.
   *
   * None of these three are displayed while running: `describe()` uses
   * `storedSamples` only in its idle branch, and `kpComplete` only feeds the
   * Download/Resume label. So the run reports the last idle measurement and the
   * final snapshot — taken after the state leaves `running` — refreshes them.
   */
  let scanned = { kpComplete: false, presentYears: 0, storedSamples: 0 };

  function rescan(): void {
    const thisYear = new Date().getUTCFullYear();
    const dstPresent = spaceWeatherYearsPresent(db, 'dst');
    scanned = {
      // One request fills every year at once, so the oldest year present is a
      // sufficient test — nothing else can put 1932 in the table.
      kpComplete: spaceWeatherYearsPresent(db, 'kp').has(KP_START_YEAR),
      // The current year never counts as complete — it isn't.
      presentYears: dstBackfillYears(thisYear).filter(
        (y) => dstPresent.has(y) && y !== thisYear,
      ).length,
      storedSamples: spaceWeatherCoverage(db).samples,
    };
  }

  function snapshot(): SpaceWeatherProgress {
    const totalYears = dstBackfillYears(new Date().getUTCFullYear()).length;

    if (state !== 'running') rescan();

    return {
      state,
      phase,
      kpComplete: scanned.kpComplete,
      completedYears:
        state === 'running'
          ? yearsSettled
          : // A stale parser version means every year needs refetching, so none
            // of them count. Without this the panel would report a complete
            // archive while the solar wind columns were empty, and nobody would
            // press Resume.
            omniFieldsStale()
            ? 0
            : scanned.presentYears,
      totalYears,
      storedSamples: scanned.storedSamples,
      currentYear,
      error,
    };
  }

  function omniFieldsStale(): boolean {
    return readAppState(db, OMNI_FIELDS_KEY) !== OMNI_FIELDS_VERSION;
  }

  return {
    status: snapshot,

    cancel() {
      if (state === 'running') {
        cancelled = true;
        state = 'cancelled';
      }
      return snapshot();
    },

    async start() {
      if (state === 'running') return snapshot();

      state = 'running';
      cancelled = false;
      error = null;
      phase = 'kp';
      yearsSettled = 0;
      // The last cheap chance to measure: everything from here to the final
      // snapshot reports these frozen, so they must be current first.
      rescan();
      onProgress(snapshot());

      const thisYear = new Date().getUTCFullYear();

      try {
        // Kp first: one request for the whole 1932-onward record.
        //
        // Fetched every run rather than skipped when already present. It is a
        // single cheap request, and re-reading it is also how the most recent
        // weeks graduate from preliminary to definitive — GFZ marks roughly the
        // last 44 days provisional, which is wider than the nowcast poll's
        // thirty-day window.
        const kp = await fetchGfzKpArchive();
        if (!cancelled) insertSpaceWeather(db, kp);

        // Then Dst and the solar wind, year by year, skipping what is stored.
        phase = 'dst';
        const dstPresent = spaceWeatherYearsPresent(db, 'dst');
        // Captured before the loop: writing the new version at the end would
        // otherwise flip this mid-run and skip the remaining years.
        const refetchAll = omniFieldsStale();
        onProgress(snapshot());

        for (const year of dstBackfillYears(thisYear)) {
          if (cancelled) break;
          // Skip finished years; always redo the current one. A parser that has
          // gained columns redoes all of them — see OMNI_FIELDS_VERSION.
          if (!refetchAll && dstPresent.has(year) && year !== thisYear) {
            // Counted, not ignored: a skipped year is a year the reader no
            // longer has to wait for, and leaving it out would make a resume
            // that skips sixty years look as though it had barely started.
            yearsSettled += 1;
            continue;
          }

          currentYear = year;
          onProgress(snapshot());

          const samples = await fetchOmniYear(year);
          if (cancelled) break;
          insertSpaceWeather(db, samples);
          yearsSettled += 1;
        }

        // Emitted after the loop, not just before each year. The in-loop update
        // fires *before* its year is fetched — which is what makes "Dst 1985"
        // mean "downloading now" — so without this the last year's completion
        // is never reported and the bar stops one short of full.
        currentYear = null;
        if (!cancelled) onProgress(snapshot());

        // Then the last seven days of solar wind, which OMNI cannot supply:
        // it lags by weeks. Runs inside the backfill rather than only on the
        // poll so a fresh install has a populated recent week immediately.
        if (!cancelled) {
          insertSpaceWeather(db, await fetchRecentSolarWind());
        }

        currentYear = null;
        phase = null;
        state = cancelled ? 'cancelled' : 'complete';

        // Only on a run that finished. A cancelled or failed pass must leave
        // the marker stale so the next run still refetches.
        if (!cancelled) writeAppState(db, OMNI_FIELDS_KEY, OMNI_FIELDS_VERSION);
      } catch (caught: unknown) {
        currentYear = null;
        phase = null;
        state = 'failed';
        error = caught instanceof Error ? caught.message : 'Space-weather backfill failed';
        console.error('Space-weather backfill failed', caught);
      }

      const final = snapshot();
      onProgress(final);
      return final;
    },
  };
}

/**
 * Keeps the recent Kp current.
 *
 * Runs regardless of whether the deep backfill has been done, so the track has
 * *something* on it without a 184 MB download — the same shape as the
 * earthquakes' rolling cache versus their archive.
 *
 * Reads GFZ's thirty-day nowcast file, which is ~8 KB in the identical format
 * to the 5.5 MB archive. Re-reading the archive at this cadence would be half a
 * gigabyte a day to collect a handful of new rows.
 *
 * This replaced SWPC's planetary K index, which was NOAA's *estimate* from
 * eight stations rather than the IAGA index from thirteen observatories. Same
 * name, same units, different quantity — the same trap that keeps SWPC's
 * modelled Dst out of this app. Now that GFZ publishes its own tail there is no
 * reason to blend an estimate into a definitive series, least of all one that
 * H4c is registered against.
 */
export function startKpPolling(
  db: DatabaseSync,
  onUpdated: () => void,
  intervalMs: number = KP_POLL_INTERVAL_MS,
): () => void {
  let stopped = false;
  let inFlight = false;

  const tick = () => {
    if (inFlight) return;
    inFlight = true;

    // Settled, not all-or-nothing: GFZ and SWPC are unrelated services, and one
    // being down must not cost the other its update. A rejected half is logged
    // and retried on the next tick.
    void Promise.allSettled([
      fetchGfzKpNowcast(),
      fetchLatestSolarWind(),
    ]).then((results) => {
      inFlight = false;
      if (stopped) return;

      const labels = ['Kp nowcast', 'solar wind'];
      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          insertSpaceWeather(db, result.value);
        } else {
          console.error(`${labels[index] ?? 'poll'} failed (will retry)`, result.reason);
        }
      }

      if (results.some((result) => result.status === 'fulfilled')) onUpdated();
    });
  };

  tick();
  const timer = setInterval(tick, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export function registerSpaceWeatherIpcHandlers(
  db: DatabaseSync,
  controller: SpaceWeatherController,
): void {
  ipcMain.handle(
    'space-weather:query',
    (_event, request: { startUtc: string; endUtc: string }): SpaceWeatherSample[] =>
      querySpaceWeather(db, request.startUtc, request.endUtc),
  );

  ipcMain.handle('space-weather:status', (): SpaceWeatherProgress => controller.status());
  ipcMain.handle('space-weather:start', (): Promise<SpaceWeatherProgress> => controller.start());
  ipcMain.handle('space-weather:cancel', (): SpaceWeatherProgress => controller.cancel());
}
