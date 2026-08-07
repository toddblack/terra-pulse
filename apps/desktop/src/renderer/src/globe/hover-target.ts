/**
 * What the pointer is currently over, described in words.
 *
 * Pure and Cesium-free — it takes already-extracted records rather than pick
 * results — so the wording can be tested without a WebGL context. The Cesium
 * side (turning a `scene.pick()` result into one of these) lives in
 * `CesiumViewer`, and is the part that cannot be unit-tested here.
 */
import type { EarthquakeEvent } from '@terra-pulse/schema';
import { depthClass } from '../layers/earthquake-encoding';
import { formatSlipRate, formatSlipType, type FaultRecord } from '../layers/fault-association';
import { plateBoundaryLabel, plateClassLabel } from '../layers/plate-association';

export type HoverKind = 'earthquake' | 'fault' | 'boundary';

export interface HoverTarget {
  kind: HoverKind;
  /** The headline — what the thing is. */
  title: string;
  /** One line of supporting detail, or null when there is nothing to add. */
  detail: string | null;
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
