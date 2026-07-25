import { create } from 'zustand';
import type { BasemapId } from '@terra-pulse/schema';

interface GlobeState {
  activeBasemap: BasemapId;
  setActiveBasemap: (id: BasemapId) => void;
}

export const useGlobeStore = create<GlobeState>((set) => ({
  activeBasemap: 'osm',
  setActiveBasemap: (id) => set({ activeBasemap: id }),
}));
