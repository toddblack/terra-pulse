import { create } from 'zustand';
import {
  DEFAULT_BASEMAP_ID,
  backdropToneFor,
  defaultOverlayVisibility,
  type BasemapId,
} from '../layers/registry';
import type { HoverTarget } from '../globe/hover-target';
import type { FaultRecord } from '../layers/fault-association';
import {
  DEFAULT_RECURRENCE_FLOOR,
  DEFAULT_RECURRENCE_RADIUS_KM,
  type BackdropTone,
} from '@terra-pulse/schema';

/** What the pointer is over, plus where to draw the tooltip. */
export interface HoverState {
  target: HoverTarget;
  /** Screen position of the pointer, CSS pixels within the canvas. */
  x: number;
  y: number;
}

/**
 * A place the user asked about, and what — if anything — they clicked there.
 *
 * **One slot for three cases, because they all answer questions about the same
 * point.** Clicking a fault, clicking a plate boundary, and probing bare globe
 * used to fill two separate panels that repeated each other's fault section.
 * They now fill one: `kind` decides what sourced detail appears at the top, and
 * the coordinate drives the recurrence section underneath in every case.
 *
 * The coordinate is always where the pointer was, not the feature's centroid —
 * asking "how often here" about the middle of a 500 km fault trace would answer
 * for somewhere the user never pointed at.
 *
 * Kept separate from the earthquake selection: they describe different things
 * and appear in different panels, so closing one must not close the other.
 */
export type LocationSelection = { latitude: number; longitude: number } & (
  | { kind: 'fault'; fault: FaultRecord }
  | { kind: 'boundary'; pair: string; boundaryClass: string }
  /** Probe mode: bare globe, so the panel finds the nearest fault itself. */
  | { kind: 'point' }
);

interface GlobeState {
  /** Exclusive group — exactly one basemap is active (PROJECT_PLAN §4). */
  activeBasemapId: BasemapId;
  /** Independent toggles, keyed by layer id. */
  layerVisibility: Record<string, boolean>;

  /**
   * Whether clicking the globe asks "what fault is here?" instead of selecting.
   *
   * An explicit mode rather than folding the probe into ordinary clicks. A bare
   * globe click already means "deselect", and quietly overloading it would make
   * dismissing the inspector open a different panel instead — a rule nobody
   * could predict from watching it once.
   */
  faultProbeActive: boolean;
  /** What the location panel is showing, or null when it is closed. */
  location: LocationSelection | null;

  /**
   * Region size and magnitude floor for the recurrence panel.
   *
   * Kept in the store rather than in the panel so the choice survives changing
   * selection — someone comparing two regions at M6.5/200 km should not have to
   * re-pick it on every click.
   */
  recurrenceRadiusKm: number;
  recurrenceFloor: number;

  /** Live hover readout, or null when the pointer is over empty globe. */
  hover: HoverState | null;

  /**
   * Which inspector sections are expanded, by section id.
   *
   * Missing means collapsed, which is the default for every section. The
   * inspector is vertically centred and its four sections together run past the
   * time scrubber at the bottom of the window; starting collapsed keeps the
   * panel to the event's own identity, which is what every selection is about.
   *
   * **Kept here rather than in the panel so it survives changing selection.**
   * Expansion is a statement about what you are interested in, not about one
   * earthquake — re-opening "What followed" on every click through the event
   * list would make the feature cost more than it saves.
   *
   * A collapsed section is **not rendered at all**, so its data hook never runs
   * and its IPC never fires. That is deliberate and is most of the value: the
   * recurrence query alone is 32–294 ms of O(n²) declustering in main, paid on
   * every selection before this existed.
   */
  expandedSections: Record<string, boolean>;

  setActiveBasemap: (id: BasemapId) => void;
  toggleLayer: (id: string) => void;
  setLayerVisible: (id: string, visible: boolean) => void;
  toggleFaultProbe: () => void;
  selectLocation: (selection: LocationSelection | null) => void;
  setRecurrenceRadiusKm: (radiusKm: number) => void;
  setRecurrenceFloor: (floor: number) => void;
  setHover: (hover: HoverState | null) => void;
  toggleSection: (id: string) => void;
}

export const useGlobeStore = create<GlobeState>((set) => ({
  activeBasemapId: DEFAULT_BASEMAP_ID,
  layerVisibility: defaultOverlayVisibility(),
  faultProbeActive: false,
  location: null,
  recurrenceRadiusKm: DEFAULT_RECURRENCE_RADIUS_KM,
  recurrenceFloor: DEFAULT_RECURRENCE_FLOOR,
  hover: null,
  expandedSections: {},

  setActiveBasemap: (id) => set({ activeBasemapId: id }),

  /**
   * Leaving probe mode drops a probed *point* with it, but leaves a clicked
   * fault or boundary alone.
   *
   * A bare-point reading has no way to be refreshed once the mode is off — you
   * cannot click another one — so it would sit there describing a place the user
   * has stopped asking about. A clicked feature is still perfectly meaningful
   * with the mode off, and closing it would be gratuitous.
   */
  toggleFaultProbe: () =>
    set((state) => ({
      faultProbeActive: !state.faultProbeActive,
      location:
        state.faultProbeActive && state.location?.kind === 'point' ? null : state.location,
    })),

  selectLocation: (location) => set({ location }),

  setRecurrenceRadiusKm: (recurrenceRadiusKm) => set({ recurrenceRadiusKm }),
  setRecurrenceFloor: (recurrenceFloor) => set({ recurrenceFloor }),

  setHover: (hover) => set({ hover }),

  /**
   * Absent means collapsed, so the first click on an untouched section opens
   * it. Written as `!state.expandedSections[id]` rather than compared against
   * `false` for exactly that reason.
   */
  toggleSection: (id) =>
    set((state) => ({
      expandedSections: { ...state.expandedSections, [id]: !state.expandedSections[id] },
    })),

  toggleLayer: (id) =>
    set((state) => ({
      layerVisibility: { ...state.layerVisibility, [id]: !state.layerVisibility[id] },
    })),

  setLayerVisible: (id, visible) =>
    set((state) => ({
      layerVisibility: { ...state.layerVisibility, [id]: visible },
    })),
}));

/**
 * The active backdrop's tone. Selector rather than stored state so it can
 * never drift out of sync with the basemap it describes.
 */
export function selectBackdropTone(state: GlobeState): BackdropTone {
  return backdropToneFor(state.activeBasemapId);
}
