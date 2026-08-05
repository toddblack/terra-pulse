import { create } from 'zustand';
import {
  DEFAULT_BASEMAP_ID,
  backdropToneFor,
  defaultOverlayVisibility,
  type BasemapId,
} from '../layers/registry';
import type { BackdropTone } from '@terra-pulse/schema';

/** A point the user asked about, in degrees. */
export interface ProbePoint {
  latitude: number;
  longitude: number;
}

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
  /** The probed point, or null when nothing has been clicked yet. */
  probePoint: ProbePoint | null;

  setActiveBasemap: (id: BasemapId) => void;
  toggleLayer: (id: string) => void;
  setLayerVisible: (id: string, visible: boolean) => void;
  toggleFaultProbe: () => void;
  setProbePoint: (point: ProbePoint | null) => void;
}

export const useGlobeStore = create<GlobeState>((set) => ({
  activeBasemapId: DEFAULT_BASEMAP_ID,
  layerVisibility: defaultOverlayVisibility(),
  faultProbeActive: false,
  probePoint: null,

  setActiveBasemap: (id) => set({ activeBasemapId: id }),

  // Leaving the mode drops the probed point with it. A stale reading left on
  // screen after the mode is off has no way to be refreshed or dismissed, and
  // describes a place the user has stopped asking about.
  toggleFaultProbe: () =>
    set((state) => ({
      faultProbeActive: !state.faultProbeActive,
      probePoint: state.faultProbeActive ? null : state.probePoint,
    })),

  setProbePoint: (probePoint) => set({ probePoint }),

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
