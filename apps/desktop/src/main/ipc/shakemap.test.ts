import { describe, expect, it, vi } from 'vitest';
import type { ShakeMapResult } from '@terra-pulse/schema';

// `shakemap.ts` imports ipcMain at module load; the lookup under test never
// touches Electron.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

const { createShakeMapLookup } = await import('./shakemap');

const NONE: ShakeMapResult = { status: 'none' };

function available(eventId: string): ShakeMapResult {
  return {
    status: 'available',
    map: {
      eventId,
      maxMmi: 7,
      source: 'us',
      version: '1',
      processedAtUtc: null,
      contours: [],
    },
  };
}

describe('the ShakeMap lookup', () => {
  it('asks once and reuses the answer', async () => {
    const fetcher = vi.fn((id: string) => Promise.resolve(available(id)));
    const lookup = createShakeMapLookup(fetcher, () => 0);

    await lookup.get('a');
    await lookup.get('a');

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shares one request between askers that arrive together', async () => {
    // The inspector and the globe can both want the same quake in one commit.
    let release: (result: ShakeMapResult) => void = () => undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<ShakeMapResult>((resolve) => {
          release = resolve;
        }),
    );
    const lookup = createShakeMapLookup(fetcher, () => 0);

    const first = lookup.get('a');
    const second = lookup.get('a');
    release(available('a'));

    expect(await first).toEqual(await second);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('asks again once the answer is old enough to have been revised', async () => {
    // A recent quake's map is revised many times in its first days.
    let now = 0;
    const fetcher = vi.fn((id: string) => Promise.resolve(available(id)));
    const lookup = createShakeMapLookup(fetcher, () => now);

    await lookup.get('a');
    now = 9 * 60 * 1000;
    await lookup.get('a');
    expect(fetcher).toHaveBeenCalledTimes(1);

    now = 11 * 60 * 1000;
    await lookup.get('a');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('remembers "no map", which is USGS answering', async () => {
    const fetcher = vi.fn(() => Promise.resolve(NONE));
    const lookup = createShakeMapLookup(fetcher, () => 0);

    expect(await lookup.get('a')).toEqual(NONE);
    expect(await lookup.get('a')).toEqual(NONE);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('never remembers a failure', async () => {
    // One dropped connection must not turn into "no map" for ten minutes.
    const fetcher = vi
      .fn<(id: string) => Promise<ShakeMapResult>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(available('a'));
    const lookup = createShakeMapLookup(fetcher, () => 0);

    await expect(lookup.get('a')).rejects.toThrow('offline');
    expect(await lookup.get('a')).toEqual(available('a'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps separate quakes separate', async () => {
    const fetcher = vi.fn((id: string) => Promise.resolve(available(id)));
    const lookup = createShakeMapLookup(fetcher, () => 0);

    const a = await lookup.get('a');
    const b = await lookup.get('b');

    expect(a.status === 'available' && a.map.eventId).toBe('a');
    expect(b.status === 'available' && b.map.eventId).toBe('b');
  });

  it('does not grow without bound as a reader works down a list', async () => {
    const fetcher = vi.fn((id: string) => Promise.resolve(available(id)));
    const lookup = createShakeMapLookup(fetcher, () => 0);

    for (let index = 0; index < 60; index += 1) await lookup.get(`quake-${String(index)}`);
    expect(fetcher).toHaveBeenCalledTimes(60);

    // The most recent is still held; the first was let go and is asked again.
    await lookup.get('quake-59');
    expect(fetcher).toHaveBeenCalledTimes(60);
    await lookup.get('quake-0');
    expect(fetcher).toHaveBeenCalledTimes(61);
  });
});
