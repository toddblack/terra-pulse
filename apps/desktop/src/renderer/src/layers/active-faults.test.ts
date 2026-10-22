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
import { ACTIVE_FAULTS } from './fault-data';

interface FakeViewer {
  viewer: Cesium.Viewer;
  /** Moves the fake camera and runs the layer's per-frame check, as a render would. */
  setHeight: (metres: number) => void;
  removePreRender: ReturnType<typeof vi.fn>;
}

function createFakeViewer(options?: { destroyed?: boolean; heightM?: number }): FakeViewer {
  const camera = { positionCartographic: { height: options?.heightM ?? 20_000_000 } };
  const listeners: (() => void)[] = [];
  const removePreRender = vi.fn();
  const viewer = {
    isDestroyed: vi.fn(() => options?.destroyed ?? false),
    camera,
    scene: {
      preRender: {
        addEventListener: vi.fn((fn: () => void) => {
          listeners.push(fn);
          return removePreRender;
        }),
      },
      primitives: {
        add: vi.fn((p: unknown) => p),
        // Really destroys, because `PrimitiveCollection.remove` really does
        // (destroyPrimitives defaults true): teardown has to be exercised, not
        // merely recorded. A mock that only recorded the call once let a crash
        // ship, when this layer shared one Material across 13,696 polylines.
        remove: vi.fn((p: Cesium.Primitive) => {
          p.destroy();
          return true;
        }),
      },
    },
  } as unknown as Cesium.Viewer;
  return {
    viewer,
    removePreRender,
    setHeight(metres) {
      camera.positionCartographic.height = metres;
      for (const fn of listeners) fn();
    },
  };
}

function addedPrimitives(viewer: Cesium.Viewer): Cesium.Primitive[] {
  return vi.mocked(viewer.scene.primitives.add).mock.calls.map((call) => call[0] as Cesium.Primitive);
}

describe('vendored fault data', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(ACTIVE_FAULTS)).toBe(true);
    expect(ACTIVE_FAULTS.length).toBeGreaterThan(0);
  });

  it('gives every fault at least two points, as a polyline requires', () => {
    for (const fault of ACTIVE_FAULTS) {
      expect(fault.p.length).toBeGreaterThanOrEqual(4); // 2 points x lon,lat
      expect(fault.p.length % 2).toBe(0);
    }
  });

  it('keeps every coordinate in valid geographic range', () => {
    for (const fault of ACTIVE_FAULTS) {
      for (let i = 0; i < fault.p.length; i += 2) {
        expect(Math.abs(fault.p[i]!)).toBeLessThanOrEqual(180);
        expect(Math.abs(fault.p[i + 1]!)).toBeLessThanOrEqual(90);
      }
    }
  });

  it('tags every fault with a recognised zoom tier', () => {
    for (const fault of ACTIVE_FAULTS) {
      expect(isFaultZoomTier(fault.z)).toBe(true);
    }
  });

  it('uses all three tiers, so zoom filtering actually does something', () => {
    const tiers = new Set(ACTIVE_FAULTS.map((f) => f.z));
    expect(tiers.size).toBe(3);
  });

  it('keeps every chord short enough not to sag below the globe', () => {
    // The layer draws straight chords (ArcType.NONE), so the vendor script
    // pre-densifies to a 50 km cap. A regression there would put long faults
    // underground at grazing view angles — invisible in a unit test otherwise.
    const MAX_CHORD_KM = 50;
    const R = 6371;
    const toRad = Math.PI / 180;
    let longest = 0;

    for (const fault of ACTIVE_FAULTS) {
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

  it('adds one static primitive per zoom tier, covering every fault', () => {
    const layer = createActiveFaultsLayer('light');
    const { viewer } = createFakeViewer();

    layer.mount(viewer);

    const primitives = addedPrimitives(viewer);
    expect(primitives).toHaveLength(3);
    const instances = primitives.reduce(
      (sum, p) => sum + (p.geometryInstances as Cesium.GeometryInstance[]).length,
      0,
    );
    expect(instances).toBe(ACTIVE_FAULTS.length);
  });

  it('carries each fault record as its instance id, so a pick can name it', () => {
    const layer = createActiveFaultsLayer('light');
    const { viewer } = createFakeViewer();
    layer.mount(viewer);

    const ids = new Set(
      addedPrimitives(viewer).flatMap((p) =>
        (p.geometryInstances as Cesium.GeometryInstance[]).map((i) => i.id as unknown),
      ),
    );
    expect(ids.has(ACTIVE_FAULTS[0])).toBe(true);
    expect(ids.size).toBe(ACTIVE_FAULTS.length);
  });

  it('shows only the tiers whose cutoff the camera is inside', () => {
    const layer = createActiveFaultsLayer('light');
    const fake = createFakeViewer();
    layer.mount(fake.viewer);
    const [long, medium, short] = addedPrimitives(fake.viewer);

    fake.setHeight(20_000_000); // whole globe: long faults only
    expect([long!.show, medium!.show, short!.show]).toEqual([true, false, false]);

    fake.setHeight(5_000_000); // continental
    expect([long!.show, medium!.show, short!.show]).toEqual([true, true, false]);

    fake.setHeight(1_000_000); // regional: everything
    expect([long!.show, medium!.show, short!.show]).toEqual([true, true, true]);
  });

  it('uses the same cutoffs as the encoding, nearest for the shortest faults', () => {
    expect(faultMaxDistanceMeters(1)).toBe(8_000_000);
    expect(faultMaxDistanceMeters(2)).toBe(2_000_000);
    const fake = createFakeViewer({ heightM: 2_000_001 });
    const layer = createActiveFaultsLayer('light');
    layer.mount(fake.viewer);
    const short = addedPrimitives(fake.viewer)[2]!;
    expect(short.show).toBe(false);
    fake.setHeight(2_000_000);
    expect(short.show).toBe(true);
  });

  it('removes every primitive and its frame listener on unmount', () => {
    const layer = createActiveFaultsLayer('light');
    const fake = createFakeViewer();

    layer.mount(fake.viewer);
    layer.unmount();

    expect(fake.viewer.scene.primitives.remove).toHaveBeenCalledTimes(3);
    expect(fake.removePreRender).toHaveBeenCalledTimes(1);
  });

  it('survives repeated mount/unmount cycles', () => {
    const layer = createActiveFaultsLayer('light');
    for (let i = 0; i < 3; i += 1) {
      const { viewer } = createFakeViewer();
      expect(() => {
        layer.mount(viewer);
        layer.unmount();
      }).not.toThrow();
    }
  });

  it('does not touch an already-destroyed viewer on unmount', () => {
    const layer = createActiveFaultsLayer('light');
    const { viewer } = createFakeViewer();

    layer.mount(viewer);
    vi.mocked(viewer.isDestroyed).mockReturnValue(true);

    expect(() => layer.unmount()).not.toThrow();
    expect(viewer.scene.primitives.remove).not.toHaveBeenCalled();
  });

  it('does nothing on unmount if never mounted', () => {
    const layer = createActiveFaultsLayer('light');
    expect(() => layer.unmount()).not.toThrow();
  });

  it('hides every tier when switched off, whatever the zoom', () => {
    const layer = createActiveFaultsLayer('light');
    const fake = createFakeViewer({ heightM: 1_000_000 });
    layer.mount(fake.viewer);
    const primitives = addedPrimitives(fake.viewer);

    layer.setVisible(false);
    expect(primitives.map((p) => p.show)).toEqual([false, false, false]);
    fake.setHeight(500_000); // a camera move must not bring them back
    expect(primitives.map((p) => p.show)).toEqual([false, false, false]);
    layer.setVisible(true);
    expect(primitives.map((p) => p.show)).toEqual([true, true, true]);
  });
});
