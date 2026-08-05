/**
 * Keeping Cesium's selection reticle pointed at the store's selected event.
 *
 * ## The bug this exists to fix
 *
 * `viewer.dataSources.add()` is **asynchronous** — the source is not in
 * `viewer.dataSources` when `add()` returns. That is fine on its own, but it
 * collides with how the earthquake layer is rebuilt when the catalogue changes:
 *
 * 1. A poll or a manual Refresh brings in new events.
 * 2. The event-driven layer effect tears down, removing the old data source
 *    **synchronously**.
 * 3. The layer remounts, building entities into a still-detached data source and
 *    starting an async `add()`.
 * 4. The selection effect runs later in the same commit, scans
 *    `viewer.dataSources`, and finds nothing — the old source is gone and the
 *    new one has not attached yet. It clears `selectedEntity`.
 * 5. A microtask later the source attaches. Nothing re-runs the selection.
 *
 * The result is a selected event with no reticle, while the inspector stays open
 * because the *store* still holds `selectedEventId` — which is correct, and is
 * why the two disagreed. The selection was never lost; only Cesium's view of it
 * was.
 *
 * So resolution cannot be a one-shot on commit. It has to re-run whenever a data
 * source attaches, which is what `watchSelection` does.
 */
import type * as Cesium from 'cesium';

/**
 * The slice of a viewer this module touches.
 *
 * Narrow on purpose: it makes the logic testable against a plain object, which
 * matters because the real failure is about *timing* and a real Cesium viewer
 * needs a WebGL context to exist at all.
 */
export interface SelectionTarget {
  dataSources: {
    length: number;
    get(index: number): { entities: { getById(id: string): Cesium.Entity | undefined } };
  };
  selectedEntity: Cesium.Entity | undefined;
}

/**
 * Points the viewer at the entity for `selectedEventId`, if it is mounted.
 *
 * Returns whether it found one. Entities live inside each layer's own data
 * source rather than `viewer.entities`, so this searches the mounted sources.
 *
 * Clears the selection when nothing matches, and that is deliberate even though
 * the miss may be temporary: leaving the previous value would keep Cesium
 * holding an entity that the rebuild has already destroyed. The gap is closed by
 * re-running on attach, not by holding a stale reference across it.
 */
export function applySelection(target: SelectionTarget, selectedEventId: string | null): boolean {
  if (selectedEventId === null) {
    target.selectedEntity = undefined;
    return false;
  }

  for (let index = 0; index < target.dataSources.length; index += 1) {
    const entity = target.dataSources.get(index).entities.getById(selectedEventId);
    if (entity) {
      target.selectedEntity = entity;
      return true;
    }
  }

  // Selected but not mounted: the filters excluded it, or a rebuild is still in
  // flight. Either way, do not keep pointing at whatever was here before.
  target.selectedEntity = undefined;
  return false;
}

/** The `dataSourceAdded` event, as much of it as this module needs. */
export interface DataSourceAddedEvent {
  addEventListener(listener: () => void): void;
  removeEventListener(listener: () => void): void;
}

/**
 * Applies the selection now, and again every time a data source attaches.
 *
 * Returns an unsubscribe function.
 *
 * The re-application is the actual fix: an immediate call alone loses the
 * reticle on every catalogue refresh, because the rebuilt layer's data source
 * attaches a microtask *after* the effect runs. Listening covers the general
 * case rather than that one race — a basemap switch, a layer toggle, and any
 * future async layer all attach sources on their own schedule.
 */
export function watchSelection(
  target: SelectionTarget,
  dataSourceAdded: DataSourceAddedEvent,
  selectedEventId: string | null,
): () => void {
  applySelection(target, selectedEventId);

  const onDataSourceAdded = () => {
    applySelection(target, selectedEventId);
  };
  dataSourceAdded.addEventListener(onDataSourceAdded);

  return () => {
    dataSourceAdded.removeEventListener(onDataSourceAdded);
  };
}
