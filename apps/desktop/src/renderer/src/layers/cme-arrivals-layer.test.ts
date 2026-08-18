import { describe, expect, it, vi } from 'vitest';
import type * as Cesium from 'cesium';
import type { CmeArrival } from '@terra-pulse/schema';
import { createCmeArrivalsLayer } from './cme-arrivals-layer';

function makeArrival(overrides: Partial<CmeArrival> = {}): CmeArrival {
  return {
    simulationId: 'WSA-ENLIL/1234',
    arrivalTimeUtc: '2026-07-05T12:00:00.000Z',
    predictedKp: 5,
    glancingBlow: false,
    minorImpact: false,
    link: 'https://example.test/enlil',
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

function mount(arrivals: CmeArrival[]) {
  const layer = createCmeArrivalsLayer();
  const viewer = createFakeViewer();
  layer.mount(viewer);
  layer.setArrivals(arrivals);
  const added = vi.mocked(viewer.dataSources.add).mock.calls[0]![0] as Cesium.CustomDataSource;
  return { layer, viewer, added };
}

describe('CME arrivals layer', () => {
  it('conforms to the GlobeLayer contract as an events layer, off by default', () => {
    const layer = createCmeArrivalsLayer();
    expect(layer.id).toBe('cme-arrivals');
    expect(layer.category).toBe('events');
    expect(layer.defaultVisible).toBe(false);
  });

  it('draws one entity per arrival, direct and glancing alike', () => {
    const { added } = mount([
      makeArrival({ simulationId: 'direct' }),
      makeArrival({ simulationId: 'graze', glancingBlow: true }),
    ]);

    expect(added.entities.getById('cme-direct')?.name).toBe('CME arrival (direct)');
    expect(added.entities.getById('cme-graze')?.name).toBe('CME arrival (glancing)');
  });

  it('removes and destroys the data source on unmount', () => {
    const { layer, viewer } = mount([makeArrival()]);
    layer.unmount();

    expect(viewer.dataSources.remove).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('does not touch an already-destroyed viewer on unmount', () => {
    const layer = createCmeArrivalsLayer();
    const viewer = createFakeViewer();
    layer.mount(viewer);
    vi.mocked(viewer.isDestroyed).mockReturnValue(true);

    expect(() => layer.unmount()).not.toThrow();
    expect(viewer.dataSources.remove).not.toHaveBeenCalled();
  });

  describe('setTimeWindow', () => {
    it('shows an arrival inside the window and hides one outside it, without rebuilding', () => {
      const { layer, viewer, added } = mount([
        makeArrival({ simulationId: 'inside', arrivalTimeUtc: '2026-07-05T12:00:00.000Z' }),
        makeArrival({ simulationId: 'outside', arrivalTimeUtc: '2026-06-01T00:00:00.000Z' }),
      ]);
      vi.mocked(viewer.dataSources.add).mockClear();

      layer.setTimeWindow(new Date('2026-07-04T00:00:00Z'), new Date('2026-07-06T00:00:00Z'));

      expect(added.entities.getById('cme-inside')?.show).toBe(true);
      expect(added.entities.getById('cme-outside')?.show).toBe(false);
      expect(viewer.dataSources.add).not.toHaveBeenCalled();
    });

    it('everything is visible before any window has been applied', () => {
      const { added } = mount([makeArrival({ simulationId: 'a' })]);
      expect(added.entities.getById('cme-a')?.show).toBe(true);
    });
  });
});
