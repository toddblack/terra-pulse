/**
 * What the pointer is currently over, described in words.
 *
 * Pure and Cesium-free — it takes already-extracted records rather than pick
 * results — so the wording can be tested without a WebGL context. The Cesium
 * side (turning a `scene.pick()` result into one of these) lives in
 * `CesiumViewer`, and is the part that cannot be unit-tested here.
 */
import {
  STATION_DISTURBED_NT,
  type EarthquakeEvent,
  type MagnetometerReading,
} from '@terra-pulse/schema';
import { depthClass } from '../layers/earthquake-encoding';
import { formatSlipRate, formatSlipType, type FaultRecord } from '../layers/fault-association';
import { plateBoundaryLabel, plateClassLabel } from '../layers/plate-association';

export type HoverKind = 'earthquake' | 'fault' | 'boundary' | 'magnetometer';

export interface HoverTarget {
  kind: HoverKind;
  /** The headline — what the thing is. */
  title: string;
  /** One line of supporting detail, or null when there is nothing to add. */
  detail: string | null;
  /**
   * When it happened, for the things that happened at a time.
   *
   * The **instant**, not a formatted age. Turning it into "3h ago" needs a
   * clock, and reading one here would freeze the answer at the moment the
   * pointer moved — so the tooltip formats it against `useNow`, which is also
   * the rule the rest of the app follows. Null for faults and plate
   * boundaries, which are features rather than events. A magnetometer reading
   * carries its own instant — `observedAtUtc` — when it has one.
   */
  timeUtc: string | null;
}

/** Magnitude and place — what a reader wants before deciding to click. */
export function describeEarthquake(event: EarthquakeEvent): HoverTarget {
  const depth =
    event.depthKm === null ? 'depth not reported' : `${Math.round(event.depthKm)} km · ${depthClass(event.depthKm)}`;
  return {
    kind: 'earthquake',
    title: `M${event.magnitude.toFixed(1)}`,
    // Place can be long ("281 km SSE of Kamaishi, Japan"); the tooltip's CSS
    // truncates rather than wrapping to three lines under the pointer.
    detail: `${event.place} · ${depth}`,
    timeUtc: event.timeUtc,
  };
}

/**
 * A fault, led by whatever is actually populated.
 *
 * **Name last, deliberately.** Only 44.6% of GEM faults carry a name and just
 * 21% of the traces nearest real M6+ events do, so a tooltip that leads with the
 * name reads "unnamed fault" on most hovers and looks broken. Kinematics (97.7%)
 * and slip rate (74.1%) are the fields that are nearly always there, and they
 * are what makes an unnamed trace still worth hovering.
 */
export function describeFault(fault: FaultRecord): HoverTarget {
  const kinematics = formatSlipType(fault.t);
  const slipRate = formatSlipRate(fault);

  const parts = [kinematics, slipRate].filter((part): part is string => part !== null);

  return {
    kind: 'fault',
    title: fault.n ?? 'Unnamed fault',
    detail: parts.length > 0 ? parts.join(' · ') : null,
    // A mapped trace is not an event and has no "ago".
    timeUtc: null,
  };
}

/**
 * A plate boundary: the plate pair and what kind of boundary it is.
 *
 * Subduction polarity is not stated — see `plateBoundaryLabel` for why guessing
 * which plate goes under would be a confident false claim.
 */
export function describeBoundary(pair: string, boundaryClass: string): HoverTarget {
  return {
    kind: 'boundary',
    title: plateBoundaryLabel(pair),
    detail: plateClassLabel(boundaryClass),
    timeUtc: null,
  };
}

/**
 * A magnetometer station: how disturbed it is, or that it reported nothing.
 *
 * Leads with the station name rather than the code — the code ("BRW") means
 * nothing on its own, the name ("Barrow") does. `STATION_DISTURBED_NT` is
 * display emphasis only, same caveat as everywhere else it's used: it isn't
 * H4b's registered per-station trigger, just what makes a reading worth
 * calling out in a tooltip.
 */
export function describeMagnetometer(reading: MagnetometerReading): HoverTarget {
  const { station, disturbance } = reading;

  if (disturbance === null) {
    return {
      kind: 'magnetometer',
      title: station.name,
      detail: `${station.code} · no reading in the last hour`,
      // Nothing was reported, so there is no instant to be an age of.
      timeUtc: null,
    };
  }

  const disturbed = disturbance.rangeNt >= STATION_DISTURBED_NT;
  return {
    kind: 'magnetometer',
    title: station.name,
    detail: `${station.code} · ${disturbance.rangeNt.toFixed(1)} nT range${
      disturbed ? ' · disturbed' : ''
    }`,
    timeUtc: disturbance.observedAtUtc,
  };
}

/**
 * The cursor for a hover state.
 *
 * `pointer` for anything clickable, the Cesium default otherwise. This is the
 * affordance the globe has been missing: nothing on screen currently signals
 * that a dot or a line will respond to a click.
 */
export function cursorForHover(target: HoverTarget | null): string {
  return target === null ? '' : 'pointer';
}
