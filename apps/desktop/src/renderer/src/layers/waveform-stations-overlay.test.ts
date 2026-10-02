import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Cesium from 'cesium';
import { JulianDate } from 'cesium';
import {
  createWaveformStationsOverlay,
  waveformStationEntityId,
  waveformStationKey,
} from './waveform-stations-overlay';

/**
 * The markers are drawn to canvases, and the node environment has none — the
 * stub the other layer tests use. No 2d context, which both drawing functions
 * already tolerate by returning the blank canvas.
 */
beforeAll(() => {
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function createFakeViewer(options?: { destroyed?: boolean; addPending?: boolean }) {
  const added: Cesium.CustomDataSource[] = [];
  let resolveAdd: () => void = () => undefined;
  const viewer = {
    isDestroyed: vi.fn(() => options?.destroyed ?? false),
    dataSources: {
      add: vi.fn((source: Cesium.CustomDataSource) => {
        added.push(source);
        if (options?.addPending !== true) return Promise.resolve(source);
        return new Promise((resolve) => {
          resolveAdd = () => {
            resolve(source);
          };
        });
      }),
      remove: vi.fn(() => true),
    },
  };
  return {
    viewer: viewer as unknown as Cesium.Viewer,
    raw: viewer,
    added,
    finishAdd: () => {
      resolveAdd();
    },
  };
}

const RATT = { network: 'UW', station: 'RATT', latitude: 47.6, longitude: -122.3 };
const ADO = { network: 'CI', station: 'ADO', latitude: 34.5, longitude: -117.4 };

describe('waveform stations overlay', () => {
  it('marks every station, plus the picked spot when there is one', () => {
    const { viewer, added } = createFakeViewer();
    createWaveformStationsOverlay(viewer).update([RATT, ADO], { latitude: 47, longitude: -122 });

    const entities = added[0]!.entities.values;
    expect(entities).toHaveLength(3);
    expect(added[0]!.entities.getById(waveformStationEntityId(RATT))).toBeDefined();
    expect(added[0]!.entities.getById(waveformStationEntityId(ADO))).toBeDefined();
  });

  it('draws no spot for a preset, which has none', () => {
    const { viewer, added } = createFakeViewer();
    createWaveformStationsOverlay(viewer).update([RATT], null);
    expect(added[0]!.entities.values).toHaveLength(1);
  });

  it('replaces rather than accumulates on update', () => {
    const { viewer, added } = createFakeViewer();
    const overlay = createWaveformStationsOverlay(viewer);
    overlay.update([RATT, ADO], null);
    overlay.update([RATT], null);
    expect(added[0]!.entities.values).toHaveLength(1);
  });

  describe('highlighting a hovered row', () => {
    const now = new JulianDate();
    function look(source: Cesium.CustomDataSource, station: typeof RATT) {
      const entity = source.entities.getById(waveformStationEntityId(station))!;
      return {
        width: entity.billboard!.width!.getValue(now) as number,
        alpha: (entity.billboard!.color!.getValue(now) as Cesium.Color).alpha,
        labelAlpha: (entity.label!.fillColor!.getValue(now) as Cesium.Color).alpha,
      };
    }

    it('grows the hovered marker and fades the others', () => {
      const { viewer, added } = createFakeViewer();
      const overlay = createWaveformStationsOverlay(viewer);
      overlay.update([RATT, ADO], null);
      overlay.setHighlighted(waveformStationKey(RATT));

      const hovered = look(added[0]!, RATT);
      const other = look(added[0]!, ADO);
      expect(hovered.width).toBeGreaterThan(other.width);
      expect(hovered.alpha).toBe(1);
      expect(other.alpha).toBeLessThan(1);
      // The label fades with its marker, or a dimmed triangle keeps a loud name.
      expect(other.labelAlpha).toBeLessThan(1);
    });

    it('restores every marker when the hover clears', () => {
      const { viewer, added } = createFakeViewer();
      const overlay = createWaveformStationsOverlay(viewer);
      overlay.update([RATT, ADO], null);
      const before = look(added[0]!, ADO);
      overlay.setHighlighted(waveformStationKey(RATT));
      overlay.setHighlighted(null);

      expect(look(added[0]!, RATT)).toEqual(before);
      expect(look(added[0]!, ADO)).toEqual(before);
    });

    it('restyles in place rather than rebuilding the markers', () => {
      const { viewer, added } = createFakeViewer();
      const overlay = createWaveformStationsOverlay(viewer);
      overlay.update([RATT, ADO], null);
      const entity = added[0]!.entities.getById(waveformStationEntityId(RATT));
      overlay.setHighlighted(waveformStationKey(RATT));
      expect(added[0]!.entities.getById(waveformStationEntityId(RATT))).toBe(entity);
    });

    it('keeps the highlight across an update of the stations', () => {
      const { viewer, added } = createFakeViewer();
      const overlay = createWaveformStationsOverlay(viewer);
      overlay.setHighlighted(waveformStationKey(ADO));
      overlay.update([RATT, ADO], null);
      expect(look(added[0]!, ADO).width).toBeGreaterThan(look(added[0]!, RATT).width);
    });
  });

  it('removes and destroys its data source on destroy (non-negotiable #5)', async () => {
    const { viewer, raw, added } = createFakeViewer();
    const overlay = createWaveformStationsOverlay(viewer);
    await Promise.resolve();
    overlay.destroy();
    expect(raw.dataSources.remove).toHaveBeenCalledWith(added[0], true);
  });

  it('cleans up a source that finishes attaching after it was destroyed', async () => {
    // Leaving the mode can unmount this before `dataSources.add` resolves;
    // without the guard the markers would stay on the globe in Explore.
    const { viewer, raw, added, finishAdd } = createFakeViewer({ addPending: true });
    const overlay = createWaveformStationsOverlay(viewer);
    overlay.destroy();
    expect(raw.dataSources.remove).not.toHaveBeenCalled();

    finishAdd();
    await Promise.resolve();
    await Promise.resolve();
    expect(raw.dataSources.remove).toHaveBeenCalledWith(added[0], true);
  });

  it('does not touch a viewer that is already destroyed', async () => {
    const { viewer, raw } = createFakeViewer({ destroyed: true });
    const overlay = createWaveformStationsOverlay(viewer);
    await Promise.resolve();
    overlay.destroy();
    expect(raw.dataSources.remove).not.toHaveBeenCalled();
  });
});
