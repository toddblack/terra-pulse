import type { Viewer } from 'cesium';

export type LayerCategory = 'basemap' | 'overlay' | 'events' | 'analysis';

/**
 * Every globe layer implements this. The layer registry depends on it —
 * no layer-specific exceptions. See CLAUDE.md.
 */
export interface GlobeLayer {
  id: string;
  label: string;
  category: LayerCategory;
  exclusive?: boolean;
  defaultVisible: boolean;
  mount(viewer: Viewer): void;
  unmount(): void;
  setTimeWindow(start: Date, end: Date): void;
  setVisible(v: boolean): void;
}
