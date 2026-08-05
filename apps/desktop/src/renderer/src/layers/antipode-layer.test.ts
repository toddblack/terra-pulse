import { describe, expect, it, vi } from 'vitest';
import * as Cesium from 'cesium';
import type { EarthquakeEvent } from '@terra-pulse/schema';
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
    const layer = createAntipodeLayer(makeEvent(), 'light');
    expect(layer.id).toBe('antipode');
    expect(layer.category).toBe('analysis');
  });

  it('draws a chord and an antipode marker', () => {
    const { viewer, added } = createFakeViewer();
    createAntipodeLayer(makeEvent(), 'light').mount(viewer);

    const entities = added[0]!.entities.values;
    expect(entities).toHaveLength(2);
    expect(added[0]!.entities.getById(antipodeEntityId('us0001'))).toBeDefined();
  });

  it('draws the chord straight through the planet, not around it', () => {
    // ArcType.NONE is load-bearing. The default GEODESIC drapes a polyline over
    // the surface, which would trace the long way *round* the Earth — the exact
    // opposite of what an antipode chord shows.
    const { viewer, added } = createFakeViewer();
    createAntipodeLayer(makeEvent(), 'light').mount(viewer);

    const chord = added[0]!.entities.getById(antipodeEntityId('us0001'));
    expect(chord?.polyline?.arcType?.getValue(Cesium.JulianDate.now())).toBe(Cesium.ArcType.NONE);
  });

  it('makes the globe translucent on mount', () => {
    const { viewer, raw } = createFakeViewer();

    createAntipodeLayer(makeEvent(), 'light').mount(viewer);

    expect(raw.scene.globe.translucency.enabled).toBe(true);
    expect(raw.scene.globe.translucency.frontFaceAlpha).toBeLessThan(1);
  });

  it('gives the globe back on unmount', () => {
    // The leak that matters. Globe translucency is scene-wide state this layer
    // borrows; failing to restore it leaves every later view see-through with
    // no visible cause.
    const { viewer, raw } = createFakeViewer();
    const layer = createAntipodeLayer(makeEvent(), 'light');

    layer.mount(viewer);
    layer.unmount();

    expect(raw.scene.globe.translucency.enabled).toBe(false);
    expect(raw.scene.globe.translucency.frontFaceAlpha).toBe(1);
  });

  it('restores the previous values rather than hard-coding opaque', () => {
    // If something else ever turns translucency on, this layer leaving must not
    // clobber it.
    const { viewer, raw } = createFakeViewer({ translucent: true });
    const layer = createAntipodeLayer(makeEvent(), 'light');

    layer.mount(viewer);
    layer.unmount();

    expect(raw.scene.globe.translucency.enabled).toBe(true);
    expect(raw.scene.globe.translucency.frontFaceAlpha).toBe(0.5);
  });

  it('removes its data source on unmount', () => {
    const { viewer, raw } = createFakeViewer();
    const layer = createAntipodeLayer(makeEvent(), 'light');

    layer.mount(viewer);
    layer.unmount();

    expect(raw.dataSources.remove).toHaveBeenCalled();
  });

  it('does not touch a destroyed viewer', () => {
    // React effect cleanup order relative to the viewer's own teardown is not
    // guaranteed — this crashed for real before the guard existed.
    const { viewer, raw } = createFakeViewer({ destroyed: true });
    const layer = createAntipodeLayer(makeEvent(), 'light');

    layer.mount(viewer);
    expect(() => {
      layer.unmount();
    }).not.toThrow();
    expect(raw.dataSources.remove).not.toHaveBeenCalled();
  });

  it('hides and shows with setVisible', () => {
    const { viewer, added } = createFakeViewer();
    const layer = createAntipodeLayer(makeEvent(), 'light');
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
    createAntipodeLayer(makeEvent(), 'light', () => clock).mount(viewer);

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
});
