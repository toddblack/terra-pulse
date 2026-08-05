import { useEffect, useState } from 'react';
import {
  SEQUENCE_MIN_MAINSHOCK_MAGNITUDE,
  type AftershockSequence,
  type EarthquakeEvent,
} from '@terra-pulse/schema';

/**
 * Whether an event gets a sequence panel at all.
 *
 * §5.9's M5 threshold. Below it the Gardner-Knopoff radius is under 40 km and
 * the catalogue floor is M4.5, so the answer is nearly always "nothing
 * recorded" — which reads as a finding about the earthquake rather than as the
 * floor doing its job.
 */
export function hasSequencePanel(event: EarthquakeEvent | null): boolean {
  return event !== null && event.magnitude >= SEQUENCE_MIN_MAINSHOCK_MAGNITUDE;
}

export type SequenceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; sequence: AftershockSequence }
  | { status: 'error' };

/** A completed lookup, tagged with the event it describes. */
export interface SequenceResult {
  eventId: string;
  state: SequenceState;
}

/**
 * What the panel should show, given the selection and whatever has come back.
 *
 * Pure, and separated from the hook for the reason the rest of this codebase
 * separates such things: this package has no jsdom on purpose (see
 * `test-setup.ts`), so logic worth testing has to be testable without a DOM.
 * `event-list-window.ts` is the same shape.
 *
 * **The id comparison is the whole point.** Clicking through a dense cluster
 * fires overlapping IPC requests with no ordering guarantee, so an earlier,
 * slower reply can land last. Matching the stored result against the current
 * selection makes a stale reply unrenderable rather than merely unlikely —
 * without it the panel would show one earthquake's sequence under another's
 * heading, looking entirely normal while doing so.
 */
export function resolveSequenceState(
  eventId: string | null,
  eligible: boolean,
  result: SequenceResult | null,
): SequenceState {
  if (eventId === null || !eligible) return { status: 'idle' };
  return result !== null && result.eventId === eventId ? result.state : { status: 'loading' };
}

/**
 * Loads the observed sequence for the selected event.
 *
 * Fetched on selection rather than behind a button. Measured against the real
 * 307k-row catalogue the query is 0.7 ms at M5 and 9.6 ms at M7 — cheap enough
 * that a click to reveal would be pure friction. Only M8+ approaches 88 ms, and
 * the catalogue holds 44 of those in 57 years.
 *
 * **Stale responses are dropped, not rendered.** Clicking through a dense
 * cluster fires overlapping requests, and IPC gives no ordering guarantee — an
 * earlier, slower reply could otherwise land last and attach one event's
 * sequence to another's panel. The panel would look entirely normal while
 * describing the wrong earthquake.
 */
export function useAftershockSequence(event: EarthquakeEvent | null): SequenceState {
  const eventId = event?.id ?? null;
  const eligible = hasSequencePanel(event);

  /** Stored against the id it describes — see `resolveSequenceState`. */
  const [result, setResult] = useState<SequenceResult | null>(null);

  useEffect(() => {
    if (eventId === null || !eligible) return;

    window.terraPulse.earthquakes.sequence(eventId).then(
      (sequence) => {
        setResult({
          eventId,
          state: sequence === null ? { status: 'error' } : { status: 'ready', sequence },
        });
      },
      (error: unknown) => {
        // Swallowed to a state rather than thrown: a failed sequence lookup must
        // not take the inspector — or the event's own details — down with it.
        // The panel simply says it couldn't read the catalogue.
        console.error('Aftershock sequence lookup failed', error);
        setResult({ eventId, state: { status: 'error' } });
      },
    );
  }, [eventId, eligible]);

  // Derived rather than set from the effect. Both 'idle' and 'loading' are
  // facts about the current props and the stored result, so writing them as
  // state would mean a second render pass to reach a conclusion already known
  // at render time.
  return resolveSequenceState(eventId, eligible, result);
}
