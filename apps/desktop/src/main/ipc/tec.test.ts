import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEC_CADENCE_MS, type TecGrid } from '@terra-pulse/schema';

// `registerTecIpcHandlers` imports ipcMain at module load; nothing under test
// touches Electron beyond registering the one handler.
const ipcHandle = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ ipcMain: { handle: ipcHandle } }));

const fetchTecGrid = vi.hoisted(() => vi.fn());
vi.mock('@terra-pulse/ingest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@terra-pulse/ingest')>();
  return { ...actual, fetchTecGrid };
});

function grid(observedAtUtc = '2026-08-20T00:00:00.000Z'): TecGrid {
  return { tec: [1], anomaly: [0], qualityFlag: [0], observedAtUtc };
}

/**
 * A fresh module per case.
 *
 * `tec.ts` holds `cached` and `inFlight` at module scope rather than in a
 * factory closure like the controllers do, so without `resetModules` one
 * test's cached map would satisfy the next test's first ask and the fetch
 * counts every assertion here depends on would be meaningless.
 */
async function loadHandler(): Promise<() => Promise<TecGrid | null>> {
  vi.resetModules();
  ipcHandle.mockClear();
  const mod = await import('./tec');
  mod.registerTecIpcHandlers();

  const call = ipcHandle.mock.calls.find(([channel]) => channel === 'tec:latest');
  if (!call) throw new Error('no handler registered for tec:latest');
  const handler = call[1] as () => Promise<TecGrid | null>;
  return handler;
}

beforeEach(() => {
  fetchTecGrid.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('tec:latest caching', () => {
  it('serves repeated asks inside one publication cadence from a single fetch', async () => {
    // The whole reason this feed is pulled rather than polled: a map is 2.4 MB.
    const map = grid();
    fetchTecGrid.mockResolvedValue(map);
    const handler = await loadHandler();

    expect(await handler()).toBe(map);
    expect(await handler()).toBe(map);
    expect(await handler()).toBe(map);

    expect(fetchTecGrid).toHaveBeenCalledTimes(1);
  });

  it('refetches once the cadence has elapsed', async () => {
    const first = grid('2026-08-20T00:00:00.000Z');
    const second = grid('2026-08-20T00:10:00.000Z');
    fetchTecGrid.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const handler = await loadHandler();

    expect(await handler()).toBe(first);

    vi.setSystemTime(new Date(Date.now() + TEC_CADENCE_MS + 1));

    expect(await handler()).toBe(second);
    expect(fetchTecGrid).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight request between concurrent askers', async () => {
    // Two layers mounting in the same commit would otherwise pull 4.8 MB to
    // draw one map — this is the case the `inFlight ??=` exists for, and it is
    // invisible to a test that awaits each ask in turn.
    const map = grid();
    let resolveFetch!: (value: TecGrid) => void;
    fetchTecGrid.mockReturnValue(
      new Promise<TecGrid>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const handler = await loadHandler();

    const a = handler();
    const b = handler();
    resolveFetch(map);

    expect(await a).toBe(map);
    expect(await b).toBe(map);
    expect(fetchTecGrid).toHaveBeenCalledTimes(1);
  });
});

describe('tec:latest failure handling', () => {
  it('returns the last good map rather than nothing', async () => {
    // A map twenty minutes old is far more use than an empty globe, and the
    // renderer has the timestamp and decides what is too old to draw.
    const map = grid();
    fetchTecGrid.mockResolvedValueOnce(map).mockRejectedValueOnce(new Error('SWPC down'));
    const handler = await loadHandler();

    expect(await handler()).toBe(map);

    vi.setSystemTime(new Date(Date.now() + TEC_CADENCE_MS + 1));

    expect(await handler()).toBe(map);
    expect(fetchTecGrid).toHaveBeenCalledTimes(2);
  });

  it('returns null when the very first fetch fails', async () => {
    fetchTecGrid.mockRejectedValue(new Error('SWPC down'));
    const handler = await loadHandler();

    expect(await handler()).toBeNull();
  });

  it('does not wedge — a later ask retries after a failure', async () => {
    // `inFlight` is cleared in a `finally`, so a rejected fetch must not leave
    // a permanently-rejected promise parked in the slot. Without that, the
    // layer would stay empty for the rest of the session after one blip.
    const map = grid();
    fetchTecGrid.mockRejectedValueOnce(new Error('SWPC down')).mockResolvedValueOnce(map);
    const handler = await loadHandler();

    expect(await handler()).toBeNull();
    expect(await handler()).toBe(map);
    expect(fetchTecGrid).toHaveBeenCalledTimes(2);
  });
});
