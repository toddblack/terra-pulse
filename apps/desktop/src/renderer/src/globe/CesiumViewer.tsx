import { useEffect, useMemo, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { useGlobeStore, type SolarEventSelection } from '../state/useGlobeStore';
import { useEarthquakeStore } from '../state/useEarthquakeStore';
import { eventIdFromEntityId } from '../layers/earthquake-layer';
import { focusAltitudeM } from './camera-focus';
import {
  cursorForHover,
  describeBoundary,
  describeCmeArrival,
  describeEarthquake,
  describeFault,
  describeFlare,
  describeMagnetometer,
  type HoverTarget,
} from './hover-target';
import type {
  AntipodalEvent,
  CmeArrival,
  EarthquakeEvent,
  MagnetometerReading,
  SolarFlare,
} from '@terra-pulse/schema';
import type { FaultRecord } from '../layers/fault-association';
import { stationCodeFromEntityId } from '../layers/magnetometer-layer';
import { flareIdFromEntityId } from '../layers/solar-flares-layer';
import { cmeSimulationIdFromEntityId } from '../layers/cme-arrivals-layer';
import { createLocationHighlight } from '../layers/location-highlight';
import { watchSelection } from './selection-sync';
import { useGlobeLayers } from './useGlobeLayers';
import { displayWindow, instantOnScreen, LIVE_END_MARGIN_MS } from './display-window';
import { useNow } from './useNow';
import { useSolarWindAt } from '../panels/useSpaceWeather';
import { useSolarEvents } from '../panels/useSolarEvents';
import { usePlayback } from './usePlayback';
import { useVisibleEarthquakes } from './useVisibleEarthquakes';
import { useAntipodal } from '../panels/useAntipodal';
import styles from './CesiumViewer.module.css';

/**
 * How far the pointer must travel with the button held before it counts as a
 * drag rather than a slightly shaky click.
 */
const DRAG_THRESHOLD_PX = 5;

/**
 * Stable empty array for "no hits yet".
 *
 * A fresh `[]` each render is a new identity, which would re-run the layer
 * effect — and therefore rebuild the chord and restart its animation — on every
 * single render while the lookup is in flight.
 */
const EMPTY_HITS: readonly AntipodalEvent[] = [];

export function CesiumViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  // The viewer lives in a ref (it must not trigger re-renders), so this is
  // what tells dependent effects that it now exists.
  const [viewerReadyToken, setViewerReadyToken] = useState(0);

  const activeBasemapId = useGlobeStore((state) => state.activeBasemapId);
  const layerVisibility = useGlobeStore((state) => state.layerVisibility);

  // The filtered projection, not the canonical set — the layer, the camera
  // and the selection all operate on what's actually on screen.
  const events = useVisibleEarthquakes();
  const windowHours = useEarthquakeStore((state) => state.windowHours);
  const playheadMs = useEarthquakeStore((state) => state.playheadMs);

  /**
   * The window the layers should display.
   *
   * Shared with the event list and the legend's count via `displayWindow`, so
   * what the globe draws and what the panels claim cannot disagree. This is the
   * **cheap channel**: it reaches the layers through `setTimeWindow`, which
   * flips visibility flags rather than rebuilding entities — which is why it can
   * afford to follow the clock and the built event set cannot.
   */
  const nowMs = useNow();
  const trailingWindow = useEarthquakeStore((state) => state.trailingWindow);
  const timeWindow = useMemo(
    () => displayWindow(windowHours, playheadMs, trailingWindow, nowMs, LIVE_END_MARGIN_MS),
    [windowHours, playheadMs, nowMs, trailingWindow],
  );
  const select = useEarthquakeStore((state) => state.select);
  const selectedEventId = useEarthquakeStore((state) => state.selectedEventId);
  const focusRequest = useEarthquakeStore((state) => state.focusRequest);
  const antipodeEventId = useEarthquakeStore((state) => state.antipodeEventId);
  const hideAntipode = useEarthquakeStore((state) => state.hideAntipode);
  const faultProbeActive = useGlobeStore((state) => state.faultProbeActive);
  const selectLocation = useGlobeStore((state) => state.selectLocation);
  const selectSolarEvent = useGlobeStore((state) => state.selectSolarEvent);
  const setHover = useGlobeStore((state) => state.setHover);
  const location = useGlobeStore((state) => state.location);
  const fieldQuantity = useGlobeStore((state) => state.fieldQuantity);
  const auroraGrid = useGlobeStore((state) => state.auroraGrid);
  const magnetometerReadings = useGlobeStore((state) => state.magnetometerReadings);
  const tecGrid = useGlobeStore((state) => state.tecGrid);
  const tecQuantity = useGlobeStore((state) => state.tecQuantity);
  // The magnetopause is an instantaneous state, so it reads the leading edge
  // rather than the window — **clamped to now**, because `timeWindow.endMs`
  // sits an hour in the future in live mode (`LIVE_END_MARGIN_MS`). Passing it
  // raw asked for a solar-wind hour that has not happened, so the boundary
  // never drew in live mode at all. See `instantOnScreen`.
  const solarWind = useSolarWindAt(instantOnScreen(timeWindow.endMs, nowMs));
  // Flares and CME arrivals: loaded against the whole selected span
  // (`windowHours`), not the live `timeWindow` — same split as the earthquake
  // layer's `loadedWindowStartMs` versus `setTimeWindow`. The live edge still
  // reaches these two layers, through `setTimeWindow` below, which only flips
  // a `show` flag; see `useSolarEvents`'s own doc for why a version keyed on
  // `timeWindow` directly was a real, measured problem, not just a risk.
  const { flares: solarFlares, cmeArrivals } = useSolarEvents(windowHours);

  // Resolved from the loaded set rather than held in the store, so the chord
  // follows revisions to the event like every other view does.
  const antipodeEvent = useMemo(
    () => events.find((candidate) => candidate.id === antipodeEventId) ?? null,
    [events, antipodeEventId],
  );

  /**
   * What was recorded near the antipode, for the rings and hit markers.
   *
   * Keyed on the *antipode* event rather than the selection: they are usually
   * the same event, but the chord can outlive a selection change and the marks
   * must describe the chord that is actually drawn.
   */
  const antipodalState = useAntipodal(antipodeEvent);
  const antipodeHits =
    antipodalState.status === 'ready' ? antipodalState.window.events : EMPTY_HITS;

  /** Read by the drag handler without making it depend on the mode. */
  const antipodeActiveRef = useRef(antipodeEventId !== null);
  useEffect(() => {
    antipodeActiveRef.current = antipodeEventId !== null;
  }, [antipodeEventId]);

  /**
   * Same treatment for the fault probe.
   *
   * Through a ref rather than a dependency so toggling the mode doesn't tear
   * down and rebuild the whole `ScreenSpaceEventHandler` — which would drop the
   * in-flight drag state along with it.
   */
  const faultProbeActiveRef = useRef(faultProbeActive);
  useEffect(() => {
    faultProbeActiveRef.current = faultProbeActive;
  }, [faultProbeActive]);

  // Escape leaves the antipode view. The mode covers the globe in translucency
  // and a chord, so it needs an exit that doesn't depend on finding a button.
  useEffect(() => {
    if (antipodeEventId === null) return;

    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') hideAntipode();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [antipodeEventId, hideAntipode]);

  // Viewer lifecycle: created once on mount, destroyed once on unmount.
  useEffect(() => {
    if (!containerRef.current) return;

    const viewer = new Cesium.Viewer(containerRef.current, {
      baseLayer: false, // basemaps are mounted by the layer registry
      animation: false,
      timeline: false,
      baseLayerPicker: false, // replaced by our own LayerPanel
      // The last default widget still on, and it sat under the event list.
      // Every other Cesium control here is already replaced by our own chrome,
      // so this was the odd one out visually as well as in the way.
      //
      // Worth knowing what goes with it: it was the only "reset the camera"
      // affordance, and preserving zoom across selections made staying zoomed
      // in stickier than it used to be. If getting back to a global view by
      // hand becomes annoying, the answer is a reset control in our own UI
      // where we choose the position — not this one back.
      homeButton: false,
      geocoder: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false, // replaced by our own EarthquakeInspector panel
    });
    viewerRef.current = viewer;
    setViewerReadyToken((token) => token + 1);

    return () => {
      // Non-negotiable #5: Cesium objects are not reclaimed by GC —
      // the viewer must be destroyed explicitly.
      viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  // All layer mounting/unmounting lives in the registry-driven hook.
  useGlobeLayers({
    viewerRef,
    activeBasemapId,
    layerVisibility,
    events,
    fieldQuantity,
    auroraGrid,
    magnetometerReadings,
    tecGrid,
    tecQuantity,
    solarFlares,
    cmeArrivals,
    solarWind,
    antipodeEvent,
    antipodeHits,
    timeWindow,
    viewerReadyToken,
  });

  // Drives the playhead forward while playback is running.
  usePlayback();

  /**
   * The current event set, read through a ref by the effects that must not
   * re-run when it changes.
   *
   * Two readers, both for the same reason:
   *
   * - The **focus** effect looks up coordinates but must fire only on a new
   *   `focusRequest`. With `events` as a dependency, adjusting a filter re-ran
   *   it while an older request was still in the store, and the globe flew back
   *   to a previously selected quake instead of staying put.
   * - The **pick** resolver turns an entity id into an event. Depending on
   *   `events` there would rebuild the whole `ScreenSpaceEventHandler` on every
   *   poll, discarding in-flight drag state.
   *
   * Declared before both, because a ref modified after the effect that reads it
   * is exactly the ordering hazard `react-hooks/immutability` exists to catch.
   */
  const eventsRef = useRef(events);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  // Same reason as `eventsRef`: read inside the pick handler below, which is
  // set up once and must not go stale as new station readings arrive.
  const magnetometerReadingsRef = useRef(magnetometerReadings);
  useEffect(() => {
    magnetometerReadingsRef.current = magnetometerReadings;
  }, [magnetometerReadings]);

  // Same reason again, for the two DONKI marker layers.
  const solarFlaresRef = useRef(solarFlares);
  useEffect(() => {
    solarFlaresRef.current = solarFlares;
  }, [solarFlares]);
  const cmeArrivalsRef = useRef(cmeArrivals);
  useEffect(() => {
    cmeArrivalsRef.current = cmeArrivals;
  }, [cmeArrivals]);

  // Globe click → store.
  //
  // Explicit picking rather than Cesium's `selectedEntityChanged`, which fires
  // with `undefined` both when the user clicks empty space *and* when the
  // selected entity is destroyed. Those are indistinguishable to a listener —
  // so once the 60s poll started rebuilding the layer, the panel would close
  // on its own every time new data arrived. Doing our own pick means
  // "deselected" can only mean the user actually clicked nothing.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    // Dragging the globe clears the selection: once you start moving the view
    // you're done with that event, and a panel describing it is just clutter.
    //
    // Tracked from the raw pointer rather than a camera event because the
    // camera also moves when *we* fly it to a freshly-selected event — using
    // camera movement would make selecting an event instantly deselect it.
    // Declared up here because the hover handler reads it to stay quiet
    // mid-drag.
    let dragOrigin: Cesium.Cartesian2 | undefined;
    // Whether this drag has already crossed the threshold and fired its one
    // deselect. Kept separate from `dragOrigin` itself: `dragOrigin` has to
    // stay set for the *entire* gesture (cleared only on LEFT_UP) so the hover
    // branch below keeps suppressing `scene.pick()` for the whole pan, not
    // just up to the first threshold crossing.
    let dragThresholdCrossed = false;

    /**
     * One candidate found under the pointer, before priority is applied.
     *
     * Six shapes come back, because the layers are built different ways:
     *
     * - Earthquakes, plate boundaries, magnetometer stations, flares and CME
     *   arrivals are **entities**, so `picked.id` is a Cesium Entity carrying
     *   an id string (and, for boundaries, `properties`).
     * - Faults are a batched **PolylineCollection**, so `picked.id` is the raw
     *   `FaultRecord` the layer attached at `add()` time. There is no entity to
     *   look up, which is why the layer has to carry the record itself.
     */
    type PickCandidate =
      | { kind: 'fault'; fault: FaultRecord }
      | { kind: 'boundary'; pair: string; boundaryClass: string }
      | { kind: 'earthquake'; event: EarthquakeEvent }
      | { kind: 'magnetometer'; reading: MagnetometerReading }
      | { kind: 'flare'; flare: SolarFlare }
      | { kind: 'cme-arrival'; arrival: CmeArrival };

    function classifyPicked(picked: unknown): PickCandidate | null {
      if (picked === null || typeof picked !== 'object') return null;

      const id: unknown = (picked as { id?: unknown }).id;
      if (id === null || typeof id !== 'object') return null;

      // A fault: the vendored record, recognised by its own shape rather than
      // by an id convention, because that is literally what was attached.
      if ('p' in id && 'z' in id) {
        return { kind: 'fault', fault: id as FaultRecord };
      }

      if (!('id' in id)) return null;
      const entity = id as Cesium.Entity;
      const entityId = typeof entity.id === 'string' ? entity.id : '';

      // Plate boundaries already carry their pair and class as properties.
      if (entityId.startsWith('boundary-')) {
        const properties = entity.properties as
          | { plateBoundary?: { getValue: () => unknown }; stepClass?: { getValue: () => unknown } }
          | undefined;
        // Narrowed rather than coerced: `getValue()` is typed `unknown`, and
        // `String()` on a non-string would quietly yield "[object Object]" as a
        // plate pair, which then renders as a plausible-looking label.
        const rawPair: unknown = properties?.plateBoundary?.getValue();
        const rawClass: unknown = properties?.stepClass?.getValue();
        const pair = typeof rawPair === 'string' ? rawPair : '';
        const boundaryClass = typeof rawClass === 'string' ? rawClass : '';
        return pair !== '' ? { kind: 'boundary', pair, boundaryClass } : null;
      }

      const stationCode = stationCodeFromEntityId(entityId);
      if (stationCode !== null) {
        const reading = magnetometerReadingsRef.current.find(
          (candidate) => candidate.station.code === stationCode,
        );
        return reading ? { kind: 'magnetometer', reading } : null;
      }

      const flareId = flareIdFromEntityId(entityId);
      if (flareId !== null) {
        const flare = solarFlaresRef.current.find((candidate) => candidate.id === flareId);
        return flare ? { kind: 'flare', flare } : null;
      }

      const simulationId = cmeSimulationIdFromEntityId(entityId);
      if (simulationId !== null) {
        const arrival = cmeArrivalsRef.current.find(
          (candidate) => candidate.simulationId === simulationId,
        );
        return arrival ? { kind: 'cme-arrival', arrival } : null;
      }

      // Otherwise an earthquake. The dot and its emphasis ring share an event
      // id, so both resolve to the same event.
      const eventId = eventIdFromEntityId(entityId);
      const event = eventsRef.current.find((candidate) => candidate.id === eventId);
      return event ? { kind: 'earthquake', event } : null;
    }

    /**
     * Resolves the pointer to whichever candidate wins, when more than one
     * pickable thing sits under the same pixel.
     *
     * A magnetometer ring is a shaded region up to 420 km across, drawn at the
     * same height-0 surface an earthquake dot sits on — so where a dot falls
     * inside a ring, `scene.pick()`'s normal depth test is comparing two
     * essentially coincident depths, a real GPU tie decided by precision, not
     * by anything meaningful. `drillPick` gathers every candidate at the pixel
     * instead of trusting whichever one the tie happens to favour, and this
     * function picks among them by hand: the smaller, more specific target
     * always wins over the broad region it happens to sit inside. Earthquakes
     * and faults/boundaries essentially never coincide at pixel scale, so
     * their relative order here rarely matters in practice. Flares and CME
     * arrivals are last: several can legitimately sit at nearly the same
     * subsolar point, and they're the layers a reader turns on last, on top
     * of everything else already on screen.
     */
    function choosePick(candidates: readonly PickCandidate[]): PickCandidate | null {
      for (const kind of [
        'earthquake',
        'fault',
        'boundary',
        'magnetometer',
        'flare',
        'cme-arrival',
      ] as const) {
        const found = candidates.find((candidate) => candidate.kind === kind);
        if (found) return found;
      }
      return null;
    }

    const resolvePick = (
      windowPosition: Cesium.Cartesian2,
    ): {
      target: HoverTarget;
      /** The clicked feature, minus its coordinate — the caller supplies that. */
      feature:
        | { kind: 'fault'; fault: FaultRecord }
        | { kind: 'boundary'; pair: string; boundaryClass: string }
        | null;
      eventId: string | null;
      /** A clicked flare or CME arrival, for the solar-event panel — its own slot, same reasoning `feature` gets one. */
      solarEvent: SolarEventSelection | null;
    } | null => {
      // A small limit: at most a dot, its ring, a fault and a magnetometer
      // ring could ever plausibly coincide at one pixel. `drillPick` stops
      // early once a pass finds nothing new, so hovering empty globe still
      // costs exactly the one pass `pick()` always cost.
      const picked: unknown[] = viewer.scene.drillPick(windowPosition, 4);
      const candidates = picked
        .map(classifyPicked)
        .filter((candidate): candidate is PickCandidate => candidate !== null);
      const chosen = choosePick(candidates);
      if (chosen === null) return null;

      switch (chosen.kind) {
        case 'fault':
          return {
            target: describeFault(chosen.fault),
            feature: { kind: 'fault', fault: chosen.fault },
            eventId: null,
            solarEvent: null,
          };
        case 'boundary':
          return {
            target: describeBoundary(chosen.pair, chosen.boundaryClass),
            feature: { kind: 'boundary', pair: chosen.pair, boundaryClass: chosen.boundaryClass },
            eventId: null,
            solarEvent: null,
          };
        case 'earthquake':
          return {
            target: describeEarthquake(chosen.event),
            feature: null,
            eventId: chosen.event.id,
            solarEvent: null,
          };
        case 'magnetometer':
          return {
            target: describeMagnetometer(chosen.reading),
            feature: null,
            eventId: null,
            solarEvent: null,
          };
        case 'flare':
          return {
            target: describeFlare(chosen.flare),
            feature: null,
            eventId: null,
            solarEvent: { kind: 'flare', flare: chosen.flare },
          };
        case 'cme-arrival':
          return {
            target: describeCmeArrival(chosen.arrival),
            feature: null,
            eventId: null,
            solarEvent: { kind: 'cme-arrival', arrival: chosen.arrival },
          };
      }
    };

    /**
     * Hover picking, throttled.
     *
     * `scene.pick()` is a render-target readback rather than a cheap CPU test,
     * so running it on every `MOUSE_MOVE` at 60 Hz stalls the GPU pipeline and
     * costs frames while rotating. A 50 ms floor keeps a settled pointer feeling
     * immediate without firing on every pixel of a sweep.
     */
    let lastPickMs = 0;
    const PICK_INTERVAL_MS = 50;

    handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      /**
       * The globe coordinate under the pointer.
       *
       * Undefined when the click missed the planet — space around the limb.
       * Every location answer is anchored to *where the user pointed*, not to a
       * feature's centroid: asking "how often here" about the middle of a 500 km
       * fault trace would answer for somewhere they never clicked.
       */
      const groundPoint = (): { latitude: number; longitude: number } | null => {
        const cartesian = viewer.scene.camera.pickEllipsoid(
          movement.position,
          viewer.scene.globe.ellipsoid,
        );
        if (!cartesian) return null;
        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        return {
          latitude: Cesium.Math.toDegrees(carto.latitude),
          longitude: Cesium.Math.toDegrees(carto.longitude),
        };
      };

      // Probe mode intercepts the click entirely and reads the *globe surface*
      // rather than whatever entity is under the cursor. "What is mapped here"
      // about a spot that happens to have a dot on it is still a question about
      // the spot; picking the entity would silently answer for its epicentre.
      if (faultProbeActiveRef.current) {
        const point = groundPoint();
        // A stray click into space leaves the current reading alone rather than
        // wiping something the user is still looking at.
        if (point) selectLocation({ ...point, kind: 'point' });
        // Same reason as above: probing a spot that happens to have a dot on it
        // must not leave the earthquake reticle behind.
        viewer.selectedEntity = undefined;
        return;
      }

      const resolved = resolvePick(movement.position);

      // A fault or plate boundary opens the location panel and leaves any
      // selected earthquake alone — different things, different slots.
      if (resolved?.feature) {
        const point = groundPoint();
        if (point) {
          selectLocation({ ...point, ...resolved.feature });
          // Cesium's Viewer runs its own left-click handler and sets
          // `selectedEntity` for any entity it picks — including a plate
          // boundary — which paints the *earthquake* reticle onto it. Geology
          // has its own highlight, so this takes that back. Ours runs second
          // because the Viewer registers its handler in the constructor.
          viewer.selectedEntity = undefined;
          return;
        }
      }

      // A flare or CME arrival opens the solar-event panel, same "different
      // things, different slots" reasoning as fault/boundary above — it also
      // leaves any selected earthquake alone.
      if (resolved?.solarEvent) {
        selectSolarEvent(resolved.solarEvent);
        // Same reason as the fault/boundary branch: Cesium's own left-click
        // handler already ran and set `selectedEntity` to this same entity,
        // which would paint the earthquake reticle onto a flare or CME dot.
        viewer.selectedEntity = undefined;
        return;
      }

      // The dot and its emphasis ring both resolve to the event id, so clicking
      // the ring selects the event rather than the ring.
      select(resolved?.eventId ?? null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      dragOrigin = Cesium.Cartesian2.clone(event.position);
      dragThresholdCrossed = false;
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    /**
     * The **single** MOUSE_MOVE handler: drag-deselect and hover, in that order.
     *
     * One handler because `setInputAction` stores one action per event type — a
     * second registration for MOUSE_MOVE silently replaces the first rather than
     * adding to it, so splitting these into two would leave only whichever ran
     * last. That failure is invisible: no error, one feature just never fires.
     */
    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (dragOrigin) {
        if (
          !dragThresholdCrossed &&
          Cesium.Cartesian2.distance(dragOrigin, event.endPosition) >= DRAG_THRESHOLD_PX
        ) {
          // Suppressed while the antipode chord is up. Spinning the globe to see
          // where the chord comes out is the entire point of that mode, and
          // deselecting would take the chord *and* the inspector holding its
          // exit control away on the first drag. Read through a ref so this
          // handler isn't torn down and rebuilt every time the mode changes.
          //
          // Also suppressed under the fault probe, for the same reason: rotating
          // to find a coastline to click on would otherwise clear the selection
          // you still have open beside it.
          if (!antipodeActiveRef.current && !faultProbeActiveRef.current) select(null);
          // Latched rather than clearing `dragOrigin`: a single drag deselects
          // once, but `dragOrigin` itself has to survive until LEFT_UP or the
          // branch below falls through to `resolvePick()` — a `scene.pick()`
          // GPU readback — for the rest of the pan. That was the actual cause
          // of the panning stutter: deselect fired once correctly, then hover
          // picking silently resumed for the remainder of every drag.
          dragThresholdCrossed = true;
        }

        // Nothing is hovered mid-drag: the pointer is moving the camera, the
        // pick would be discarded, and Cesium already shows its own grab cursor.
        setHover(null);
        return;
      }

      const nowMs = performance.now();
      if (nowMs - lastPickMs < PICK_INTERVAL_MS) return;
      lastPickMs = nowMs;

      const resolved = resolvePick(event.endPosition);
      viewer.scene.canvas.style.cursor = cursorForHover(resolved?.target ?? null);
      setHover(
        resolved === null
          ? null
          : { target: resolved.target, x: event.endPosition.x, y: event.endPosition.y },
      );
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction(() => {
      dragOrigin = undefined;
      dragThresholdCrossed = false;
    }, Cesium.ScreenSpaceEventType.LEFT_UP);

    return () => {
      // Non-negotiable #5 applies to handlers too.
      handler.destroy();
    };
    // `setProbePoint` is a stable Zustand action, and the probe mode itself is
    // read through a ref — so this handler is built once per viewer rather than
    // rebuilt every time the mode toggles.
    // `selectLocation` and `setHover` are stable Zustand actions and the modes
    // are read through refs, so this handler is built once per viewer rather
    // than rebuilt whenever a mode toggles.
  }, [select, selectLocation, selectSolarEvent, setHover, viewerReadyToken]);

  /**
   * The reticle on the selected fault, boundary or probed point.
   *
   * Same bracket shape as Cesium's selection indicator, different colour — a
   * selected quake and a selected fault should look equally "selected" while
   * still being told apart. See `location-highlight.ts`.
   */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    const highlight = createLocationHighlight(viewer);
    highlight.update(location);

    return () => {
      highlight.destroy();
    };
  }, [location, viewerReadyToken]);

  // Store → Cesium selection, so the reticle follows the store and survives a
  // layer rebuild.
  //
  // Subscribed rather than applied once, because applying once doesn't survive
  // the rebuild it claimed to: `dataSources.add()` is async, so on a refresh the
  // old source is already gone and the new one has not attached when this runs.
  // That cleared the reticle on every poll while the inspector stayed open —
  // the store still held the selection, and only Cesium's view of it was lost.
  // See `selection-sync.ts`.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    return watchSelection(viewer, viewer.dataSources.dataSourceAdded, selectedEventId);
    // **`events` is deliberately not a dependency**, and removing it fixed a
    // real bug. `useNow` ticks every 30 s, which changes `nowMs`, which gives
    // `useVisibleEarthquakes` a new array identity — so this effect re-ran on a
    // timer and re-applied the store's selection over whatever Cesium's own
    // click handling had set. A plate boundary clicked 30 seconds ago lost its
    // reticle for no reason the user could see.
    //
    // It was only ever here to survive layer rebuilds, and the `dataSourceAdded`
    // subscription covers those properly — including the case where a rebuild
    // drops the selected event, since the re-apply then finds nothing and
    // clears. Nothing inside the effect reads `events`.
  }, [selectedEventId, viewerReadyToken]);

  // Centring on an event, from selection or the inspector's Recenter button.
  //
  // `focusRequest` carries a nonce, so this fires once per request and re-fires
  // when the same event is picked again. That nonce is the *only* thing that
  // should move the camera.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !focusRequest) return;

    const event = eventsRef.current.find((candidate) => candidate.id === focusRequest.eventId);
    if (!event) return;

    // Rotate to the event at the height the camera is already at, so the
    // user's zoom level survives the click — including when zoomed in close,
    // which is when it matters and is exactly what the old floor broke.
    const height = focusAltitudeM(viewer.camera.positionCartographic.height);

    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(event.longitude, event.latitude, height),
      duration: 1,
    });
  }, [focusRequest]);

  return <div id="cesium-viewport" ref={containerRef} className={styles.viewport} />;
}
