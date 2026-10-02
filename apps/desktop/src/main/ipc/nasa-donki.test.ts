import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DonkiProgress } from '@terra-pulse/schema';
import { DONKI_START_YEAR } from '@terra-pulse/schema';
import { completedDonkiYears, openDatabase } from '@terra-pulse/db';
import { DonkiRateLimitError } from '@terra-pulse/ingest';
import {
  createDonkiController,
  donkiBackfillYears,
  registerDonkiIpcHandlers,
  startDonkiPolling,
} from './nasa-donki';

// `registerDonkiIpcHandlers` imports ipcMain at module load; the controller
// and poller themselves never touch Electron.
const ipcHandle = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ ipcMain: { handle: ipcHandle } }));

const fetchSolarFlares = vi.hoisted(() => vi.fn());
const fetchCmeArrivals = vi.hoisted(() => vi.fn());
vi.mock('@terra-pulse/ingest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@terra-pulse/ingest')>();
  return { ...actual, fetchSolarFlares, fetchCmeArrivals };
});

/** Frozen one year past the start, so a backfill run is two years, not seventeen. */
const NOW = new Date(`${String(DONKI_START_YEAR + 1)}-06-01T00:00:00.000Z`);
const now = () => NOW;

function setup() {
  const db = openDatabase(':memory:');
  const progress: DonkiProgress[] = [];
  const controller = createDonkiController(db, (p) => progress.push(p), now);
  return { db, controller, progress };
}

/** Finds the handler `registerDonkiIpcHandlers` registered for one channel. */
function handlerFor(channel: string): (event: unknown, request: unknown) => unknown {
  const call = ipcHandle.mock.calls.find(([registered]) => registered === channel);
  if (!call) throw new Error(`no handler registered for ${channel}`);
  return call[1] as (event: unknown, request: unknown) => unknown;
}

beforeEach(() => {
  fetchSolarFlares.mockReset().mockResolvedValue([]);
  fetchCmeArrivals.mockReset().mockResolvedValue([]);
  ipcHandle.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('donkiBackfillYears', () => {
  it('starts at DONKI_START_YEAR, not 1970', () => {
    expect(donkiBackfillYears(DONKI_START_YEAR + 5)[0]).toBe(DONKI_START_YEAR);
  });

  it('covers every year inclusive of the current one', () => {
    expect(donkiBackfillYears(DONKI_START_YEAR + 5)).toHaveLength(6);
  });
});

describe('no key, since DONKI moved to its keyless endpoint', () => {
  /**
   * Until 2026-09-30 every path here — backfill, lazy query, live poll — did
   * nothing without a personal NASA key, and the renderer gated on
   * `hasApiKey`. CCMC's endpoint takes no key, so none of that exists now.
   * These pin that the gate is gone rather than merely unused: a stale
   * `NASA_DONKI_API_KEY` left in someone's `.env` changes nothing either.
   */
  it('backfills with no key configured, and passes the fetchers no key', async () => {
    const { controller } = setup();

    const final = await controller.start();

    expect(final.state).toBe('complete');
    expect(fetchSolarFlares).toHaveBeenCalled();
    for (const call of [...fetchSolarFlares.mock.calls, ...fetchCmeArrivals.mock.calls]) {
      expect(call).toHaveLength(2);
    }
  });

  it('polls with no key configured', () => {
    const db = openDatabase(':memory:');

    // Fires once immediately (see startDonkiPolling's own docs) — the calls
    // happen synchronously before the returned promises settle.
    const stop = startDonkiPolling(db, () => {}, 999_999_999);
    stop();

    expect(fetchSolarFlares).toHaveBeenCalledTimes(1);
    expect(fetchCmeArrivals).toHaveBeenCalledTimes(1);
  });

  it('offers the renderer no way to save a key', () => {
    const db = openDatabase(':memory:');
    registerDonkiIpcHandlers(db, createDonkiController(db, () => {}, now), now);

    const channels = ipcHandle.mock.calls.map(([channel]) => String(channel));
    expect(channels).toContain('solar-events:status');
    expect(channels).not.toContain('solar-events:save-api-key');
  });
});

describe('rate limiting: waiting and auto-resume', () => {
  it('pauses on a 429 and resumes automatically once the window clears', async () => {
    vi.useFakeTimers();

    let flaresCalls = 0;
    fetchSolarFlares.mockImplementation(() => {
      flaresCalls += 1;
      if (flaresCalls === 1) return Promise.reject(new DonkiRateLimitError('FLR'));
      return Promise.resolve([]);
    });

    const { controller, progress } = setup();
    const startPromise = controller.start();

    // Let the first (rate-limited) attempt run and the controller settle
    // into 'waiting' without yet advancing real time.
    await vi.advanceTimersByTimeAsync(0);

    const waiting = progress.find((p) => p.state === 'waiting');
    expect(waiting).toBeDefined();
    expect(waiting?.retryAtUtc).not.toBeNull();

    // Past the retry window (61 minutes of slack past the hour), the
    // controller resumes on its own and finishes the backfill.
    await vi.advanceTimersByTimeAsync(61 * 60_000 + 5_000);

    const final = await startPromise;
    expect(final.state).toBe('complete');
    expect(flaresCalls).toBeGreaterThan(1);
  });

  it('cancel still works while waiting for the rate limit to clear', async () => {
    vi.useFakeTimers();

    fetchSolarFlares.mockImplementation(() => Promise.reject(new DonkiRateLimitError('FLR')));

    const { controller, progress } = setup();
    const startPromise = controller.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(progress.some((p) => p.state === 'waiting')).toBe(true);

    controller.cancel();
    // Only needs to reach the next poll of `signal.aborted`, well under the
    // full retry window.
    await vi.advanceTimersByTimeAsync(5_000);

    const final = await startPromise;
    expect(final.state).toBe('cancelled');
  });
});

describe('lazy, on-demand coverage for the query handlers', () => {
  function register(db: ReturnType<typeof openDatabase>) {
    const controller = createDonkiController(db, () => {}, now);
    registerDonkiIpcHandlers(db, controller, now);
    return controller;
  }

  it('fetches a missing year invisibly and returns what was asked for', async () => {
    const db = openDatabase(':memory:');
    register(db);
    fetchSolarFlares.mockResolvedValueOnce([]);

    const query = handlerFor('solar-events:query-flares');
    await query(undefined, {
      startUtc: `${String(DONKI_START_YEAR)}-01-01T00:00:00.000Z`,
      endUtc: `${String(DONKI_START_YEAR)}-02-01T00:00:00.000Z`,
    });

    expect(fetchSolarFlares).toHaveBeenCalledTimes(1);
  });

  it('a range spanning more than 2 missing years fetches nothing, returns only what is cached', async () => {
    const db = openDatabase(':memory:');
    register(db);

    const query = handlerFor('solar-events:query-flares');
    const result = await query(undefined, {
      startUtc: `${String(DONKI_START_YEAR)}-01-01T00:00:00.000Z`,
      endUtc: `${String(DONKI_START_YEAR + 3)}-01-01T00:00:00.000Z`,
    });

    expect(fetchSolarFlares).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('coalesces two concurrent requests for the same year into one fetch', async () => {
    const db = openDatabase(':memory:');
    register(db);

    const query = handlerFor('solar-events:query-flares');
    const request = {
      startUtc: `${String(DONKI_START_YEAR)}-01-01T00:00:00.000Z`,
      endUtc: `${String(DONKI_START_YEAR)}-06-01T00:00:00.000Z`,
    };

    // Both fired before either resolves, deliberately — this is what
    // exercises the coalescing map rather than two sequential fetches.
    const first = query(undefined, request);
    const second = query(undefined, request);
    await Promise.all([first, second]);

    expect(fetchSolarFlares).toHaveBeenCalledTimes(1);
  });


});

describe('lazy coverage never records years DONKI does not cover', () => {
  it('a deep-archive window fetches nothing and records nothing', async () => {
    // The playhead reaches back to 1896 (the deep earthquake archive). Before
    // this was clamped, scrubbing there with a solar layer on asked for each
    // pre-2010 year in turn: every one fetched nothing, stored nothing, and
    // was then recorded *complete*. Measured on a real database that left 12
    // phantom rows and made the archive panel's progress bar read 129%.
    //
    // A narrow window on purpose — a wide one would exceed
    // LAZY_FETCH_MAX_MISSING_YEARS and return early for an unrelated reason,
    // so it would pass even with the bug present.
    const db = openDatabase(':memory:');
    registerDonkiIpcHandlers(db, createDonkiController(db, () => undefined, now), now);

    await handlerFor('solar-events:query-flares')(undefined, {
      startUtc: '1896-01-01T00:00:00.000Z',
      endUtc: '1896-06-01T00:00:00.000Z',
    });

    expect(fetchSolarFlares).not.toHaveBeenCalled();
    expect(completedDonkiYears(db, 'flares')).toEqual(new Set());
  });

  it('still fetches a year that DONKI does cover', async () => {
    // The guard must not be so eager that it breaks the feature it protects.
    const db = openDatabase(':memory:');
    registerDonkiIpcHandlers(db, createDonkiController(db, () => undefined, now), now);

    await handlerFor('solar-events:query-flares')(undefined, {
      startUtc: `${String(DONKI_START_YEAR)}-03-01T00:00:00.000Z`,
      endUtc: `${String(DONKI_START_YEAR)}-06-01T00:00:00.000Z`,
    });

    expect(fetchSolarFlares).toHaveBeenCalledTimes(1);
    expect(completedDonkiYears(db, 'flares')).toEqual(new Set([DONKI_START_YEAR]));
  });
});
