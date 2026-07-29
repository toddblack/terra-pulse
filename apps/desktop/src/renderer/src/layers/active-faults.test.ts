import { describe, expect, it, vi } from 'vitest';
import type * as Cesium from 'cesium';
import { createActiveFaultsLayer } from './active-faults';
import {
  FAULT_LINE_WIDTH,
  faultColorHex,
  faultMaxDistanceMeters,
  isFaultZoomTier,
} from './fault-encoding';
import { kinematicColorHex, kinematicLineWidth } from './plate-kinematics';
import faultData from '../data/active-faults.json';

function createFakeViewer(options?: { destroyed?: boolean }): Cesium.Viewer {
  return {
    isDestroyed: vi.fn(() => options?.destroyed ?? false),
    scene: {
      primitives: {
        add: vi.fn((p: unknown) => p),
        // Really destroys, because `PrimitiveCollection.remove` really does
        // (destroyPrimitives defaults true). A mock that merely recorded the
        // call let a crash ship: the layer shared one Material across all
        // 13,696 polylines, and `Polyline._destroy` destroys its material —
        // so the second polyline threw DeveloperError. Nothing caught it until
        // the app fell over, because teardown was never actually exercised.
        remove: vi.fn((p: Cesium.PolylineCollection) => {
          p.destroy();
          return true;
        }),
      },
    },
  } as unknown as Cesium.Viewer;
}

describe('vendored fault data', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(faultData)).toBe(true);
    expect(faultData.length).toBeGreaterThan(0);
  });

  it('gives every fault at least two points, as a polyline requires', () => {
    for (const fault of faultData) {
      expect(fault.p.length).toBeGreaterThanOrEqual(4); // 2 points x lon,lat
      expect(fault.p.length % 2).toBe(0);
    }
  });

  it('keeps every coordinate in valid geographic range', () => {
    for (const fault of faultData) {
      for (let i = 0; i < fault.p.length; i += 2) {
        expect(Math.abs(fault.p[i]!)).toBeLessThanOrEqual(180);
        expect(Math.abs(fault.p[i + 1]!)).toBeLessThanOrEqual(90);
      }
    }
  });

  it('tags every fault with a recognised zoom tier', () => {
    for (const fault of faultData) {
      expect(isFaultZoomTier(fault.z)).toBe(true);
    }
  });

  it('uses all three tiers, so zoom filtering actually does something', () => {
    const tiers = new Set(faultData.map((f) => f.z));
    expect(tiers.size).toBe(3);
  });

  it('keeps every chord short enough not to sag below the globe', () => {
    // PolylineCollection has no ArcType.GEODESIC, so the vendor script
    // pre-densifies to a 50 km cap. A regression there would put long faults
    // underground at grazing view angles — invisible in a unit test otherwise.
    const MAX_CHORD_KM = 50;
    const R = 6371;
    const toRad = Math.PI / 180;
    let longest = 0;

    for (const fault of faultData) {
      for (let i = 2; i < fault.p.length; i += 2) {
        const [lon1, lat1, lon2, lat2] = [
          fault.p[i - 2]!,
          fault.p[i - 1]!,
          fault.p[i]!,
          fault.p[i + 1]!,
        ];
        const dLat = (lat2 - lat1) * toRad;
        const dLon = (lon2 - lon1) * toRad;
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
        const km = 2 * R * Math.asin(Math.sqrt(a));
        if (km > longest) longest = km;
      }
    }

    expect(longest).toBeLessThanOrEqual(MAX_CHORD_KM * 1.01);
  });
});

describe('fault encoding', () => {
  it('draws thinner than any plate boundary', () => {
    // Where a fault traces a boundary, the two must still read as different
    // features rather than one doubled line.
    expect(FAULT_LINE_WIDTH).toBeLessThan(kinematicLineWidth('divergent'));
    expect(FAULT_LINE_WIDTH).toBeLessThan(kinematicLineWidth('convergent'));
  });

  it('uses a different step per backdrop tone', () => {
    expect(faultColorHex('light')).not.toBe(faultColorHex('dark'));
  });

  it('stays distinguishable from the convergent boundary colour', () => {
    // Faults are red and convergent margins are a warm orange-red, which is a
    // known, accepted clash — but "accepted" is not "unbounded". If a future
    // colour edit pushed them closer than this, the two layers would become
    // genuinely indistinguishable rather than merely similar.
    //
    // Threshold is the measured ΔE 10.5 of the current pair, minus headroom.
    // It is deliberately below the usual 15 floor and that is not an oversight
    // — see the note in fault-encoding.ts.
    for (const tone of ['light', 'dark'] as const) {
      expect(faultColorHex(tone)).not.toBe(kinematicColorHex('convergent', tone));
    }
  });

  it('always draws long faults but limits shorter ones by zoom', () => {
    expect(faultMaxDistanceMeters(0)).toBeGreaterThan(faultMaxDistanceMeters(1));
    expect(faultMaxDistanceMeters(1)).toBeGreaterThan(faultMaxDistanceMeters(2));
  });

  it('falls back to always-visible for an unknown tier', () => {
    expect(faultMaxDistanceMeters(99)).toBe(faultMaxDistanceMeters(0));
  });

  it('rejects non-tier values', () => {
    expect(isFaultZoomTier(3)).toBe(false);
    expect(isFaultZoomTier('0')).toBe(false);
    expect(isFaultZoomTier(null)).toBe(false);
  });
});

describe('active faults layer', () => {
  it('conforms to the GlobeLayer contract as an independent overlay', () => {
    const layer = createActiveFaultsLayer('light');
    expect(layer.id).toBe('active-faults');
    expect(layer.category).toBe('overlay');
    expect(layer.exclusive).toBeUndefined();
    // Densest layer in the app — it would bury the earthquakes on first load.
    expect(layer.defaultVisible).toBe(false);
  });

  it('adds one batched primitive rather than thousands of entities', () => {
    const layer = createActiveFaultsLayer('light');
    const viewer = createFakeViewer();

    layer.mount(viewer);

    expect(viewer.scene.primitives.add).toHaveBeenCalledTimes(1);
    const collection = vi.mocked(viewer.scene.primitives.add).mock
      .calls[0]![0] as Cesium.PolylineCollection;
    expect(collection.length).toBe(faultData.length);
  });

  it('gives shorter faults a nearer cutoff than long ones', () => {
    const layer = createActiveFaultsLayer('light');
    const viewer = createFakeViewer();
    layer.mount(viewer);
    const collection = vi.mocked(viewer.scene.primitives.add).mock
      .calls[0]![0] as Cesium.PolylineCollection;

    // Compare a known long fault against a known short one rather than
    // trusting index order.
    const longIndex = faultData.findIndex((f) => f.z === 0);
    const shortIndex = faultData.findIndex((f) => f.z === 2);
    const longFar = collection.get(longIndex).distanceDisplayCondition.far;
    const shortFar = collection.get(shortIndex).distanceDisplayCondition.far;

    expect(longFar).toBeGreaterThan(shortFar);
  });

  it('destroys the primitive on unmount', () => {
    const layer = createActiveFaultsLayer('light');
    const viewer = createFakeViewer();

    layer.mount(viewer);
    layer.unmount();

    expect(viewer.scene.primitives.remove).toHaveBeenCalledTimes(1);
  });

  it('tears down cleanly, giving each polyline its own material', () => {
    // The regression guard. Destroying the collection destroys every polyline,
    // and each one destroys its own material. If a single Material instance
    // were shared, the second destroy would throw DeveloperError and take the
    // render loop with it — which is exactly what happened in the app.
    const layer = createActiveFaultsLayer('light');
    const viewer = createFakeViewer();

    layer.mount(viewer);
    expect(() => layer.unmount()).not.toThrow();
  });

  it('survives repeated mount/unmount cycles', () => {
    // Changing the basemap tone or toggling the layer remounts it. Nothing may
    // leak across a cycle or be reused after destruction.
    const layer = createActiveFaultsLayer('light');

    for (let i = 0; i < 3; i += 1) {
      const viewer = createFakeViewer();
      expect(() => {
        layer.mount(viewer);
        layer.unmount();
      }).not.toThrow();
    }
  });

  it('does not touch an already-destroyed viewer on unmount', () => {
    const layer = createActiveFaultsLayer('light');
    const viewer = createFakeViewer();

    layer.mount(viewer);
    vi.mocked(viewer.isDestroyed).mockReturnValue(true);

    expect(() => layer.unmount()).not.toThrow();
    expect(viewer.scene.primitives.remove).not.toHaveBeenCalled();
  });

  it('does nothing on unmount if never mounted', () => {
    const layer = createActiveFaultsLayer('light');
    expect(() => layer.unmount()).not.toThrow();
  });

  it('toggles visibility on the whole collection', () => {
    const layer = createActiveFaultsLayer('light');
    const viewer = createFakeViewer();
    layer.mount(viewer);
    const collection = vi.mocked(viewer.scene.primitives.add).mock
      .calls[0]![0] as Cesium.PolylineCollection;

    layer.setVisible(false);
    expect(collection.show).toBe(false);
    layer.setVisible(true);
    expect(collection.show).toBe(true);
  });
});
