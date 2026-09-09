/**
 * The rows of the multi-track timeline, declared once.
 *
 * §5.5 asks for tracks "each independently toggleable" and they were not: all
 * of them rendered, always, and the panel's height grew with every one added.
 * That cost is paid twice over — the inspector is centred, so clearance it
 * needs at the bottom is also reserved at the top (see
 * `EarthquakeInspector.module.css`) — which is why a fifth row is the point at
 * which toggling stopped being optional.
 *
 * ## Why a registry rather than a list in the component
 *
 * The same reason `layers/registry.ts` is one: three separate places need to
 * agree on what the rows *are* — the toggle control, the store's default
 * visibility, and `track-guides.test.ts`, which until now carried its own
 * hardcoded copy of the ids and would happily have gone on passing while a new
 * row shipped with no explanation. Reading the registry makes that test fail
 * for a missing guide, which is the discipline `layer-guides.test.ts` already
 * enforces for globe layers.
 */

export type TrackRowId =
  | 'geomagnetic'
  | 'solar-wind'
  | 'xray-flux'
  | 'earthquakes'
  | 'tidal-stress'
  | 'magnetometer';

export interface TrackRowRegistration {
  id: TrackRowId;
  /** Shown on the toggle chip. The row's own header carries the longer title. */
  label: string;
  /**
   * Rows that were already shipping stay on: turning off a row someone has
   * been reading for months is a regression, not a default.
   */
  defaultVisible: boolean;
}

export const TRACK_ROWS: readonly TrackRowRegistration[] = [
  { id: 'geomagnetic', label: 'Geomagnetic', defaultVisible: true },
  { id: 'solar-wind', label: 'Solar wind', defaultVisible: true },
  { id: 'xray-flux', label: 'X-ray', defaultVisible: true },
  { id: 'earthquakes', label: 'Earthquakes', defaultVisible: true },
  /**
   * Off by default, alone among the five. It is the only row that says nothing
   * until something is selected — it needs a fault plane to resolve stress onto
   * — so shipping it on would put a permanently empty row in front of everyone
   * to explain itself. It also costs height the other four already spent.
   */
  { id: 'tidal-stress', label: 'Tidal stress', defaultVisible: false },
  /**
   * Off by default for the same reason as the tidal row, plus one of its own:
   * it is the only row that reaches the **network** when switched on, and a
   * trace is up to four upstream requests. It should cost nothing until asked
   * for.
   */
  { id: 'magnetometer', label: 'Magnetometer', defaultVisible: false },
];

/** The guide key for a row, in `track-guides.ts`. */
export function trackGuideIdFor(id: TrackRowId): string {
  return `track-${id}`;
}

/** Initial state for the store — mirrors `defaultOverlayVisibility` for layers. */
export function defaultTrackVisibility(): Record<string, boolean> {
  const visibility: Record<string, boolean> = {};
  for (const row of TRACK_ROWS) visibility[row.id] = row.defaultVisible;
  return visibility;
}

/**
 * Absent means visible, so a row added to the registry after a store was
 * created still draws.
 *
 * The opposite of `expandedSections`' "absent means collapsed", and deliberately
 * so: an unknown *section* is one nobody has opened, while an unknown *row* is
 * one the registry says should be there. Defaulting it hidden would make a newly
 * shipped row invisible to everyone who had ever touched a toggle.
 */
export function isTrackVisible(id: TrackRowId, visibility: Record<string, boolean>): boolean {
  return visibility[id] ?? true;
}
