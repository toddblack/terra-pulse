import { describe, expect, it } from 'vitest';
import type * as Cesium from 'cesium';
import {
  applySelection,
  watchSelection,
  type DataSourceAddedEvent,
  type SelectionTarget,
} from './selection-sync';

const entity = (id: string) => ({ id }) as unknown as Cesium.Entity;

/**
 * A viewer's data-source collection, with the one behaviour that matters:
 * `add` attaches **asynchronously**, exactly as Cesium's does.
 */
function createFakeViewer() {
  const sources: { entities: { getById(id: string): Cesium.Entity | undefined } }[] = [];
  const listeners = new Set<() => void>();

  const dataSourceAdded: DataSourceAddedEvent = {
    addEventListener: (listener) => listeners.add(listener),
    removeEventListener: (listener) => listeners.delete(listener),
  };

  const target: SelectionTarget = {
    dataSources: {
      get length() {
        return sources.length;
      },
      get: (index) => sources[index] as (typeof sources)[number],
    },
    selectedEntity: undefined,
  };

  return {
    target,
    dataSourceAdded,
    listenerCount: () => listeners.size,
    /** Attaches a source holding these ids, and fires the event Cesium fires. */
    attach(ids: string[]) {
      const entities = new Map(ids.map((id) => [id, entity(id)]));
      sources.push({ entities: { getById: (id) => entities.get(id) } });
      for (const listener of [...listeners]) listener();
    },
    /** Synchronous removal, as the layer's `unmount` does it. */
    detachAll() {
      sources.length = 0;
    },
  };
}

describe('applySelection', () => {
  it('points the viewer at the matching entity', () => {
    const viewer = createFakeViewer();
    viewer.attach(['a', 'b']);

    expect(applySelection(viewer.target, 'b')).toBe(true);
    expect(viewer.target.selectedEntity?.id).toBe('b');
  });

  it('searches across every mounted data source', () => {
    const viewer = createFakeViewer();
    viewer.attach(['a']);
    viewer.attach(['b']);

    expect(applySelection(viewer.target, 'b')).toBe(true);
    expect(viewer.target.selectedEntity?.id).toBe('b');
  });

  it('clears the selection when nothing is selected', () => {
    const viewer = createFakeViewer();
    viewer.attach(['a']);
    applySelection(viewer.target, 'a');

    expect(applySelection(viewer.target, null)).toBe(false);
    expect(viewer.target.selectedEntity).toBeUndefined();
  });

  it('clears rather than keeping a stale entity when the id is not mounted', () => {
    // Holding the previous value would leave Cesium pointing at an entity a
    // rebuild has already destroyed.
    const viewer = createFakeViewer();
    viewer.attach(['a']);
    applySelection(viewer.target, 'a');

    expect(applySelection(viewer.target, 'gone')).toBe(false);
    expect(viewer.target.selectedEntity).toBeUndefined();
  });
});

describe('watchSelection', () => {
  it('applies immediately when the entity is already mounted', () => {
    const viewer = createFakeViewer();
    viewer.attach(['a']);

    watchSelection(viewer.target, viewer.dataSourceAdded, 'a');
    expect(viewer.target.selectedEntity?.id).toBe('a');
  });

  /**
   * The reported bug, as a test.
   *
   * On a poll or a manual Refresh the earthquake layer is rebuilt: the old data
   * source is removed synchronously, and the replacement attaches a microtask
   * later because `dataSources.add()` is async. The selection effect runs in
   * between and finds nothing.
   *
   * Before the fix the reticle stayed gone while the inspector stayed open,
   * because the store still held the selection.
   */
  it('restores the reticle when the rebuilt layer attaches', () => {
    const viewer = createFakeViewer();
    viewer.attach(['quake-1']);

    const stop = watchSelection(viewer.target, viewer.dataSourceAdded, 'quake-1');
    expect(viewer.target.selectedEntity?.id).toBe('quake-1');

    // A refresh lands: old source gone, new one not attached yet.
    viewer.detachAll();
    applySelection(viewer.target, 'quake-1');
    expect(viewer.target.selectedEntity).toBeUndefined();

    // The rebuilt source attaches.
    viewer.attach(['quake-1', 'quake-2']);
    expect(viewer.target.selectedEntity?.id).toBe('quake-1');

    stop();
  });

  it('leaves the reticle clear when the refreshed catalogue drops the event', () => {
    // A revision or a prune can remove the selected event. Reattaching without
    // it must not resurrect a selection that no longer exists.
    const viewer = createFakeViewer();
    viewer.attach(['quake-1']);
    const stop = watchSelection(viewer.target, viewer.dataSourceAdded, 'quake-1');

    viewer.detachAll();
    viewer.attach(['quake-2', 'quake-3']);

    expect(viewer.target.selectedEntity).toBeUndefined();
    stop();
  });

  it('keeps working across several refreshes, not just the first', () => {
    const viewer = createFakeViewer();
    const stop = watchSelection(viewer.target, viewer.dataSourceAdded, 'quake-1');

    for (let poll = 0; poll < 3; poll += 1) {
      viewer.detachAll();
      viewer.attach(['quake-1']);
      expect(viewer.target.selectedEntity?.id).toBe('quake-1');
    }

    stop();
  });

  it('unsubscribes on teardown so a stale effect cannot fight the live one', () => {
    const viewer = createFakeViewer();
    const stop = watchSelection(viewer.target, viewer.dataSourceAdded, 'quake-1');
    expect(viewer.listenerCount()).toBe(1);

    stop();
    expect(viewer.listenerCount()).toBe(0);

    // A later attach must not touch the selection through the dead listener.
    viewer.attach(['quake-1']);
    expect(viewer.target.selectedEntity).toBeUndefined();
  });

  it('does not select anything when nothing is selected', () => {
    const viewer = createFakeViewer();
    const stop = watchSelection(viewer.target, viewer.dataSourceAdded, null);

    viewer.attach(['quake-1']);
    expect(viewer.target.selectedEntity).toBeUndefined();
    stop();
  });
});
