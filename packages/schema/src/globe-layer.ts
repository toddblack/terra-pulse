import type { Viewer } from 'cesium';
import type { EarthquakeEvent } from './earthquake';

export type LayerCategory = 'basemap' | 'overlay' | 'events' | 'analysis';

/**
 * How dark the active basemap renders. Layers drawn on top read this to pick
 * marks that stay legible against it.
 *
 * Deliberately not the basemap's id: a layer cares whether the backdrop is
 * light or dark, not *which* backdrop it is. Keeping it abstract means adding
 * a basemap doesn't require editing every layer that draws over one.
 */
export type BackdropTone = 'light' | 'dark';

/** Everything a layer factory may need, passed uniformly by the registry. */
export interface LayerContext {
  events: readonly EarthquakeEvent[];
  backdropTone: BackdropTone;
}

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
