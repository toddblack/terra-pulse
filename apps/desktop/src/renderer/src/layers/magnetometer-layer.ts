import * as Cesium from 'cesium';
import { STATION_DISTURBED_NT, type GlobeLayer, type MagnetometerReading } from '@terra-pulse/schema';

/**
 * Ground magnetometer observatories, sized by how disturbed they are.
 *
 * ## What the marks mean
 *
 * A ring per station, whose radius grows with the **range of the horizontal
 * field over the last hour**, in nT. Quiet sites sit at a few nT; a storm
 * drives hundreds. Stations that reported nothing in the window draw as a small
 * hollow dot — *no reading*, never as quiet, because an observatory that is
 * down during a storm is precisely the one a reader must not misread.
 *
 * ## Why the network looks sparse and northern
 *
 * It is. This is the USGS feed, the only free source that answers for *right
 * now*: INTERMAGNET's 138 stations serve definitive data only and embargo the
 * recent end — measured, every value comes back null inside the last few days.
 * So the live view is ~30 stations, 10 of them below 45 degrees latitude, and
 * measured against this app's catalogue only **7.5%** of M7+ events have one
 * within 500 km, against 21.3% for the full network.
 *
 * That is worth seeing rather than being told, which is part of why the layer
 * exists: the sparseness is the honest state of free real-time magnetometry.
 *
 * ## Why rings and not billboards
 *
 * An ellipse on the ellipsoid scales with the globe, so a disturbance stays
 * legible at every zoom without a distance-scaled billboard's popping. It also
 * reads as a *region affected* rather than a point measurement, which is closer
 * to what a magnetometer tells you — the disturbance is regional, the station
 * is just where it was sampled.
 */
export const MAGNETOMETER_LAYER_ID = 'magnetometers';

export interface MagnetometerLayer extends GlobeLayer {
  /** Pushes a newly-arrived network read. */
  setReadings(readings: readonly MagnetometerReading[]): void;
}

export function isMagnetometerLayer(layer: GlobeLayer): layer is MagnetometerLayer {
  return layer.id === MAGNETOMETER_LAYER_ID && 'setReadings' in layer;
}

/** Ring radius in metres for a quiet station, and for a strongly disturbed one. */
const MIN_RADIUS_M = 60_000;
const MAX_RADIUS_M = 420_000;

/**
 * The disturbance at which a ring reaches full size, in nT.
 *
 * Well above `STATION_DISTURBED_NT` so the emphasis threshold sits partway up
 * the scale rather than at its top — a station only *just* disturbed should
 * still have somewhere to grow.
 */
const SATURATION_NT = 300;

export function createMagnetometerLayer(
  initial: readonly MagnetometerReading[] = [],
): MagnetometerLayer {
  let viewer: Cesium.Viewer | null = null;
  let source: Cesium.CustomDataSource | null = null;
  let readings: readonly MagnetometerReading[] = initial;

  function radiusFor(rangeNt: number): number {
    // Square-rooted rather than linear: disturbance spans three orders of
    // magnitude, and a linear radius leaves every ordinary station an
    // indistinguishable dot next to one storm.
    const fraction = Math.min(Math.sqrt(rangeNt / SATURATION_NT), 1);
    return MIN_RADIUS_M + fraction * (MAX_RADIUS_M - MIN_RADIUS_M);
  }

  function rebuild(): void {
    if (!source) return;
    source.entities.removeAll();

    for (const { station, disturbance } of readings) {
      const position = Cesium.Cartesian3.fromDegrees(station.longitude, station.latitude);

      if (!disturbance) {
        // Reported nothing this window. A small hollow ring: present on the
        // map, visibly not carrying a value.
        source.entities.add({
          position,
          name: station.name,
          description: `${station.code} — no reading in the last hour`,
          ellipse: {
            semiMinorAxis: MIN_RADIUS_M,
            semiMajorAxis: MIN_RADIUS_M,
            material: Cesium.Color.TRANSPARENT,
            outline: true,
            outlineColor: Cesium.Color.fromCssColorString('#64748b').withAlpha(0.7),
            outlineWidth: 1,
            height: 0,
          },
        });
        continue;
      }

      const radius = radiusFor(disturbance.rangeNt);
      const disturbed = disturbance.rangeNt >= STATION_DISTURBED_NT;
      // The app's existing "this one is notable" red, as the quake stroke and
      // the storm bars already use. Quiet stations take the cyan the
      // magnetopause uses, so the two space-weather layers read as a family.
      const colour = disturbed
        ? Cesium.Color.fromCssColorString('#f87171')
        : Cesium.Color.fromCssColorString('#67e8f9');

      source.entities.add({
        position,
        name: station.name,
        description: `${station.code} — ${disturbance.rangeNt.toFixed(1)} nT over the last hour`,
        ellipse: {
          semiMinorAxis: radius,
          semiMajorAxis: radius,
          material: colour.withAlpha(0.18),
          outline: true,
          outlineColor: colour.withAlpha(0.85),
          outlineWidth: 1,
          height: 0,
        },
      });
    }
  }

  return {
    id: MAGNETOMETER_LAYER_ID,
    label: 'Magnetometers (live)',
    category: 'overlay',
    defaultVisible: false,

    mount(nextViewer) {
      viewer = nextViewer;
      source = new Cesium.CustomDataSource(MAGNETOMETER_LAYER_ID);
      void viewer.dataSources.add(source);
      rebuild();
    },

    unmount() {
      if (viewer && !viewer.isDestroyed() && source) viewer.dataSources.remove(source, true);
      source = null;
      viewer = null;
    },

    setTimeWindow() {
      // A deliberate no-op, for the same reason the aurora's is. This is the
      // last hour at ~30 stations and there is no stored history behind it, so
      // scrubbing to 1975 cannot show the magnetometers of 1975. The legend
      // says the layer does not follow the scrubber rather than leaving a
      // current reading on screen while the playhead sits in the past.
    },

    setVisible(next) {
      if (source) source.show = next;
    },

    setReadings(next) {
      readings = next;
      rebuild();
    },
  };
}
