import * as Cesium from 'cesium';
import type { AntipodalEvent, EarthquakeEvent, GlobeLayer } from '@terra-pulse/schema';
import { ANTIPODAL_RINGS_KM } from '@terra-pulse/schema';
import { antipodeOf } from './antipode';
import { antipodeMoment, ringRadiusKm } from './antipode-sequence';
import { circlePoints } from '../waveforms/replay-playback';

/**
 * The antipode chord — PROJECT_PLAN §5.3.
 *
 * A straight line through the Earth's interior from a selected event to the
 * point diametrically opposite, with the globe made translucent so the line is
 * visible rather than buried. When the line lands, the distance rings spread
 * out from that point like a ripple, and any event the catalogue recorded
 * there appears as the ripple reaches it.
 *
 * Built as a `GlobeLayer` like everything else, but **not registered** in the
 * layer registry: it isn't a thing you switch on in the layer panel, it is a
 * mode you enter from one event. Keeping the shape means it still gets the
 * mount/unmount discipline non-negotiable #5 requires — and this layer mutates
 * global scene state, so leaking an unmount would leave the whole globe
 * see-through.
 *
 * **Built once per entry into the mode; nothing is rebuilt as it plays.** The
 * hits arrive from an async lookup after the layer is up, and they used to be
 * a constructor argument — so their arrival tore the layer down and restarted
 * the chord. That was a blink when the chord took 900 ms under a still camera.
 * With a camera move and a ripple it would restart the whole sequence, so
 * hits are pushed in through `setHits` instead: built set stable, the rule the
 * rest of the globe follows. The timing lives in `antipode-sequence.ts`.
 */

/** How see-through the globe goes. Enough to read the chord, not so much that the planet stops being a planet. */
const GLOBE_FRONT_FACE_ALPHA = 0.38;

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

/** The layer, plus the one thing pushed into it after it is built. */
export type AntipodeLayer = GlobeLayer & {
  /** What the catalogue recorded near the antipode, once the lookup lands. */
  setHits(hits: readonly AntipodalEvent[]): void;
};

const MAX_RING_KM = Math.max(...ANTIPODAL_RINGS_KM);

export function createAntipodeLayer(
  event: Pick<EarthquakeEvent, 'id' | 'latitude' | 'longitude'>,
  /**
   * What the catalogue recorded near this antipode inside H5's window, if it
   * is already known. Normally it is not, and arrives through `setHits`.
   */
  initialHits: readonly AntipodalEvent[] = [],
  now: () => number = () => performance.now(),
  /**
   * How long the chord waits before it starts — the camera's flight, when
   * there is one, so the line is not drawn while the view is still turning.
   */
  { flyMs = 0 }: { flyMs?: number } = {},
): AntipodeLayer {
  let viewer: Cesium.Viewer | null = null;
  let dataSource: Cesium.CustomDataSource | null = null;
  let visible = true;
  let hitEntityIds: string[] = [];

  /** Restored on unmount — the globe is shared, so this must be given back. */
  let previousTranslucencyEnabled = false;
  let previousFrontFaceAlpha = 1;

  const origin = Cesium.Cartesian3.fromDegrees(event.longitude, event.latitude);
  const target = antipodeOf({ latitude: event.latitude, longitude: event.longitude });
  const antipode = Cesium.Cartesian3.fromDegrees(target.longitude, target.latitude);

  const startedAt = now();
  const chordColor = Cesium.Color.fromCssColorString(CHORD_COLOR);
  const moment = () => antipodeMoment(now() - startedAt, MAX_RING_KM, flyMs);

  /**
   * The chord's far end, interpolated so the line grows out from the event.
   *
   * `Cartesian3.lerp` in earth-fixed space is exactly right here: the chord is
   * a straight line *through* the planet, so linear interpolation traces the
   * real path rather than an arc over the surface.
   */
  function chordPositions(): Cesium.Cartesian3[] {
    const tip = Cesium.Cartesian3.lerp(origin, antipode, moment().chord, new Cesium.Cartesian3());
    return [origin, tip];
  }

  /**
   * One ring's outline, following the front until it reaches its own radius.
   *
   * Cached on the rounded radius, because the callback runs every frame: once
   * the ripple has passed, a ring is the same array for the rest of the mode.
   */
  function ringPositions(ringKm: number): Cesium.CallbackProperty {
    let cachedKm = -1;
    let cached: Cesium.Cartesian3[] = [];
    return new Cesium.CallbackProperty(() => {
      const radius = ringRadiusKm(ringKm, moment().ringFrontKm);
      if (radius === null) return [];
      const rounded = Math.max(1, Math.round(radius));
      if (rounded !== cachedKm) {
        cachedKm = rounded;
        cached = circlePoints(target, rounded, 96).map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
      }
      return cached;
    }, false);
  }

  /** A hit shows once the ripple has reached it — nearest first, as it spreads. */
  function addHits(source: Cesium.CustomDataSource, hits: readonly AntipodalEvent[]): void {
    for (const id of hitEntityIds) source.entities.removeById(id);
    hitEntityIds = [];

    /**
     * Any events the catalogue recorded there inside the window.
     *
     * Marked, not interpreted. Measured across 714 declustered M7+ triggers,
     * these appear at 0.91× the rate the antipodes' own background predicts —
     * i.e. exactly chance — so a marker here means "one happened", never "one
     * was triggered". The panel carries the background rate that says so.
     */
    for (const hit of hits) {
      const reached = new Cesium.CallbackProperty(() => {
        const front = moment().ringFrontKm;
        // Past the widest ring the front never arrives; those show once it
        // has gone as far as it goes.
        return front !== null && front >= Math.min(hit.distanceKm, MAX_RING_KM);
      }, false);
      const id = `${antipodeEntityId(event.id)}::hit-${hit.event.id}`;
      hitEntityIds.push(id);
      source.entities.add({
        id,
        position: Cesium.Cartesian3.fromDegrees(hit.event.longitude, hit.event.latitude),
        point: {
          pixelSize: 12,
          color: Cesium.Color.TRANSPARENT,
          outlineColor: HIT_COLOR,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          show: reached,
        },
        label: {
          text: `M${hit.event.magnitude.toFixed(1)} +${hit.delayHours.toFixed(1)}h`,
          font: '11px system-ui, sans-serif',
          fillColor: HIT_COLOR,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -18),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          show: reached,
        },
      });
    }
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
    const arrived = new Cesium.CallbackProperty(() => moment().chord >= 1, false);

    target_.entities.add({
      id: `${antipodeEntityId(event.id)}::point`,
      position: antipode,
      point: {
        pixelSize: 10,
        color: Cesium.Color.TRANSPARENT,
        outlineColor: chordColor,
        outlineWidth: 2,
        // The camera turns 45°, which leaves the antipode on the far side of
        // the planet: without this the marker is hidden by the globe it is
        // being shown through.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        show: arrived,
      },
    });

    /**
     * Distance rings at the antipode — §5.3's 250/500/1000 km.
     *
     * **Readability only. These carry no statistical meaning**, and §5.3 is
     * emphatic about it: the registered H5 test uses the whole distance
     * distribution precisely so that no radius has to be guessed. They exist so
     * a human can see "that hit was inside 250 km" without measuring. The
     * ripple that draws them is presentation too — it is not a wave, and its
     * speed means nothing.
     *
     * **Polylines through points on the sphere, not `ellipse` outlines.** An
     * ellipse outline is one pixel wide on most GPUs and has no
     * `depthFailMaterial` — and the camera now ends 45° from the event, so the
     * rings sit on the far side and would be hidden by the planet. The same
     * choice the replay's P and S rings made.
     */
    for (const radiusKm of ANTIPODAL_RINGS_KM) {
      // Fainter as they widen, so the innermost reads as the tightest claim
      // and the outermost doesn't dominate the view.
      const alpha = radiusKm <= 250 ? 0.9 : radiusKm <= 500 ? 0.65 : 0.45;
      target_.entities.add({
        id: `${antipodeEntityId(event.id)}::ring-${String(radiusKm)}`,
        polyline: {
          positions: ringPositions(radiusKm),
          width: 1.5,
          arcType: Cesium.ArcType.GEODESIC,
          material: chordColor.withAlpha(alpha),
          // Seen through the planet, like the buried half of the chord.
          depthFailMaterial: chordColor.withAlpha(alpha * 0.8),
        },
      });
    }

    addHits(target_, initialHits);
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

    setHits(hits) {
      // Before mount there is no data source; `build` reads `initialHits`, so
      // a push that early would be lost. It does not happen: the effect that
      // pushes runs after the one that mounts.
      if (dataSource) addHits(dataSource, hits);
    },
  };
}
