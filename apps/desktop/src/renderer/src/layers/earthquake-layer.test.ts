import { describe, expect, it, vi } from 'vitest';
import type * as Cesium from 'cesium';
import type { EarthquakeEvent } from '@terra-pulse/schema';
import { createEarthquakeLayer, eventIdFromEntityId, ringEntityId } from './earthquake-layer';

function makeEvent(overrides: Partial<EarthquakeEvent> = {}): EarthquakeEvent {
  return {
    id: 'us0001',
    source: 'usgs',
    magnitude: 5.2,
    magnitudeType: 'mb',
    place: '10km SSW of Somewhere',
    timeUtc: '2026-07-20T12:00:00.000Z',
    updatedUtc: '2026-07-20T12:05:00.000Z',
    longitude: -112.14,
    latitude: 36.05,
    depthKm: 10,
    status: 'reviewed',
    tsunami: false,
    alertLevel: null,
    significance: 400,
    url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us0001',
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

describe('earthquake layer', () => {
  it('conforms to the GlobeLayer contract as an events layer', () => {
    const layer = createEarthquakeLayer([], 'light');
    expect(layer.id).toBe('earthquakes');
    expect(layer.category).toBe('events');
    expect(layer.defaultVisible).toBe(true);
  });

  it('adds one data source holding one entity per event', () => {
    const layer = createEarthquakeLayer([makeEvent({ id: 'a' }), makeEvent({ id: 'b' })], 'light');
    const viewer = createFakeViewer();

    layer.mount(viewer);

    expect(viewer.dataSources.add).toHaveBeenCalledOnce();
    const added = vi.mocked(viewer.dataSources.add).mock.calls[0]![0] as Cesium.CustomDataSource;
    expect(added.entities.values).toHaveLength(2);
    expect(added.entities.getById('a')).toBeDefined();
    expect(added.entities.getById('b')).toBeDefined();
  });

  it('removes and destroys the data source on unmount', () => {
    const layer = createEarthquakeLayer([makeEvent()], 'light');
    const viewer = createFakeViewer();

    layer.mount(viewer);
    layer.unmount();

    // The `true` is what destroys the entities — non-negotiable #5.
    expect(viewer.dataSources.remove).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('does not touch an already-destroyed viewer on unmount', () => {
    const layer = createEarthquakeLayer([makeEvent()], 'light');
    const viewer = createFakeViewer();

    layer.mount(viewer);
    vi.mocked(viewer.isDestroyed).mockReturnValue(true);

    expect(() => layer.unmount()).not.toThrow();
    expect(viewer.dataSources.remove).not.toHaveBeenCalled();
  });

  it('detaches the data source if it unmounts before the async add resolves', async () => {
    const layer = createEarthquakeLayer([makeEvent()], 'light');
    const viewer = createFakeViewer();

    layer.mount(viewer);
    layer.unmount(); // before the add() promise settles
    await Promise.resolve();
    await Promise.resolve();

    // unmount() itself couldn't remove it (add hadn't attached it yet), so the
    // add continuation must clean up instead — otherwise it leaks.
    expect(viewer.dataSources.remove).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('does nothing on unmount if never mounted', () => {
    const layer = createEarthquakeLayer([makeEvent()], 'light');
    expect(() => layer.unmount()).not.toThrow();
  });

  it('hides events outside the time window and shows those inside it', () => {
    const layer = createEarthquakeLayer(
      [
        makeEvent({ id: 'inside', timeUtc: '2026-07-20T12:00:00.000Z' }),
        makeEvent({ id: 'outside', timeUtc: '2026-07-01T00:00:00.000Z' }),
      ],
      'light',
    );
    const viewer = createFakeViewer();
    layer.mount(viewer);
    const added = vi.mocked(viewer.dataSources.add).mock.calls[0]![0] as Cesium.CustomDataSource;

    layer.setTimeWindow(new Date('2026-07-19T00:00:00Z'), new Date('2026-07-21T00:00:00Z'));

    expect(added.entities.getById('inside')?.show).toBe(true);
    expect(added.entities.getById('outside')?.show).toBe(false);
  });

  it('adds an emphasis ring only for events at or above the threshold', () => {
    const layer = createEarthquakeLayer(
      [
        makeEvent({ id: 'small', magnitude: 4.2 }),
        makeEvent({ id: 'big', magnitude: 6.1 }),
      ],
      'light',
    );
    const viewer = createFakeViewer();
    layer.mount(viewer);
    const added = vi.mocked(viewer.dataSources.add).mock.calls[0]![0] as Cesium.CustomDataSource;

    expect(added.entities.getById(ringEntityId('big'))).toBeDefined();
    expect(added.entities.getById(ringEntityId('small'))).toBeUndefined();
    // two dots + one ring
    expect(added.entities.values).toHaveLength(3);
  });

  it('hides a large event’s ring along with its dot when filtered out', () => {
    const layer = createEarthquakeLayer(
      [makeEvent({ id: 'big', magnitude: 6.1, timeUtc: '2026-07-01T00:00:00.000Z' })],
      'light',
    );
    const viewer = createFakeViewer();
    layer.mount(viewer);
    const added = vi.mocked(viewer.dataSources.add).mock.calls[0]![0] as Cesium.CustomDataSource;

    layer.setTimeWindow(new Date('2026-07-19T00:00:00Z'), new Date('2026-07-21T00:00:00Z'));

    // An orphaned ring with no dot inside it would be a visible artefact.
    expect(added.entities.getById('big')?.show).toBe(false);
    expect(added.entities.getById(ringEntityId('big'))?.show).toBe(false);
  });

  it('resolves a ring entity id back to its event id', () => {
    expect(eventIdFromEntityId(ringEntityId('us7000t37a'))).toBe('us7000t37a');
    expect(eventIdFromEntityId('us7000t37a')).toBe('us7000t37a');
  });

  it('toggles the whole data source with setVisible', () => {
    const layer = createEarthquakeLayer([makeEvent()], 'light');
    const viewer = createFakeViewer();
    layer.mount(viewer);
    const added = vi.mocked(viewer.dataSources.add).mock.calls[0]![0] as Cesium.CustomDataSource;

    layer.setVisible(false);
    expect(added.show).toBe(false);

    layer.setVisible(true);
    expect(added.show).toBe(true);
  });
});
