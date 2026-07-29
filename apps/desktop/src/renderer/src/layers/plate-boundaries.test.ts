import { describe, expect, it, vi } from 'vitest';
import type * as Cesium from 'cesium';
import { createPlateBoundariesLayer } from './plate-boundaries';
import { KINEMATIC_GROUPS, isKinematicGroup, kinematicColorHex } from './plate-kinematics';
import boundaryData from '../data/plate-boundaries.json';

function createFakeViewer(options?: { destroyed?: boolean }): Cesium.Viewer {
  return {
    isDestroyed: vi.fn(() => options?.destroyed ?? false),
    dataSources: {
      add: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => true),
    },
  } as unknown as Cesium.Viewer;
}

describe('vendored boundary data', () => {
  it('is a non-empty array of merged runs', () => {
    expect(Array.isArray(boundaryData)).toBe(true);
    expect(boundaryData.length).toBeGreaterThan(0);
  });

  it('gives every run a recognised kinematic group', () => {
    // A group the layer doesn't know would silently render nothing, so this
    // guards the vendor script's class mapping.
    for (const run of boundaryData) {
      expect(isKinematicGroup(run.g)).toBe(true);
    }
  });

  it('gives every run at least two points, as a polyline requires', () => {
    for (const run of boundaryData) {
      expect(run.p.length).toBeGreaterThanOrEqual(4); // 2 points × lon,lat
      expect(run.p.length % 2).toBe(0);
    }
  });

  it('keeps coordinates in valid geographic range', () => {
    for (const run of boundaryData) {
      for (let i = 0; i < run.p.length; i += 2) {
        expect(Math.abs(run.p[i]!)).toBeLessThanOrEqual(180);
        expect(Math.abs(run.p[i + 1]!)).toBeLessThanOrEqual(90);
      }
    }
  });

  it('contains all three kinematic behaviours', () => {
    const present = new Set(boundaryData.map((run) => run.g));
    for (const group of KINEMATIC_GROUPS) {
      expect(present.has(group)).toBe(true);
    }
  });
});

describe('kinematicColorHex', () => {
  it('gives each group a distinct colour within a tone', () => {
    for (const tone of ['light', 'dark'] as const) {
      const colors = KINEMATIC_GROUPS.map((g) => kinematicColorHex(g, tone));
      expect(new Set(colors).size).toBe(KINEMATIC_GROUPS.length);
    }
  });

  it('uses a different step per backdrop tone', () => {
    for (const group of KINEMATIC_GROUPS) {
      expect(kinematicColorHex(group, 'light')).not.toBe(kinematicColorHex(group, 'dark'));
    }
  });

  it('avoids blue, which is reserved for the earthquake depth ramp', () => {
    // Boundaries and events share the globe; if both were blue they'd be
    // confusable at a glance.
    const depthRampBlues = ['#0d366b', '#184f95', '#256abf', '#3987e5', '#6da7ec'];
    for (const tone of ['light', 'dark'] as const) {
      for (const group of KINEMATIC_GROUPS) {
        expect(depthRampBlues).not.toContain(kinematicColorHex(group, tone));
      }
    }
  });
});

describe('plate boundaries layer', () => {
  it('conforms to the GlobeLayer contract as a toggleable overlay', () => {
    const layer = createPlateBoundariesLayer('light');
    expect(layer.id).toBe('plate-boundaries');
    expect(layer.category).toBe('overlay');
    expect(layer.exclusive).toBeUndefined();
  });

  it('builds one entity per boundary run', () => {
    const layer = createPlateBoundariesLayer('light');
    const viewer = createFakeViewer();

    layer.mount(viewer);

    const added = vi.mocked(viewer.dataSources.add).mock.calls[0]![0] as Cesium.CustomDataSource;
    expect(added.entities.values).toHaveLength(boundaryData.length);
  });

  it('removes and destroys the data source on unmount', () => {
    const layer = createPlateBoundariesLayer('light');
    const viewer = createFakeViewer();

    layer.mount(viewer);
    layer.unmount();

    expect(viewer.dataSources.remove).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('does not touch an already-destroyed viewer on unmount', () => {
    const layer = createPlateBoundariesLayer('light');
    const viewer = createFakeViewer();

    layer.mount(viewer);
    vi.mocked(viewer.isDestroyed).mockReturnValue(true);

    expect(() => layer.unmount()).not.toThrow();
    expect(viewer.dataSources.remove).not.toHaveBeenCalled();
  });

  it('detaches if unmounted before the async add resolves', async () => {
    const layer = createPlateBoundariesLayer('light');
    const viewer = createFakeViewer();

    layer.mount(viewer);
    layer.unmount();
    await Promise.resolve();
    await Promise.resolve();

    expect(viewer.dataSources.remove).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('does nothing on unmount if never mounted', () => {
    const layer = createPlateBoundariesLayer('light');
    expect(() => layer.unmount()).not.toThrow();
  });
});
