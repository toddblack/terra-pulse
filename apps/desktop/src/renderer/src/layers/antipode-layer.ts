import * as Cesium from 'cesium';
import type {
  AntipodalEvent,
  BackdropTone,
  EarthquakeEvent,
  GlobeLayer,
} from '@terra-pulse/schema';
import { ANTIPODAL_RINGS_KM } from '@terra-pulse/schema';
import { antipodeOf, chordProgress } from './antipode';

/**
 * The antipode chord — PROJECT_PLAN §5.3.
 *
 * A straight line through the Earth's interior from a selected event to the
 * point diametrically opposite, with the globe made translucent so the line is
 * visible rather than buried.
 *
 * Built as a `GlobeLayer` like everything else, but **not registered** in the
 * layer registry: it isn't a thing you switch on in the layer panel, it is a
 * mode you enter from one event. Keeping the shape means it still gets the
 * mount/unmount discipline non-negotiable #5 requires — and this layer mutates
 * global scene state, so leaking an unmount would leave the whole globe
 * see-through.
 */

/** How see-through the globe goes. Enough to read the chord, not so much that the planet stops being a planet. */
const GLOBE_FRONT_FACE_ALPHA = 0.38;

/** Long enough to read as travel, short enough not to be waiting on it. */
const CHORD_DURATION_MS = 900;

/**
 * Red, for the same reason the recency stroke is: it means *look at this*.
 * Unlike the depth ramp this does not flip per basemap — the chord is drawn
 * through the globe's interior, not against its surface, so the backdrop it
 * competes with is the darkened inside of the planet either way.
 */
const CHORD_COLOR = '#ff3b30';

/**
 * Events recorded near the antipode inside the window.
 *
 * Amber rather than the chord's red: red already means "this is the thing being
 * shown", and a hit is a different kind of object — something the catalogue
 * happened to record there, not part of the geometry being drawn. Keeping them
 * distinct stops the marker reading as an endpoint of the chord.
 */
const HIT_COLOR = Cesium.Color.fromCssColorString('#fbbf24');

export function antipodeEntityId(eventId: string): string {
  return `${eventId}::antipode`;
}

export function createAntipodeLayer(
  event: EarthquakeEvent,
  _tone: BackdropTone,
  /**
   * What the catalogue recorded near this antipode inside H5's window, or an
   * empty list. Passed in rather than fetched here so the layer stays pure
   * Cesium and the IPC lives with the rest of the renderer's data loading.
   */
  hits: readonly AntipodalEvent[] = [],
  now: () => number = () => performance.now(),
): GlobeLayer {
  let viewer: Cesium.Viewer | null = null;
  let dataSource: Cesium.CustomDataSource | null = null;
  let visible = true;

  /** Restored on unmount — the globe is shared, so this must be given back. */
  let previousTranslucencyEnabled = false;
  let previousFrontFaceAlpha = 1;

  const origin = Cesium.Cartesian3.fromDegrees(event.longitude, event.latitude);
  const target = antipodeOf({ latitude: event.latitude, longitude: event.longitude });
  const antipode = Cesium.Cartesian3.fromDegrees(target.longitude, target.latitude);

  const startedAt = now();
  const chordColor = Cesium.Color.fromCssColorString(CHORD_COLOR);

  /**
   * The chord's far end, interpolated so the line grows out from the event.
   *
   * `Cartesian3.lerp` in earth-fixed space is exactly right here: the chord is
   * a straight line *through* the planet, so linear interpolation traces the
   * real path rather than an arc over the surface.
   */
  function chordPositions(): Cesium.Cartesian3[] {
    const progress = chordProgress(now() - startedAt, CHORD_DURATION_MS);
    const tip = Cesium.Cartesian3.lerp(origin, antipode, progress, new Cesium.Cartesian3());
    return [origin, tip];
  }

  function build(target_: Cesium.CustomDataSource): void {
    target_.entities.add({
      id: antipodeEntityId(event.id),
      polyline: {
        // A CallbackProperty rather than a fixed array: this is re-evaluated
        // each frame, which is what animates it. `false` marks it as
        // non-constant so Cesium doesn't cache the first value.
        positions: new Cesium.CallbackProperty(() => chordPositions(), false),
        width: 2,
        // NONE is load-bearing. The default GEODESIC drapes a polyline over the
        // surface, which would draw a line the long way *round* the Earth
        // instead of straight through it — the opposite of what this shows.
        arcType: Cesium.ArcType.NONE,
        material: chordColor,
        // Without this the globe's own depth buffer hides the half of the chord
        // that is inside the planet, which is the half that matters.
        depthFailMaterial: new Cesium.PolylineDashMaterialProperty({
          color: chordColor.withAlpha(0.85),
          dashLength: 12,
        }),
      },
    });

    // The far end, revealed only once the chord reaches it — a marker sitting
    // there from the first frame would give away the ending.
    const arrived = new Cesium.CallbackProperty(
      () => chordProgress(now() - startedAt, CHORD_DURATION_MS) >= 1,
      false,
    );

    target_.entities.add({
      id: `${antipodeEntityId(event.id)}::point`,
      position: antipode,
      point: {
        pixelSize: 10,
        color: Cesium.Color.TRANSPARENT,
        outlineColor: chordColor,
        outlineWidth: 2,
        show: arrived,
      },
    });

    /**
     * Distance rings at the antipode — §5.3's 250/500/1000 km.
     *
     * **Readability only. These carry no statistical meaning**, and §5.3 is
     * emphatic about it: the registered H5 test uses the whole distance
     * distribution precisely so that no radius has to be guessed. They exist so
     * a human can see "that hit was inside 250 km" without measuring.
     *
     * Drawn as ellipses rather than polylines so they follow the curve of the
     * globe rather than cutting a chord across it — a 1000 km circle is wide
     * enough for the difference to show at grazing angles.
     */
    for (const radiusKm of ANTIPODAL_RINGS_KM) {
      target_.entities.add({
        id: `${antipodeEntityId(event.id)}::ring-${String(radiusKm)}`,
        position: antipode,
        ellipse: {
          semiMajorAxis: radiusKm * 1000,
          semiMinorAxis: radiusKm * 1000,
          material: Cesium.Color.TRANSPARENT,
          outline: true,
          // Fainter as they widen, so the innermost reads as the tightest claim
          // and the outermost doesn't dominate the view.
          outlineColor: chordColor.withAlpha(radiusKm <= 250 ? 0.55 : radiusKm <= 500 ? 0.35 : 0.2),
          outlineWidth: 1,
          height: 0,
          show: arrived,
        },
      });
    }

    /**
     * Any events the catalogue recorded there inside the window.
     *
     * Marked, not interpreted. Measured across 714 declustered M7+ triggers,
     * these appear at 0.91× the rate the antipodes' own background predicts —
     * i.e. exactly chance — so a marker here means "one happened", never "one
     * was triggered". The panel carries the background rate that says so.
     */
    for (const hit of hits) {
      target_.entities.add({
        id: `${antipodeEntityId(event.id)}::hit-${hit.event.id}`,
        position: Cesium.Cartesian3.fromDegrees(hit.event.longitude, hit.event.latitude),
        point: {
          pixelSize: 12,
          color: Cesium.Color.TRANSPARENT,
          outlineColor: HIT_COLOR,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          show: arrived,
        },
        label: {
          text: `M${hit.event.magnitude.toFixed(1)} +${hit.delayHours.toFixed(1)}h`,
          font: '11px sans-serif',
          fillColor: HIT_COLOR,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -18),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          show: arrived,
        },
      });
    }
  }

  return {
    id: 'antipode',
    label: 'Antipode',
    category: 'analysis',
    defaultVisible: true,

    mount(v) {
      viewer = v;

      const globe = v.scene.globe;
      previousTranslucencyEnabled = globe.translucency.enabled;
      previousFrontFaceAlpha = globe.translucency.frontFaceAlpha;
      globe.translucency.enabled = true;
      globe.translucency.frontFaceAlpha = GLOBE_FRONT_FACE_ALPHA;

      const source = new Cesium.CustomDataSource('antipode');
      build(source);
      source.show = visible;
      dataSource = source;

      void v.dataSources.add(source).then(
        () => {
          // Unmounted while the add was still in flight — detach it, or the
          // data source stays attached with nothing holding a reference.
          if (!dataSource && !v.isDestroyed()) v.dataSources.remove(source, true);
        },
        (error: unknown) => {
          console.error('Failed to add the antipode layer', error);
        },
      );
    },

    unmount() {
      const source = dataSource;
      dataSource = null;

      if (viewer && !viewer.isDestroyed()) {
        // Globe translucency is scene-wide state this layer borrowed. Restoring
        // the previous values rather than hard-coding `false` means nesting or
        // a future second consumer can't be clobbered by this one leaving.
        const globe = viewer.scene.globe;
        globe.translucency.enabled = previousTranslucencyEnabled;
        globe.translucency.frontFaceAlpha = previousFrontFaceAlpha;

        if (source) viewer.dataSources.remove(source, true);
      }

      viewer = null;
    },

    setTimeWindow() {
      // The chord belongs to one event, which either is or isn't the selection.
      // Narrowing the window doesn't change that, so there is nothing to do.
    },

    setVisible(v) {
      visible = v;
      if (dataSource) dataSource.show = v;
    },
  };
}
