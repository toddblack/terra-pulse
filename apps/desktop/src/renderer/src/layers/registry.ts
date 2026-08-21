import type {
  BackdropTone,
  GlobeLayer,
  LayerCategory,
  LayerContext,
} from '@terra-pulse/schema';
import { createOsmBasemap } from './osm-basemap';
import { createReliefBasemap } from './relief-basemap';
import { createSeafloorBasemap } from './seafloor-basemap';
import { createEarthquakeLayer } from './earthquake-layer';
import { createPlateBoundariesLayer } from './plate-boundaries';
import { createSubductionZonesLayer } from './subduction-zones';
import { createActiveFaultsLayer } from './active-faults';
import { createGeomagneticFieldLayer } from './geomagnetic-field';
import { createAuroraLayer } from './aurora-layer';
import { createMagnetopauseLayer } from './magnetopause-layer';
import { createTideLayer } from './tide-layer';
import { createMagnetometerLayer } from './magnetometer-layer';
import { createTecLayer } from './tec-layer';
import { createSolarFlaresLayer } from './solar-flares-layer';
import { createCmeArrivalsLayer } from './cme-arrivals-layer';

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
  /**
   * Whether this layer's contents depend on the earthquake event set.
   *
   * Layers that say yes are rebuilt whenever new events arrive; layers that
   * say no are not. That distinction is load-bearing rather than cosmetic —
   * the poll replaces `events` on a timer, and rebuilding the static layers
   * along with it meant discarding and recreating 13,696 fault polylines
   * every cycle, which stuttered the globe mid-rotation.
   *
   * Geological features don't change on a poll timer. Default is `false`,
   * so a new layer opts in only if it genuinely reads `context.events`.
   */
  consumesEvents?: boolean;
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
  // Plain Blue Marble satellite imagery used to sit here. Dropped once Relief
  // shipped: it's the same imagery with seafloor relief shaded in, so the
  // plain version was strictly less informative for a globe about seismicity,
  // and an option nobody picks is only maintenance.
  {
    id: 'relief',
    label: 'Relief',
    category: 'basemap',
    tone: 'dark',
    create: () => createReliefBasemap(),
  },
  {
    id: 'seafloor',
    label: 'Seafloor',
    category: 'basemap',
    // Measured, not assumed. GEBCO's deep ocean sits around #335588, and the
    // depth ramp is blue too — so the ramps were checked against it. The
    // light-basemap ramp collapses (worst step ΔE 3.9, effectively invisible);
    // the dark ramp's worst is 9.7 with the rest at 18-46, because its shallow
    // end is pale blue. Hence 'dark'. The mark halo carries figure-ground on
    // top of that, which is what it exists for.
    tone: 'dark',
    create: () => createSeafloorBasemap(),
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
    // The only layer whose contents come from the event set.
    consumesEvents: true,
    create: (context) => createEarthquakeLayer(context.events, context.backdropTone),
  },
  {
    id: 'solar-flares',
    label: 'Solar flares (M+)',
    category: 'events',
    defaultVisible: false,
    // Flares arrive from main's own query, not the catalogue — pushed through
    // `setFlares`, the same push channel as the aurora grid.
    create: () => createSolarFlaresLayer(),
  },
  {
    id: 'cme-arrivals',
    label: 'CME arrivals',
    category: 'events',
    defaultVisible: false,
    create: () => createCmeArrivalsLayer(),
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
  {
    id: 'active-faults',
    label: 'Active faults',
    category: 'overlay',
    defaultVisible: false,
    create: (context) => createActiveFaultsLayer(context.backdropTone),
  },
  {
    id: 'geomagnetic-field',
    label: 'Magnetic field (IGRF)',
    category: 'overlay',
    // Off by default: it is a full-globe raster, and a data surface covering
    // the whole planet should be something you asked for rather than the first
    // thing you see.
    defaultVisible: false,
    // Computed from a vendored model, not from the catalogue — so a poll must
    // not rebuild it. It does follow the playhead, but through `setTimeWindow`,
    // which is the cheap channel.
    create: (context) => createGeomagneticFieldLayer(context.backdropTone),
  },
  {
    id: 'aurora',
    label: 'Aurora (live)',
    category: 'overlay',
    // Off by default like the field: a full-globe overlay should be asked for.
    defaultVisible: false,
    // Its data arrives from main's space-weather poll, not the catalogue, so it
    // must not be rebuilt when earthquakes land. The grid is pushed in through
    // `setGrid` — the same push-don't-rebuild channel the field quantity uses.
    create: () => createAuroraLayer(),
  },
  {
    id: 'tec',
    label: 'Ionosphere (live)',
    category: 'overlay',
    // Off by default like every full-globe raster here — and more pointedly, a
    // map is 2.4 MB and main only fetches while this is on.
    defaultVisible: false,
    // Its map arrives over IPC, not from the catalogue, so a poll must not
    // rebuild it. Pushed in through `setGrid`, like the aurora grid.
    create: (context) => createTecLayer(context.backdropTone),
  },
  {
    id: 'tides',
    label: 'Tidal potential',
    // `analysis` for the same reason the magnetopause is: this draws computed
    // output rather than a measurement or a mapped feature. Nothing observed it
    // — it is the equilibrium tide implied by where the Moon and Sun are.
    category: 'analysis',
    defaultVisible: false,
    // Computed from the playhead alone, so nothing pushes into it and a poll
    // must not rebuild it. Its only input is `setTimeWindow`.
    create: (context) => createTideLayer(context.backdropTone),
  },
  {
    id: 'magnetometers',
    label: 'Magnetometers (live)',
    category: 'overlay',
    // Off by default like the other space-weather layers.
    defaultVisible: false,
    // Readings arrive from main's own poll, not the catalogue, so it must not
    // be rebuilt when earthquakes land — same push channel as the aurora grid.
    create: () => createMagnetometerLayer(),
  },
  {
    id: 'magnetopause',
    label: 'Magnetopause (model)',
    // The only `analysis` overlay so far, and the category is doing real work:
    // every other layer draws a measurement or a mapped feature, and this draws
    // an empirical fit evaluated on measured inputs. The label says "(model)"
    // for the same reason — the distinction has to survive someone reading only
    // the toggle.
    category: 'analysis',
    // Off by default, and more emphatically than the others: enabling it flies
    // the camera out to ~26 Earth radii, because at any normal viewing distance
    // the boundary is off screen entirely.
    defaultVisible: false,
    // Fed the solar wind through `setSolarWind`, on the same push-don't-rebuild
    // channel as the field quantity and the aurora grid.
    create: () => createMagnetopauseLayer(),
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
