import { describe, expect, it, vi } from 'vitest';
import * as Cesium from 'cesium';
import type { EarthquakeEvent } from '@terra-pulse/schema';
import { ANTIPODAL_RINGS_KM } from '@terra-pulse/schema';
import { antipodeEntityId, createAntipodeLayer } from './antipode-layer';

function makeEvent(overrides: Partial<EarthquakeEvent> = {}): EarthquakeEvent {
  return {
    id: 'us0001',
    source: 'usgs',
    magnitude: 6.3,
    magnitudeType: 'mww',
    place: '10km SSW of Somewhere',
    timeUtc: '2026-08-04T12:00:00.000Z',
    updatedUtc: '2026-08-04T12:05:00.000Z',
    longitude: -112.14,
    latitude: 36.05,
    depthKm: 10,
    status: 'reviewed',
    tsunami: false,
    alertLevel: null,
    significance: 900,
    url: 'https://example.test',
    ...overrides,
  };
}

/**
 * Carries a real translucency object, because restoring it is the behaviour
 * most worth testing — leaking it leaves the entire globe see-through.
 */
function createFakeViewer(options?: { destroyed?: boolean; translucent?: boolean }) {
  const added: Cesium.CustomDataSource[] = [];
  const viewer = {
    isDestroyed: vi.fn(() => options?.destroyed ?? false),
    scene: {
      globe: {
        translucency: {
          enabled: options?.translucent ?? false,
          frontFaceAlpha: options?.translucent === true ? 0.5 : 1,
        },
      },
    },
    dataSources: {
      add: vi.fn((source: Cesium.CustomDataSource) => {
        added.push(source);
        return Promise.resolve(source);
      }),
      remove: vi.fn(() => true),
    },
  };
  return { viewer: viewer as unknown as Cesium.Viewer, raw: viewer, added };
}

describe('antipode layer', () => {
  it('conforms to the GlobeLayer contract as an analysis layer', () => {
    const layer = createAntipodeLayer(makeEvent());
    expect(layer.id).toBe('antipode');
    expect(layer.category).toBe('analysis');
  });

  it('draws a chord, an antipode marker and the distance rings', () => {
    const { viewer, added } = createFakeViewer();
    createAntipodeLayer(makeEvent()).mount(viewer);

    const entities = added[0]!.entities.values;
    // chord + endpoint marker + one ring per ANTIPODAL_RINGS_KM entry.
    expect(entities).toHaveLength(2 + ANTIPODAL_RINGS_KM.length);
    expect(added[0]!.entities.getById(antipodeEntityId('us0001'))).toBeDefined();
    for (const km of ANTIPODAL_RINGS_KM) {
      expect(
        added[0]!.entities.getById(`${antipodeEntityId('us0001')}::ring-${String(km)}`),
      ).toBeDefined();
    }
  });

  it('draws no hit markers when nothing was recorded near the antipode', () => {
    const { viewer, added } = createFakeViewer();
    createAntipodeLayer(makeEvent(), []).mount(viewer);

    const hits = added[0]!.entities.values.filter((e: { id?: string }) =>
      String(e.id ?? '').includes('::hit-'),
    );
    expect(hits).toHaveLength(0);
  });

  it('marks each recorded hit at its own epicentre', () => {
    // The marks go where the earthquakes were, not on the antipode itself —
    // the whole point is seeing how far off-centre they fell.
    const { viewer, added } = createFakeViewer();
    const hit = {
      event: { ...makeEvent(), id: 'target-1', latitude: -35, longitude: 113 },
      distanceKm: 197,
      delayHours: 4.6,
    };
    createAntipodeLayer(makeEvent(), [hit]).mount(viewer);

    const marker = added[0]!.entities.getById(`${antipodeEntityId('us0001')}::hit-target-1`);
    expect(marker).toBeDefined();
  });

  it('draws the chord straight through the planet, not around it', () => {
    // ArcType.NONE is load-bearing. The default GEODESIC drapes a polyline over
    // the surface, which would trace the long way *round* the Earth — the exact
    // opposite of what an antipode chord shows.
    const { viewer, added } = createFakeViewer();
    createAntipodeLayer(makeEvent()).mount(viewer);

    const chord = added[0]!.entities.getById(antipodeEntityId('us0001'));
    expect(chord?.polyline?.arcType?.getValue(Cesium.JulianDate.now())).toBe(Cesium.ArcType.NONE);
  });

  it('makes the globe translucent on mount', () => {
    const { viewer, raw } = createFakeViewer();

    createAntipodeLayer(makeEvent()).mount(viewer);

    expect(raw.scene.globe.translucency.enabled).toBe(true);
    expect(raw.scene.globe.translucency.frontFaceAlpha).toBeLessThan(1);
  });

  it('gives the globe back on unmount', () => {
    // The leak that matters. Globe translucency is scene-wide state this layer
    // borrows; failing to restore it leaves every later view see-through with
    // no visible cause.
    const { viewer, raw } = createFakeViewer();
    const layer = createAntipodeLayer(makeEvent());

    layer.mount(viewer);
    layer.unmount();

    expect(raw.scene.globe.translucency.enabled).toBe(false);
    expect(raw.scene.globe.translucency.frontFaceAlpha).toBe(1);
  });

  it('restores the previous values rather than hard-coding opaque', () => {
    // If something else ever turns translucency on, this layer leaving must not
    // clobber it.
    const { viewer, raw } = createFakeViewer({ translucent: true });
    const layer = createAntipodeLayer(makeEvent());

    layer.mount(viewer);
    layer.unmount();

    expect(raw.scene.globe.translucency.enabled).toBe(true);
    expect(raw.scene.globe.translucency.frontFaceAlpha).toBe(0.5);
  });

  it('removes its data source on unmount', () => {
    const { viewer, raw } = createFakeViewer();
    const layer = createAntipodeLayer(makeEvent());

    layer.mount(viewer);
    layer.unmount();

    expect(raw.dataSources.remove).toHaveBeenCalled();
  });

  it('does not touch a destroyed viewer', () => {
    // React effect cleanup order relative to the viewer's own teardown is not
    // guaranteed — this crashed for real before the guard existed.
    const { viewer, raw } = createFakeViewer({ destroyed: true });
    const layer = createAntipodeLayer(makeEvent());

    layer.mount(viewer);
    expect(() => {
      layer.unmount();
    }).not.toThrow();
    expect(raw.dataSources.remove).not.toHaveBeenCalled();
  });

  it('hides and shows with setVisible', () => {
    const { viewer, added } = createFakeViewer();
    const layer = createAntipodeLayer(makeEvent());
    layer.mount(viewer);

    layer.setVisible(false);
    expect(added[0]!.show).toBe(false);

    layer.setVisible(true);
    expect(added[0]!.show).toBe(true);
  });

  it('grows the chord over time and stops at the antipode', () => {
    // The far end is a CallbackProperty, so this reads it at two instants
    // rather than trusting the animation to have run.
    let clock = 0;
    const { viewer, added } = createFakeViewer();
    createAntipodeLayer(makeEvent(), [], () => clock).mount(viewer);

    const chord = added[0]!.entities.getById(antipodeEntityId('us0001'));
    const at = (t: number) => {
      clock = t;
      return chord?.polyline?.positions?.getValue(Cesium.JulianDate.now()) as Cesium.Cartesian3[];
    };

    const start = at(0);
    const middle = at(300);
    const finished = at(5_000);

    // Zero length at t=0: the line starts at the event and goes nowhere yet.
    expect(Cesium.Cartesian3.distance(start[0]!, start[1]!)).toBeCloseTo(0, 6);
    expect(Cesium.Cartesian3.distance(middle[0]!, middle[1]!)).toBeGreaterThan(0);

    // Ends at the true antipode: the far side of the globe from the event.
    const expected = Cesium.Cartesian3.fromDegrees(67.86, -36.05);
    expect(Cesium.Cartesian3.distance(finished[1]!, expected)).toBeLessThan(1);
  });

  it('holds the chord back for the camera when there is a flight to wait for', () => {
    let clock = 0;
    const { viewer, added } = createFakeViewer();
    createAntipodeLayer(makeEvent(), [], () => clock, { flyMs: 1_600 }).mount(viewer);

    const chord = added[0]!.entities.getById(antipodeEntityId('us0001'));
    const lengthAt = (t: number) => {
      clock = t;
      const [from, to] = chord?.polyline?.positions?.getValue(Cesium.JulianDate.now()) as Cesium.Cartesian3[];
      return Cesium.Cartesian3.distance(from!, to!);
    };

    // Still turning: a line drawn now would be drawn under a moving view.
    expect(lengthAt(1_500)).toBeCloseTo(0, 6);
    expect(lengthAt(2_000)).toBeGreaterThan(0);
  });

  it('spreads the rings out from the landing point, each stopping at its own radius', () => {
    let clock = 0;
    const { viewer, added } = createFakeViewer();
    createAntipodeLayer(makeEvent(), [], () => clock).mount(viewer);

    const antipode = Cesium.Cartesian3.fromDegrees(67.86, -36.05);
    const ring = added[0]!.entities.getById(`${antipodeEntityId('us0001')}::ring-1000`);
    /** How far the ring's outline is from the antipode, km — its radius as drawn. */
    const radiusAt = (t: number) => {
      clock = t;
      const points = ring?.polyline?.positions?.getValue(Cesium.JulianDate.now()) as Cesium.Cartesian3[];
      return points.length === 0 ? null : Cesium.Cartesian3.distance(points[0]!, antipode) / 1000;
    };

    // Nothing at the far end while the chord is still on its way.
    expect(radiusAt(600)).toBeNull();
    const early = radiusAt(1_400);
    const settled = radiusAt(60_000);
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(settled!);
    // A straight-line distance, so a little under the 1000 km of arc.
    expect(settled).toBeGreaterThan(985);
    expect(settled).toBeLessThanOrEqual(1000);
  });

  it('takes hits after it is built, without rebuilding anything', () => {
    // The lookup lands after the layer is up. Rebuilding for it restarts the
    // clock, which replays the chord — and now the camera move and the ripple.
    const { viewer, raw, added } = createFakeViewer();
    const layer = createAntipodeLayer(makeEvent());
    layer.mount(viewer);
    const chord = added[0]!.entities.getById(antipodeEntityId('us0001'));

    const hit = {
      event: { ...makeEvent(), id: 'target-1', latitude: -35, longitude: 113 },
      distanceKm: 197,
      delayHours: 4.6,
    };
    layer.setHits([hit]);

    expect(raw.dataSources.add).toHaveBeenCalledTimes(1);
    expect(added[0]!.entities.getById(antipodeEntityId('us0001'))).toBe(chord);
    expect(added[0]!.entities.getById(`${antipodeEntityId('us0001')}::hit-target-1`)).toBeDefined();
  });

  it('replaces the hits it was given rather than adding to them', () => {
    const { viewer, added } = createFakeViewer();
    const layer = createAntipodeLayer(makeEvent());
    layer.mount(viewer);
    const hit = (id: string) => ({
      event: { ...makeEvent(), id, latitude: -35, longitude: 113 },
      distanceKm: 197,
      delayHours: 4.6,
    });

    layer.setHits([hit('a'), hit('b')]);
    layer.setHits([hit('b')]);

    const ids = added[0]!.entities.values.map((entity) => entity.id).filter((id) => id.includes('::hit-'));
    expect(ids).toEqual([`${antipodeEntityId('us0001')}::hit-b`]);
  });

  it('shows a hit only once the ripple has reached it', () => {
    let clock = 0;
    const { viewer, added } = createFakeViewer();
    const hit = {
      event: { ...makeEvent(), id: 'target-1', latitude: -35, longitude: 113 },
      distanceKm: 600,
      delayHours: 4.6,
    };
    createAntipodeLayer(makeEvent(), [hit], () => clock).mount(viewer);

    const marker = added[0]!.entities.getById(`${antipodeEntityId('us0001')}::hit-target-1`);
    const shownAt = (t: number) => {
      clock = t;
      return marker?.point?.show?.getValue(Cesium.JulianDate.now()) as boolean;
    };

    expect(shownAt(1_000)).toBe(false); // chord still drawing
    expect(shownAt(1_350)).toBe(false); // front has left, not yet 600 km out
    expect(shownAt(60_000)).toBe(true);
  });
});
