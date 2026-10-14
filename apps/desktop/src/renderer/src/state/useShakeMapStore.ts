import { create } from 'zustand';
import {
  shakeMapEligible,
  type EarthquakeEvent,
  type ShakeMapContours,
} from '@terra-pulse/schema';

/** What came back for one quake. `error` is "USGS could not be reached". */
export type ShakeMapOutcome =
  | { status: 'available'; map: ShakeMapContours }
  | { status: 'none' }
  | { status: 'error' };

interface ShakeMapState {
  /**
   * Whether the shaking lines are switched on.
   *
   * **A standing preference, not a property of one quake.** Turned on, it
   * stays on as the selection moves, so every large quake picked afterwards
   * shows its lines — the same idea as the inspector's sections remembering
   * that they are open. Off by default and not saved between launches, so the
   * app never talks to USGS about a selection until someone asked it to.
   */
  enabled: boolean;

  /**
   * Bumped each time the lines are switched on by hand.
   *
   * The globe frames the lines when this moves and at no other time: pressing
   * the button is a request to look at them, while merely selecting the next
   * quake with the lines already on is not a request to have the zoom changed.
   */
  frameRequest: number;

  /** The id most recently asked for — what a late reply is checked against. */
  wantedEventId: string | null;

  /**
   * The answer in hand, **stored against the quake it describes**.
   *
   * Clicking through a list fires overlapping requests with no ordering
   * guarantee. Keyed like this, one quake's lines cannot be drawn around
   * another — `shakeMapView` compares the id before it hands anything out.
   */
  loaded: { eventId: string; outcome: ShakeMapOutcome } | null;

  setEnabled: (enabled: boolean) => void;
  load: (eventId: string) => Promise<void>;
}

export const useShakeMapStore = create<ShakeMapState>((set, get) => ({
  enabled: false,
  frameRequest: 0,
  wantedEventId: null,
  loaded: null,

  setEnabled: (enabled) =>
    set((state) => ({
      enabled,
      frameRequest: enabled ? state.frameRequest + 1 : state.frameRequest,
    })),

  load: async (eventId) => {
    set({ wantedEventId: eventId });

    let outcome: ShakeMapOutcome;
    try {
      outcome = await window.terraPulse.shakeMap.contours(eventId);
    } catch (error: unknown) {
      console.error('Could not fetch the ShakeMap', error);
      outcome = { status: 'error' };
    }

    // A slower reply for an earlier quake must not replace the answer for the
    // one now selected. Without this the newer quake would sit on "loading"
    // for good: its own reply already came and went.
    if (get().wantedEventId !== eventId) return;
    set({ loaded: { eventId, outcome } });
  },
}));

export type ShakeMapView =
  /** The lines are switched off. */
  | { status: 'off' }
  /** Switched on, but this quake is too small or not from USGS. */
  | { status: 'ineligible' }
  | { status: 'loading' }
  | { status: 'available'; map: ShakeMapContours }
  | { status: 'none' }
  | { status: 'error' };

/**
 * What to show for the selected quake, given the switch and whatever came
 * back. Pure, so it is tested here without a DOM.
 *
 * `available` is only ever returned with the *selected* quake's own map.
 */
export function shakeMapView(
  enabled: boolean,
  event: Pick<EarthquakeEvent, 'id' | 'magnitude' | 'source'> | null,
  loaded: { eventId: string; outcome: ShakeMapOutcome } | null,
): ShakeMapView {
  if (!enabled || event === null) return { status: 'off' };
  if (!shakeMapEligible(event)) return { status: 'ineligible' };
  if (loaded === null || loaded.eventId !== event.id) return { status: 'loading' };
  return loaded.outcome;
}
