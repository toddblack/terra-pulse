import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuroraGrid } from '@terra-pulse/schema';

const ipcHandle = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ ipcMain: { handle: ipcHandle } }));

const fetchAuroraGrid = vi.hoisted(() => vi.fn());
vi.mock('@terra-pulse/ingest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@terra-pulse/ingest')>();
  return { ...actual, fetchAuroraGrid };
});

const INTERVAL_MS = 1000;

function auroraGrid(observedAtUtc = '2026-08-20T00:00:00.000Z'): AuroraGrid {
  return {
    observedAtUtc,
    forecastForUtc: '2026-08-20T01:00:00.000Z',
    fetchedAtUtc: observedAtUtc,
    width: 2,
    height: 1,
    values: new Uint8Array([0, 40]),
  };
}

/** Fresh module per case — `latest` lives at module scope, not in a closure. */
async function loadModule(): Promise<typeof import('./aurora')> {
  vi.resetModules();
  ipcHandle.mockClear();
  return import('./aurora');
}

function latestHandler(): () => AuroraGrid | null {
  const call = ipcHandle.mock.calls.find(([channel]) => channel === 'aurora:latest');
  if (!call) throw new Error('no handler registered for aurora:latest');
  return call[1] as () => AuroraGrid | null;
}

beforeEach(() => {
  fetchAuroraGrid.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('aurora polling', () => {
  it('polls once immediately rather than waiting out the first interval', async () => {
    const grid = auroraGrid();
    fetchAuroraGrid.mockResolvedValue(grid);

    const mod = await loadModule();
    const pushed: AuroraGrid[] = [];
    const stop = mod.startAuroraPolling((g) => pushed.push(g), INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(0);

    expect(fetchAuroraGrid).toHaveBeenCalledTimes(1);
    expect(pushed).toEqual([grid]);

    stop();
  });

  it('keeps polling on the interval', async () => {
    fetchAuroraGrid.mockResolvedValue(auroraGrid());

    const mod = await loadModule();
    const stop = mod.startAuroraPolling(() => {}, INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(fetchAuroraGrid).toHaveBeenCalledTimes(4);

    stop();
  });

  it('stops polling once the returned stop function is called', async () => {
    fetchAuroraGrid.mockResolvedValue(auroraGrid());

    const mod = await loadModule();
    const stop = mod.startAuroraPolling(() => {}, INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);

    expect(fetchAuroraGrid).toHaveBeenCalledTimes(1);
  });

  it('does not publish a grid that arrives after stopping', async () => {
    let resolveFetch!: (value: AuroraGrid) => void;
    fetchAuroraGrid.mockReturnValue(
      new Promise<AuroraGrid>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const mod = await loadModule();
    const pushed: AuroraGrid[] = [];
    const stop = mod.startAuroraPolling((g) => pushed.push(g), INTERVAL_MS);

    stop();
    resolveFetch(auroraGrid());
    await vi.advanceTimersByTimeAsync(0);

    expect(pushed).toHaveLength(0);
  });
});

describe('aurora failure handling', () => {
  it('does not clear the last grid when a poll fails', async () => {
    // Deliberate: the renderer decides what is too old to draw, using the
    // timestamps the grid already carries. Clearing here would blank the layer
    // on a single blip and lose information the renderer was using.
    const grid = auroraGrid();
    fetchAuroraGrid
      .mockResolvedValueOnce(grid)
      .mockRejectedValueOnce(new Error('SWPC unreachable'));

    const mod = await loadModule();
    mod.registerAuroraIpcHandlers();
    const latest = latestHandler();
    const stop = mod.startAuroraPolling(() => {}, INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(0);
    expect(latest()).toBe(grid);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(fetchAuroraGrid).toHaveBeenCalledTimes(2);
    expect(latest()).toBe(grid);

    stop();
  });

  it('keeps retrying after a failure rather than giving up', async () => {
    const grid = auroraGrid();
    fetchAuroraGrid
      .mockRejectedValueOnce(new Error('SWPC unreachable'))
      .mockResolvedValueOnce(grid);

    const mod = await loadModule();
    mod.registerAuroraIpcHandlers();
    const latest = latestHandler();
    const stop = mod.startAuroraPolling(() => {}, INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(0);
    expect(latest()).toBeNull();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(latest()).toBe(grid);

    stop();
  });
});

describe('aurora:latest', () => {
  it('answers null before the first successful fetch', async () => {
    // The layer shows nothing until the first fetch, and nothing offline.
    // That is stated plainly rather than papered over with a stale grid.
    const mod = await loadModule();
    mod.registerAuroraIpcHandlers();

    expect(latestHandler()()).toBeNull();
  });
});
