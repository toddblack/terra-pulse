/**
 * What a left click on the globe means, decided apart from Cesium so the rules
 * are tests rather than a branch buried in an event handler.
 *
 * The order is the whole design:
 *
 * 1. **The fault probe wins.** It is an explicit mode the reader switched on,
 *    and it reads the globe *surface* — "what is mapped here" about a spot that
 *    happens to have a dot on it is still a question about the spot.
 * 2. **Anything with a panel of its own opens it** — a fault or boundary, a
 *    flare or CME arrival, an earthquake. This holds with the waveform tab
 *    showing too, and that is the reason waveforms stopped being a mode: the
 *    mode turned every click into a station pick, so nothing could be
 *    inspected while traces were on screen.
 * 3. **A click that would only deselect** picks a spot for stations, when the
 *    dock is on its waveform tab (open or minimised — see `ClickModes`). In
 *    Explore a bare-globe click means "deselect",
 *    and it still does — it just also re-aims the stations. That is the one
 *    click with nothing else to say, so overloading it surprises nobody.
 * 4. **A fault or boundary click also picks**, at the same point. The location
 *    panel already answers for *where the pointer was*, not the feature's
 *    centroid, so both answers are about one spot. And without it, picking
 *    barely worked where it matters most: around Burbank at regional zoom,
 *    nearly every pixel lands on a mapped fault trace.
 *
 * A click on an earthquake no longer re-aims the stations, as it did in the
 * mode. Inspecting a quake in Japan must not tear down a stream from home; the
 * inspector offers "Stations near this quake" for when that is the question.
 */

export interface ResolvedClick {
  eventId: string | null;
  /** A fault or plate boundary was hit. */
  hasFeature: boolean;
  /** A flare or CME arrival marker was hit. */
  hasSolarEvent: boolean;
}

export type ClickRoute =
  | { kind: 'probe' }
  /** A fault or boundary: open the location panel, and re-aim the stations if asked. */
  | { kind: 'location'; pickStations: boolean }
  | { kind: 'solar-event' }
  | { kind: 'select'; eventId: string }
  /** Nothing selectable was hit: deselect, and re-aim the stations if asked. */
  | { kind: 'deselect'; pickStations: boolean };

export interface ClickModes {
  faultProbeActive: boolean;
  /**
   * Waveforms is the dock's tab — showing, or minimised with waveforms last
   * open. A pick from a minimised dock reopens it (the caller does that), so
   * the new stations land on screen rather than out of sight. On the timeline
   * tab, clicks are plain Explore.
   */
  waveformsPicking: boolean;
}

export function routeGlobeClick(resolved: ResolvedClick | null, modes: ClickModes): ClickRoute {
  if (modes.faultProbeActive) return { kind: 'probe' };
  if (resolved?.hasFeature === true) return { kind: 'location', pickStations: modes.waveformsPicking };
  if (resolved?.hasSolarEvent === true) return { kind: 'solar-event' };
  if (resolved?.eventId != null) return { kind: 'select', eventId: resolved.eventId };
  return { kind: 'deselect', pickStations: modes.waveformsPicking };
}
