import { ipcMain } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import { fetchGfzKpArchive, fetchGfzKpNowcast, fetchOmniYear } from '@terra-pulse/ingest';
import {
  DST_START_YEAR,
  KP_START_YEAR,
  type SpaceWeatherProgress,
  type SpaceWeatherSample,
} from '@terra-pulse/schema';
import {
  insertSpaceWeather,
  querySpaceWeather,
  spaceWeatherCoverage,
  spaceWeatherYearsPresent,
} from '@terra-pulse/db';

/** How often the live Kp tail is refreshed. Kp is a three-hour index. */
const KP_POLL_INTERVAL_MS = 15 * 60_000;

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

  function snapshot(): SpaceWeatherProgress {
    const thisYear = new Date().getUTCFullYear();
    const years = dstBackfillYears(thisYear);
    const dstPresent = spaceWeatherYearsPresent(db, 'dst');
    const kpPresent = spaceWeatherYearsPresent(db, 'kp');

    return {
      state,
      phase,
      // One request fills every year at once, so the oldest year present is a
      // sufficient test — nothing else can put 1932 in the table.
      kpComplete: kpPresent.has(KP_START_YEAR),
      // The current year never counts as complete — it isn't.
      completedYears: years.filter((y) => dstPresent.has(y) && y !== thisYear).length,
      totalYears: years.length,
      storedSamples: spaceWeatherCoverage(db).samples,
      currentYear,
      error,
    };
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

        // Then Dst, year by year, skipping what is already stored.
        phase = 'dst';
        const dstPresent = spaceWeatherYearsPresent(db, 'dst');
        onProgress(snapshot());

        for (const year of dstBackfillYears(thisYear)) {
          if (cancelled) break;
          // Skip finished years; always redo the current one.
          if (dstPresent.has(year) && year !== thisYear) continue;

          currentYear = year;
          onProgress(snapshot());

          const samples = await fetchOmniYear(year);
          if (cancelled) break;
          insertSpaceWeather(db, samples);
        }

        currentYear = null;
        phase = null;
        state = cancelled ? 'cancelled' : 'complete';
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

    fetchGfzKpNowcast().then(
      (samples: SpaceWeatherSample[]) => {
        inFlight = false;
        if (stopped) return;
        insertSpaceWeather(db, samples);
        onUpdated();
      },
      (caught: unknown) => {
        inFlight = false;
        console.error('Kp poll failed (will retry)', caught);
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
