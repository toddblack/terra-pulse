import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DonkiProgress } from '@terra-pulse/schema';
import { DONKI_START_YEAR } from '@terra-pulse/schema';
import { completedDonkiYears, openDatabase, saveDonkiApiKey } from '@terra-pulse/db';
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
  // A key is configured by default so tests unrelated to key resolution don't
  // have to think about it — the describe block below overrides this to
  // exercise the no-key and key-precedence paths specifically.
  process.env['NASA_DONKI_API_KEY'] = 'test-key';
});

afterEach(() => {
  delete process.env['NASA_DONKI_API_KEY'];
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

describe('the API key every request uses', () => {
  /**
   * There is no shared-key fallback: NASA's `DEMO_KEY` returned 403 on every
   * request in real use, so these features now simply require a personal
   * key rather than silently degrading to one that doesn't work. The
   * renderer gates Download/Resume and the layer toggles on this; this is
   * the defensive check for anything that reaches main anyway.
   */
  it('fetches nothing and fails cleanly when no key is configured', async () => {
    delete process.env['NASA_DONKI_API_KEY'];
    const { controller } = setup();

    const final = await controller.start();

    expect(fetchSolarFlares).not.toHaveBeenCalled();
    expect(fetchCmeArrivals).not.toHaveBeenCalled();
    expect(final.state).toBe('failed');
  });

  it('status().hasApiKey reflects whether a key is configured', () => {
    delete process.env['NASA_DONKI_API_KEY'];
    const { controller } = setup();
    expect(controller.status().hasApiKey).toBe(false);

    process.env['NASA_DONKI_API_KEY'] = 'a-key';
    expect(controller.status().hasApiKey).toBe(true);
  });

  /**
   * The actual bug this guards against: `NASA_DONKI_API_KEY=` with no value
   * in `.env` resolves to `''`, not `undefined`. The first version of this
   * function used a plain `??` chain, which happily returned that empty
   * string as "the key" — `hasApiKey` reported true, nothing ever gated, and
   * every request went out with a blank `api_key`, which NASA correctly
   * rejects with 403. Blank must resolve exactly like unset.
   */
  it('treats a blank NASA_DONKI_API_KEY the same as an unset one', async () => {
    process.env['NASA_DONKI_API_KEY'] = '';
    const { controller } = setup();

    expect(controller.status().hasApiKey).toBe(false);

    const final = await controller.start();
    expect(fetchSolarFlares).not.toHaveBeenCalled();
    expect(final.state).toBe('failed');
  });

  it('treats a whitespace-only NASA_DONKI_API_KEY the same as an unset one', () => {
    process.env['NASA_DONKI_API_KEY'] = '   ';
    const { controller } = setup();

    expect(controller.status().hasApiKey).toBe(false);
  });

  it('is NASA_DONKI_API_KEY, on every request, when one is set', async () => {
    process.env['NASA_DONKI_API_KEY'] = 'personal-key-123';
    const { controller } = setup();
    await controller.start();

    expect(fetchSolarFlares).toHaveBeenCalledWith(
      expect.any(Date),
      expect.any(Date),
      'personal-key-123',
    );
    expect(fetchCmeArrivals).toHaveBeenCalledWith(
      expect.any(Date),
      expect.any(Date),
      'personal-key-123',
    );
  });

  /**
   * The actual bug this guards against: an earlier version of this controller
   * never read `NASA_DONKI_API_KEY` at all. It was found in the field, not by
   * a test — a backfill kept failing hours after a personal key was
   * configured, because it simply was never read.
   */
  it('is read at request time, not captured once at import time', async () => {
    // A module-level `const` evaluated at import would have run before
    // `main/index.ts`'s own `dotenv.config()` — ES module imports are fully
    // evaluated before an importing module's own statements run — and
    // frozen on `undefined` for the life of the process. Setting the env var
    // only after the controller exists, and before it fetches, proves the
    // key is resolved lazily instead.
    delete process.env['NASA_DONKI_API_KEY'];
    const { controller } = setup();
    process.env['NASA_DONKI_API_KEY'] = 'late-key';

    await controller.start();

    expect(fetchSolarFlares).toHaveBeenCalledWith(expect.any(Date), expect.any(Date), 'late-key');
  });

  it('applies to the live poll too, not just the backfill', () => {
    process.env['NASA_DONKI_API_KEY'] = 'poll-key';
    const db = openDatabase(':memory:');

    // Fires once immediately (see startDonkiPolling's own docs) — the calls
    // happen synchronously before the returned promises settle, so nothing
    // needs to be awaited before asserting.
    const stop = startDonkiPolling(db, () => {}, 999_999_999);
    stop();

    expect(fetchSolarFlares).toHaveBeenCalledWith(expect.any(Date), expect.any(Date), 'poll-key');
    expect(fetchCmeArrivals).toHaveBeenCalledWith(expect.any(Date), expect.any(Date), 'poll-key');
  });

  it('the live poll does nothing, silently, when no key is configured', () => {
    delete process.env['NASA_DONKI_API_KEY'];
    const db = openDatabase(':memory:');

    const stop = startDonkiPolling(db, () => {}, 999_999_999);
    stop();

    expect(fetchSolarFlares).not.toHaveBeenCalled();
    expect(fetchCmeArrivals).not.toHaveBeenCalled();
  });

  /**
   * `app_state` is the only key storage that survives packaging — `.env`
   * resolves nowhere in a packaged build. It must win over `.env` whenever a
   * personal key has actually been saved.
   */
  it('a saved app_state key beats NASA_DONKI_API_KEY', async () => {
    process.env['NASA_DONKI_API_KEY'] = 'env-key';
    const { db, controller } = setup();
    saveDonkiApiKey(db, 'app-state-key');

    await controller.start();

    expect(fetchSolarFlares).toHaveBeenCalledWith(
      expect.any(Date),
      expect.any(Date),
      'app-state-key',
    );
    expect(fetchSolarFlares).not.toHaveBeenCalledWith(expect.any(Date), expect.any(Date), 'env-key');
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
    registerDonkiIpcHandlers(db, controller, () => {}, now);
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

  it('does nothing — no fetch, no error — when no key is configured', async () => {
    delete process.env['NASA_DONKI_API_KEY'];
    const db = openDatabase(':memory:');
    register(db);

    const query = handlerFor('solar-events:query-flares');
    const result = await query(undefined, {
      startUtc: `${String(DONKI_START_YEAR)}-01-01T00:00:00.000Z`,
      endUtc: `${String(DONKI_START_YEAR)}-02-01T00:00:00.000Z`,
    });

    expect(fetchSolarFlares).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

describe('saving a key', () => {
  /**
   * Found in the field: after saving a key from the layer-toggle modal, the
   * layer stayed blank. `useSolarEvents` had already queried once with no
   * key configured (a real, empty result, not an error), and nothing else
   * was going to make it query again — no window change, and the next poll
   * is up to 30 minutes out. `onUpdated` is the same signal the live poll
   * already uses to tell the renderer "something's worth re-reading".
   */
  it('notifies the renderer, the same way the live poll does, so a query made before the key existed gets retried', () => {
    delete process.env['NASA_DONKI_API_KEY'];
    const db = openDatabase(':memory:');
    const controller = createDonkiController(db, () => {}, now);
    const onUpdated = vi.fn();
    registerDonkiIpcHandlers(db, controller, onUpdated, now);

    const saveApiKey = handlerFor('solar-events:save-api-key');
    saveApiKey(undefined, 'a-fresh-key');

    expect(onUpdated).toHaveBeenCalledTimes(1);
  });

  it('the returned status already reflects the new key, for a caller that does not wait for onUpdated', () => {
    delete process.env['NASA_DONKI_API_KEY'];
    const db = openDatabase(':memory:');
    const controller = createDonkiController(db, () => {}, now);
    registerDonkiIpcHandlers(db, controller, () => {}, now);

    const saveApiKey = handlerFor('solar-events:save-api-key');
    const result = saveApiKey(undefined, 'a-fresh-key') as DonkiProgress;

    expect(result.hasApiKey).toBe(true);
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
    registerDonkiIpcHandlers(db, createDonkiController(db, () => undefined, now), () => undefined, now);

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
    registerDonkiIpcHandlers(db, createDonkiController(db, () => undefined, now), () => undefined, now);

    await handlerFor('solar-events:query-flares')(undefined, {
      startUtc: `${String(DONKI_START_YEAR)}-03-01T00:00:00.000Z`,
      endUtc: `${String(DONKI_START_YEAR)}-06-01T00:00:00.000Z`,
    });

    expect(fetchSolarFlares).toHaveBeenCalledTimes(1);
    expect(completedDonkiYears(db, 'flares')).toEqual(new Set([DONKI_START_YEAR]));
  });
});
