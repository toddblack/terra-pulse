import { useEffect, useState } from 'react';
import {
  ANTIPODAL_TRIGGER_MIN_MAGNITUDE,
  type AntipodalWindow,
  type EarthquakeEvent,
} from '@terra-pulse/schema';

/**
 * Whether an event is large enough for an antipodal panel.
 *
 * §5.3's analysis floor. The *visualisation* has no threshold — drawing a
 * coordinate makes no claim — but anything that counts events does, because
 * below M6 the focused energy is negligible and the candidate pool is noise.
 */
export function hasAntipodalPanel(event: EarthquakeEvent | null): boolean {
  return event !== null && event.magnitude >= ANTIPODAL_TRIGGER_MIN_MAGNITUDE;
}

export type AntipodalState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; window: AntipodalWindow }
  | { status: 'error' };

/** A completed lookup, tagged with the event it describes. */
export interface AntipodalResult {
  eventId: string;
  state: AntipodalState;
}

/**
 * What the panel should show, given the selection and whatever came back.
 *
 * Pure and separate from the hook, because this package has no jsdom by design
 * (see `test-setup.ts`) — the same split `useAftershockSequence` uses.
 *
 * **The id comparison is the whole point.** Clicking through a cluster fires
 * overlapping IPC requests with no ordering guarantee, so an earlier, slower
 * reply can land last. Matching against the current selection makes a stale
 * reply unrenderable rather than merely unlikely — otherwise one event's
 * antipode appears under another's heading, looking entirely normal.
 */
export function resolveAntipodalState(
  eventId: string | null,
  eligible: boolean,
  result: AntipodalResult | null,
): AntipodalState {
  if (eventId === null || !eligible) return { status: 'idle' };
  return result !== null && result.eventId === eventId ? result.state : { status: 'loading' };
}

/** Loads the antipodal window for the selected event. */
export function useAntipodal(event: EarthquakeEvent | null): AntipodalState {
  const eventId = event?.id ?? null;
  const eligible = hasAntipodalPanel(event);

  const [result, setResult] = useState<AntipodalResult | null>(null);

  useEffect(() => {
    if (eventId === null || !eligible) return;

    window.terraPulse.earthquakes.antipodal(eventId).then(
      (antipodal) => {
        setResult({
          eventId,
          state: antipodal === null ? { status: 'error' } : { status: 'ready', window: antipodal },
        });
      },
      (error: unknown) => {
        // Swallowed to a state: a failed lookup must not take the inspector down.
        console.error('Antipodal lookup failed', error);
        setResult({ eventId, state: { status: 'error' } });
      },
    );
  }, [eventId, eligible]);

  // Derived rather than set from the effect. 'idle' and 'loading' are facts
  // about the current props and the stored result, so writing them as state
  // would mean a second render pass to reach a conclusion already known.
  return resolveAntipodalState(eventId, eligible, result);
}
