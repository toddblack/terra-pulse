import { create } from 'zustand';
import {
  DEFAULT_BASEMAP_ID,
  backdropToneFor,
  defaultOverlayVisibility,
  type BasemapId,
} from '../layers/registry';
import type { BackdropTone } from '@terra-pulse/schema';

interface GlobeState {
  /** Exclusive group — exactly one basemap is active (PROJECT_PLAN §4). */
  activeBasemapId: BasemapId;
  /** Independent toggles, keyed by layer id. */
  layerVisibility: Record<string, boolean>;

  setActiveBasemap: (id: BasemapId) => void;
  toggleLayer: (id: string) => void;
  setLayerVisible: (id: string, visible: boolean) => void;
}

export const useGlobeStore = create<GlobeState>((set) => ({
  activeBasemapId: DEFAULT_BASEMAP_ID,
  layerVisibility: defaultOverlayVisibility(),

  setActiveBasemap: (id) => set({ activeBasemapId: id }),

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
