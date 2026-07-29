import type {
  BackdropTone,
  GlobeLayer,
  LayerCategory,
  LayerContext,
} from '@terra-pulse/schema';
import { createOsmBasemap } from './osm-basemap';
import { createSatelliteBasemap } from './satellite-basemap';
import { createEarthquakeLayer } from './earthquake-layer';
import { createPlateBoundariesLayer } from './plate-boundaries';
import { createSubductionZonesLayer } from './subduction-zones';

/**
 * The single source of truth for which layers exist.
 *
 * Adding a layer means adding one entry here — the lifecycle hook and the
 * layer panel are both driven off these lists and need no edit.
 */
interface LayerMetadata {
  id: string;
  label: string;
  category: LayerCategory;
}

export interface BasemapRegistration extends LayerMetadata {
  category: 'basemap';
  /**
   * How dark this basemap renders. Layers drawn on top read it to pick marks
   * that stay legible — declared here rather than inferred from the id inside
   * every layer that cares, so a new basemap touches only this file.
   */
  tone: BackdropTone;
  /** Basemaps consume no data; they only need the viewer. */
  create(): GlobeLayer;
}

export interface OverlayRegistration extends LayerMetadata {
  defaultVisible: boolean;
  create(context: LayerContext): GlobeLayer;
}

// Exclusive group: exactly one is active at a time (PROJECT_PLAN §4).
export const BASEMAP_REGISTRATIONS = [
  {
    id: 'osm',
    label: 'Basic',
    category: 'basemap',
    tone: 'light',
    create: () => createOsmBasemap(),
  },
  {
    id: 'satellite',
    label: 'Satellite',
    category: 'basemap',
    tone: 'dark',
    create: () => createSatelliteBasemap(),
  },
] as const satisfies readonly BasemapRegistration[];

export type BasemapId = (typeof BASEMAP_REGISTRATIONS)[number]['id'];

export const DEFAULT_BASEMAP_ID: BasemapId = 'osm';

// Independent toggles: any combination may be on at once.
export const OVERLAY_REGISTRATIONS: readonly OverlayRegistration[] = [
  {
    id: 'earthquakes',
    label: 'Earthquakes',
    category: 'events',
    defaultVisible: true,
    create: (context) => createEarthquakeLayer(context.events, context.backdropTone),
  },
  {
    id: 'plate-boundaries',
    label: 'Plate boundaries',
    category: 'overlay',
    defaultVisible: true,
    create: (context) => createPlateBoundariesLayer(context.backdropTone),
  },
  {
    id: 'subduction-zones',
    label: 'Subduction zones',
    category: 'overlay',
    defaultVisible: false,
    create: (context) => createSubductionZonesLayer(context.backdropTone),
  },
];

export function findBasemap(id: string): BasemapRegistration | undefined {
  return BASEMAP_REGISTRATIONS.find((entry) => entry.id === id);
}

/** The tone of the active basemap, for layers drawing on top of it. */
export function backdropToneFor(basemapId: string): BackdropTone {
  return findBasemap(basemapId)?.tone ?? 'light';
}

/** Seeds the store's visibility map from each overlay's declared default. */
export function defaultOverlayVisibility(): Record<string, boolean> {
  return Object.fromEntries(
    OVERLAY_REGISTRATIONS.map((entry) => [entry.id, entry.defaultVisible]),
  );
}

/** Whether a layer should currently be on screen, honouring its default. */
export function isOverlayVisible(
  entry: OverlayRegistration,
  visibility: Record<string, boolean>,
): boolean {
  return visibility[entry.id] ?? entry.defaultVisible;
}
