import { describe, expect, it, vi } from 'vitest';
import type * as Cesium from 'cesium';
import { createSubductionZonesLayer } from './subduction-zones';
import { kinematicColorHex } from './plate-kinematics';
import { toothImageDataUri } from './subduction-encoding';
import trenchData from '../data/subduction-trenches.json';

function createFakeViewer(options?: { destroyed?: boolean }): Cesium.Viewer {
  return {
    isDestroyed: vi.fn(() => options?.destroyed ?? false),
    dataSources: {
      add: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => true),
    },
  } as unknown as Cesium.Viewer;
}

function mountAndGetSource(tone: 'light' | 'dark' = 'light'): Cesium.CustomDataSource {
  const layer = createSubductionZonesLayer(tone);
  const viewer = createFakeViewer();
  layer.mount(viewer);
  return vi.mocked(viewer.dataSources.add).mock.calls[0]![0] as Cesium.CustomDataSource;
}

describe('subduction zones layer', () => {
  it('conforms to the GlobeLayer contract as an independent overlay', () => {
    const layer = createSubductionZonesLayer('light');
    expect(layer.id).toBe('subduction-zones');
    expect(layer.category).toBe('overlay');
    expect(layer.exclusive).toBeUndefined();
    // Detail on top of the boundary picture, not baseline context.
    expect(layer.defaultVisible).toBe(false);
  });

  it('builds one entity per trench run plus one per tooth', () => {
    const source = mountAndGetSource();
    expect(source.entities.values).toHaveLength(trenchData.t.length + trenchData.k.length);
  });

  it('draws every trench as a polyline', () => {
    const source = mountAndGetSource();
    const trenches = source.entities.values.filter((e) => e.id.startsWith('trench-'));
    expect(trenches).toHaveLength(trenchData.t.length);
    for (const trench of trenches) {
      expect(trench.polyline).toBeDefined();
    }
  });

  it('draws every tooth as a billboard carrying its dip azimuth', () => {
    const source = mountAndGetSource();
    const teeth = source.entities.values.filter((e) => e.id.startsWith('tooth-'));
    expect(teeth).toHaveLength(trenchData.k.length);
    for (const tooth of teeth) {
      expect(tooth.billboard).toBeDefined();
      // The axis is what turns the triangle down-dip; a missing one would
      // render every tooth pointing screen-up and look plausible but be wrong.
      expect(tooth.billboard?.alignedAxis).toBeDefined();
      expect(tooth.properties?.['dipAzimuth']).toBeDefined();
    }
  });

  it('reuses the validated convergent colour rather than a new hue', () => {
    // Subduction is the convergent case. A fourth hue would invalidate the
    // palette check the other three passed.
    for (const tone of ['light', 'dark'] as const) {
      const source = mountAndGetSource(tone);
      const tooth = source.entities.values.find((e) => e.id.startsWith('tooth-'));
      const expected = toothImageDataUri(kinematicColorHex('convergent', tone));
      expect(tooth?.billboard?.image?.getValue()).toBe(expected);
    }
  });

  it('differs between backdrop tones so teeth stay legible on both basemaps', () => {
    const light = mountAndGetSource('light').entities.values.find((e) =>
      e.id.startsWith('tooth-'),
    );
    const dark = mountAndGetSource('dark').entities.values.find((e) => e.id.startsWith('tooth-'));
    expect(light?.billboard?.image?.getValue()).not.toBe(dark?.billboard?.image?.getValue());
  });

  it('removes and destroys the data source on unmount', () => {
    const layer = createSubductionZonesLayer('light');
    const viewer = createFakeViewer();

    layer.mount(viewer);
    layer.unmount();

    expect(viewer.dataSources.remove).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('does not touch an already-destroyed viewer on unmount', () => {
    const layer = createSubductionZonesLayer('light');
    const viewer = createFakeViewer();

    layer.mount(viewer);
    vi.mocked(viewer.isDestroyed).mockReturnValue(true);

    expect(() => layer.unmount()).not.toThrow();
    expect(viewer.dataSources.remove).not.toHaveBeenCalled();
  });

  it('detaches if unmounted before the async add resolves', async () => {
    const layer = createSubductionZonesLayer('light');
    const viewer = createFakeViewer();

    layer.mount(viewer);
    layer.unmount();
    await Promise.resolve();
    await Promise.resolve();

    expect(viewer.dataSources.remove).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('does nothing on unmount if never mounted', () => {
    const layer = createSubductionZonesLayer('light');
    expect(() => layer.unmount()).not.toThrow();
  });

  it('ignores a time window, being geological', () => {
    const layer = createSubductionZonesLayer('light');
    const viewer = createFakeViewer();
    layer.mount(viewer);

    const before = (
      vi.mocked(viewer.dataSources.add).mock.calls[0]![0] as Cesium.CustomDataSource
    ).entities.values.length;
    layer.setTimeWindow(new Date('2026-01-01'), new Date('2026-01-05'));

    const after = (
      vi.mocked(viewer.dataSources.add).mock.calls[0]![0] as Cesium.CustomDataSource
    ).entities.values.length;
    expect(after).toBe(before);
  });

  it('toggles visibility on the whole data source', () => {
    const layer = createSubductionZonesLayer('light');
    const viewer = createFakeViewer();
    layer.mount(viewer);
    const source = vi.mocked(viewer.dataSources.add).mock
      .calls[0]![0] as Cesium.CustomDataSource;

    layer.setVisible(false);
    expect(source.show).toBe(false);
    layer.setVisible(true);
    expect(source.show).toBe(true);
  });
});
