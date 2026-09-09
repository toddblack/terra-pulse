import * as Cesium from 'cesium';
import type { GlobeLayer } from '@terra-pulse/schema';
import { instantOnScreen } from '../globe/display-window';
import { CELESTIAL_BODY_COLORS, CELESTIAL_BODY_NAMES, CELESTIAL_BODY_ORDER } from './planetary-positions-encoding';
import { celestialBodies, type CelestialBodyId } from './planetary-positions';

/**
 * The Sun, Moon and seven other planets, marked at their sub-points — where
 * each is directly overhead right now, or at the scrubber's position.
 *
 * ## Decorative, not causal — see the layer guide
 *
 * `PROJECT_PLAN.md` §5.7 asks for exactly this, in those words. Nothing here
 * feeds any computation in this app; see `planetary-positions.ts`'s own doc
 * comment for the physics (Jupiter's tidal influence at closest approach is
 * about 1/10,000,000 of the Moon's).
 *
 * ## Built set stable, visibility live — simpler than most layers here
 *
 * Unlike `magnetopause-layer.ts` (needs pushed solar wind) or the flare/CME
 * layers (need a catalogue), a body's position is a pure function of time,
 * so this follows `tide-layer.ts`'s shape: `setTimeWindow` is the *only*
 * input. Nine point entities are built once in `mount()`; each position is a
 * `Cesium.CallbackProperty` reading a cached `Record<CelestialBodyId,
 * Cartesian3>` that `recompute()` refreshes. No quantisation is needed the
 * way the tide raster or the field layer need it — this recomputes nine
 * small Kepler solves, not an image, so there is no repaint cost to guard
 * against.
 *
 * ## No persistent on-globe labels
 *
 * Nine always-on text labels would be exactly the kind of clutter this
 * app's mark-budget discipline exists to avoid. Identity is carried by
 * colour plus the hover/click tooltip (name and current distance, via
 * `describePlanetaryPosition` in `hover-target.ts`) and by
 * `DepthLegend.tsx`'s `PlanetaryPositionsKey` — the same split every other
 * coloured mark in this app uses.
 */
export const PLANETARY_POSITIONS_LAYER_ID = 'planetary-positions';

/**
 * The prefix on every marker's entity id, so `CesiumViewer`'s pick resolver
 * can recognise one without guessing — the same convention the magnetometer
 * and solar-flare layers use.
 */
const BODY_ID_PREFIX = 'planetary-position-';

export function celestialBodyEntityId(id: CelestialBodyId): string {
  return `${BODY_ID_PREFIX}${id}`;
}

/** The reverse of `celestialBodyEntityId` — how the pick handler maps a
 * click back to which body it was. */
export function celestialBodyIdFromEntityId(entityId: string): CelestialBodyId | null {
  if (!entityId.startsWith(BODY_ID_PREFIX)) return null;
  const id = entityId.slice(BODY_ID_PREFIX.length);
  return CELESTIAL_BODY_ORDER.includes(id as CelestialBodyId) ? (id as CelestialBodyId) : null;
}

export function createPlanetaryPositionsLayer(): GlobeLayer {
  let viewer: Cesium.Viewer | null = null;
  let source: Cesium.CustomDataSource | null = null;
  let mounted = false;
  let instant = new Date();
  let positions: Record<CelestialBodyId, Cesium.Cartesian3> = emptyPositions();

  function emptyPositions(): Record<CelestialBodyId, Cesium.Cartesian3> {
    const zero = Cesium.Cartesian3.ZERO;
    return {
      sun: zero,
      moon: zero,
      mercury: zero,
      venus: zero,
      mars: zero,
      jupiter: zero,
      saturn: zero,
      uranus: zero,
      neptune: zero,
    };
  }

  function recompute(): void {
    const bodies = celestialBodies(instant);
    const next = emptyPositions();

    for (const id of CELESTIAL_BODY_ORDER) {
      const body = bodies[id];
      next[id] = Cesium.Cartesian3.fromDegrees(body.sublongitudeDeg, body.sublatitudeDeg);
    }

    positions = next;
  }

  /**
   * Created once on mount. Nothing here is added or removed afterwards —
   * only what the position callback reads changes.
   *
   * No `description` — Cesium's InfoBox is disabled app-wide
   * (`CesiumViewer.tsx`'s `infoBox: false`) in favour of the custom hover
   * tooltip, so a `description` here would be inert weight nobody reads.
   * `describePlanetaryPosition` in `hover-target.ts` is what actually
   * answers a hover or click, recomputed on demand rather than cached on the
   * entity — see `CesiumViewer.tsx`'s `planetary-position` pick case.
   */
  function buildEntities(target: Cesium.CustomDataSource): void {
    for (const id of CELESTIAL_BODY_ORDER) {
      const colour = Cesium.Color.fromCssColorString(CELESTIAL_BODY_COLORS[id]);
      target.entities.add({
        id: celestialBodyEntityId(id),
        position: new Cesium.CallbackPositionProperty(() => positions[id], false),
        name: CELESTIAL_BODY_NAMES[id],
        point: {
          pixelSize: id === 'sun' || id === 'moon' ? 10 : 7,
          color: colour,
          outlineColor: Cesium.Color.WHITE.withAlpha(0.6),
          outlineWidth: 1,
        },
      });
    }
  }

  return {
    id: PLANETARY_POSITIONS_LAYER_ID,
    label: 'Planetary positions (decorative)',
    category: 'analysis',
    defaultVisible: false,

    mount(nextViewer) {
      viewer = nextViewer;
      source = new Cesium.CustomDataSource(PLANETARY_POSITIONS_LAYER_ID);
      void viewer.dataSources.add(source);
      mounted = true;
      recompute();
      buildEntities(source);
    },

    unmount() {
      if (viewer && !viewer.isDestroyed() && source) viewer.dataSources.remove(source, true);
      source = null;
      viewer = null;
      mounted = false;
    },

    setTimeWindow(_start, end) {
      const next = new Date(instantOnScreen(end.getTime(), Date.now()));
      if (next.getTime() === instant.getTime()) return;
      instant = next;
      if (mounted) recompute();
    },

    setVisible(next) {
      if (source) source.show = next;
    },
  };
}
