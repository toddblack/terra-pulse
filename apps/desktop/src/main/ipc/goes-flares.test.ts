import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoesFlareProgress, SolarFlare } from '@terra-pulse/schema';
import { GOES_FLARE_LAST_YEAR, GOES_FLARE_START_YEAR } from '@terra-pulse/schema';
import { openDatabase, querySolarFlares } from '@terra-pulse/db';
import { createGoesFlareController, registerGoesFlareIpcHandlers } from './goes-flares';

// `registerGoesFlareIpcHandlers` imports ipcMain at module load; the controller
// itself never touches Electron.
const ipcHandle = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ ipcMain: { handle: ipcHandle } }));

const fetchGoesFlareYear = vi.hoisted(() => vi.fn());
vi.mock('@terra-pulse/ingest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@terra-pulse/ingest')>();
  return { ...actual, fetchGoesFlareYear };
});

function flare(year: number, overrides: Partial<SolarFlare> = {}): SolarFlare {
  const peakTimeUtc = `${String(year)}-03-01T00:00:00.000Z`;
  return {
    id: `goes:${peakTimeUtc}-M1`,
    source: 'goes',
    classType: 'M1',
    flareClass: 'M',
    magnitude: 1,
    peakTimeUtc,
    beginTimeUtc: null,
    endTimeUtc: null,
    sourceLocation: null,
    activeRegionNumber: null,
    link: null,
    ...overrides,
  };
}

function setup() {
  const db = openDatabase(':memory:');
  const progress: GoesFlareProgress[] = [];
  const controller = createGoesFlareController(db, (p) => progress.push(p));
  return { db, controller, progress };
}

function handlerFor(channel: string): (event: unknown, request: unknown) => unknown {
  const call = ipcHandle.mock.calls.find(([registered]) => registered === channel);
  if (!call) throw new Error(`no handler registered for ${channel}`);
  return call[1] as (event: unknown, request: unknown) => unknown;
}

beforeEach(() => {
  fetchGoesFlareYear.mockReset().mockImplementation((year: number) => Promise.resolve([flare(year)]));
  ipcHandle.mockClear();
});

describe('createGoesFlareController', () => {
  it('fetches every year of the closed record, oldest first', async () => {
    const { controller } = setup();
    await controller.start();

    const years = fetchGoesFlareYear.mock.calls.map(([year]) => year as number);
    expect(years[0]).toBe(GOES_FLARE_START_YEAR);
    expect(years.at(-1)).toBe(GOES_FLARE_LAST_YEAR);
    expect(years).toHaveLength(GOES_FLARE_LAST_YEAR - GOES_FLARE_START_YEAR + 1);
  });

  it('stores what it fetched and reports complete', async () => {
    const { db, controller } = setup();
    const final = await controller.start();

    expect(final.state).toBe('complete');
    expect(final.completedChunks).toBe(final.totalChunks);
    expect(querySolarFlares(db, '1900-01-01', '2100-01-01')).toHaveLength(final.totalChunks);
  });

  it('skips years already recorded, which is the whole resume mechanism', async () => {
    const { db, controller } = setup();
    await controller.start();
    fetchGoesFlareYear.mockClear();

    // A second controller over the same database — the first run's state is
    // gone, so anything it skips is skipped because of `goes_flare_chunks`.
    const second = createGoesFlareController(db, () => undefined);
    await second.start();

    expect(fetchGoesFlareYear).not.toHaveBeenCalled();
  });

  it('records a year that legitimately has no flares, so it is not refetched forever', async () => {
    // 2009 really does have zero M/X flares. Row presence cannot tell a quiet
    // year from an unfetched one, which is why the chunks table exists.
    const { db, controller } = setup();
    fetchGoesFlareYear.mockResolvedValue([]);
    await controller.start();
    fetchGoesFlareYear.mockClear();

    await createGoesFlareController(db, () => undefined).start();
    expect(fetchGoesFlareYear).not.toHaveBeenCalled();
  });

  it('does not record a year whose fetch failed', async () => {
    const { db, controller } = setup();
    fetchGoesFlareYear.mockImplementation((year: number) =>
      year === GOES_FLARE_START_YEAR + 1
        ? Promise.reject(new Error('boom'))
        : Promise.resolve([flare(year)]),
    );

    const final = await controller.start();
    expect(final.state).toBe('failed');
    expect(final.error).toContain(String(GOES_FLARE_START_YEAR + 1));

    // Resuming retries exactly the year that failed and everything after it,
    // and nothing before.
    fetchGoesFlareYear.mockReset().mockImplementation((year: number) => Promise.resolve([flare(year)]));
    await createGoesFlareController(db, () => undefined).start();
    const retried = fetchGoesFlareYear.mock.calls.map(([year]) => year as number);
    expect(retried[0]).toBe(GOES_FLARE_START_YEAR + 1);
  });

  it('retries a transient failure rather than failing the run', async () => {
    const { controller } = setup();
    let firstYearCalls = 0;
    fetchGoesFlareYear.mockImplementation((year: number) => {
      if (year !== GOES_FLARE_START_YEAR) return Promise.resolve([flare(year)]);
      firstYearCalls += 1;
      // Fails twice, succeeds on the third — inside the 3-attempt budget.
      return firstYearCalls <= 2
        ? Promise.reject(new Error('flaky'))
        : Promise.resolve([flare(year)]);
    });

    const final = await controller.start();
    expect(final.state).toBe('complete');
    expect(firstYearCalls).toBe(3);
  });

  it('re-running stores no duplicates', async () => {
    const { db, controller } = setup();
    await controller.start();
    const afterFirst = querySolarFlares(db, '1900-01-01', '2100-01-01').length;

    // Force a refetch of everything by clearing the bookkeeping only.
    db.exec('DELETE FROM goes_flare_chunks');
    await createGoesFlareController(db, () => undefined).start();

    expect(querySolarFlares(db, '1900-01-01', '2100-01-01')).toHaveLength(afterFirst);
  });

  it('start() is idempotent — a second call joins the run in flight', async () => {
    const { controller } = setup();
    const first = controller.start();
    const second = controller.start();

    expect(await first).toEqual(await second);
    expect(fetchGoesFlareYear).toHaveBeenCalledTimes(GOES_FLARE_LAST_YEAR - GOES_FLARE_START_YEAR + 1);
  });

  it('cancel stops the run and keeps the years already done', async () => {
    const { db, controller } = setup();
    fetchGoesFlareYear.mockImplementation((year: number) => {
      if (year === GOES_FLARE_START_YEAR + 2) controller.cancel();
      return Promise.resolve([flare(year)]);
    });

    const final = await controller.start();
    expect(final.state).toBe('cancelled');
    expect(final.completedChunks).toBeGreaterThan(0);
    expect(final.completedChunks).toBeLessThan(final.totalChunks);
    expect(querySolarFlares(db, '1900-01-01', '2100-01-01').length).toBe(final.completedChunks);
  });

  it('cancel before a run has started does nothing', async () => {
    const { controller } = setup();
    controller.cancel();

    expect((await controller.start()).state).toBe('complete');
  });

  it('reports progress with a total that matches the closed record', () => {
    const { controller } = setup();
    const initial = controller.status();

    expect(initial.state).toBe('idle');
    expect(initial.totalChunks).toBe(21);
    expect(initial.completedChunks).toBe(0);
    expect(initial.currentYear).toBeNull();
  });
});

describe('registerGoesFlareIpcHandlers', () => {
  it('registers status, start and cancel', () => {
    const { controller } = setup();
    registerGoesFlareIpcHandlers(controller, () => undefined);

    const channels = ipcHandle.mock.calls.map(([channel]) => channel as string);
    expect(channels).toEqual(['goes-flares:status', 'goes-flares:start', 'goes-flares:cancel']);
  });

  it('signals the renderer once a download finishes, or the layer stays blank', async () => {
    const { controller } = setup();
    const onUpdated = vi.fn();
    registerGoesFlareIpcHandlers(controller, onUpdated);

    await handlerFor('goes-flares:start')(null, null);
    expect(onUpdated).toHaveBeenCalledOnce();
  });
});
