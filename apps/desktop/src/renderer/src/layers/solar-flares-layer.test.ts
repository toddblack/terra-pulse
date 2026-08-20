import { describe, expect, it, vi } from 'vitest';
import type * as Cesium from 'cesium';
import type { SolarFlare } from '@terra-pulse/schema';
import { createSolarFlaresLayer } from './solar-flares-layer';

function makeFlare(overrides: Partial<SolarFlare> = {}): SolarFlare {
  return {
    id: '2026-08-10T12:34:00-FLR-001',
    source: 'donki',
    classType: 'M2.4',
    flareClass: 'M',
    magnitude: 2.4,
    peakTimeUtc: '2026-08-10T13:16:00.000Z',
    beginTimeUtc: '2026-08-10T12:34:00.000Z',
    endTimeUtc: '2026-08-10T13:38:00.000Z',
    sourceLocation: 'N14W102',
    activeRegionNumber: 13842,
    link: 'https://example.test/flr',
    ...overrides,
  };
}

function createFakeViewer(options?: { destroyed?: boolean }): Cesium.Viewer {
  return {
    isDestroyed: vi.fn(() => options?.destroyed ?? false),
    dataSources: {
      add: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => true),
    },
  } as unknown as Cesium.Viewer;
}

function mount(flares: SolarFlare[]) {
  const layer = createSolarFlaresLayer();
  const viewer = createFakeViewer();
  layer.mount(viewer);
  layer.setFlares(flares);
  const added = vi.mocked(viewer.dataSources.add).mock.calls[0]![0] as Cesium.CustomDataSource;
  return { layer, viewer, added };
}

describe('solar flares layer', () => {
  it('conforms to the GlobeLayer contract as an events layer, off by default', () => {
    const layer = createSolarFlaresLayer();
    expect(layer.id).toBe('solar-flares');
    expect(layer.category).toBe('events');
    expect(layer.defaultVisible).toBe(false);
  });

  it('draws M-class and above, and drops everything below M', () => {
    const { added } = mount([
      makeFlare({ id: 'm', classType: 'M2.4', flareClass: 'M', magnitude: 2.4 }),
      makeFlare({ id: 'x', classType: 'X1.0', flareClass: 'X', magnitude: 1 }),
      makeFlare({ id: 'c', classType: 'C8.1', flareClass: 'C', magnitude: 8.1 }),
    ]);

    expect(added.entities.getById('flare-m')).toBeDefined();
    expect(added.entities.getById('flare-x')).toBeDefined();
    expect(added.entities.getById('flare-c')).toBeUndefined();
  });

  it('removes and destroys the data source on unmount', () => {
    const { layer, viewer } = mount([makeFlare()]);
    layer.unmount();

    // The `true` is what destroys the entities — non-negotiable #5.
    expect(viewer.dataSources.remove).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('does not touch an already-destroyed viewer on unmount', () => {
    const layer = createSolarFlaresLayer();
    const viewer = createFakeViewer();
    layer.mount(viewer);
    vi.mocked(viewer.isDestroyed).mockReturnValue(true);

    expect(() => layer.unmount()).not.toThrow();
    expect(viewer.dataSources.remove).not.toHaveBeenCalled();
  });

  describe('setTimeWindow', () => {
    it('shows a flare peaking inside the window and hides one outside it, without rebuilding', () => {
      const { layer, viewer, added } = mount([
        makeFlare({ id: 'inside', peakTimeUtc: '2026-08-10T13:16:00.000Z' }),
        makeFlare({ id: 'outside', peakTimeUtc: '2026-07-01T00:00:00.000Z' }),
      ]);
      vi.mocked(viewer.dataSources.add).mockClear();

      layer.setTimeWindow(
        new Date('2026-08-09T00:00:00Z'),
        new Date('2026-08-11T00:00:00Z'),
      );

      expect(added.entities.getById('flare-inside')?.show).toBe(true);
      expect(added.entities.getById('flare-outside')?.show).toBe(false);
      // The whole point of the split: a window change must not touch the
      // data source at all, only entity `show` flags.
      expect(viewer.dataSources.add).not.toHaveBeenCalled();
    });

    it('re-applies the current window to entities added by a later setFlares', () => {
      const { layer, viewer, added } = mount([
        makeFlare({ id: 'first', peakTimeUtc: '2026-08-10T13:16:00.000Z' }),
      ]);
      layer.setTimeWindow(new Date('2026-08-09T00:00:00Z'), new Date('2026-08-11T00:00:00Z'));

      layer.setFlares([
        makeFlare({ id: 'first', peakTimeUtc: '2026-08-10T13:16:00.000Z' }),
        makeFlare({ id: 'later', peakTimeUtc: '2026-09-01T00:00:00.000Z' }),
      ]);
      const rebuilt = vi.mocked(viewer.dataSources.add).mock.calls[0]![0] as Cesium.CustomDataSource;

      expect(rebuilt.entities.getById('flare-first')?.show).toBe(true);
      expect(rebuilt.entities.getById('flare-later')?.show).toBe(false);
      // Same data source instance throughout — `mount` only attaches once.
      expect(rebuilt).toBe(added);
    });

    it('shows everything once the window is cleared back to null-equivalent (no window applied yet)', () => {
      // Before any setTimeWindow call, entities default to visible.
      const { added } = mount([makeFlare({ id: 'a' })]);
      expect(added.entities.getById('flare-a')?.show).toBe(true);
    });
  });
});
