import { useEffect, useState } from 'react';
import type { RegionalRecurrence } from '@terra-pulse/schema';

export type RecurrenceState =
  | { status: 'loading' }
  | { status: 'ready'; recurrence: RegionalRecurrence }
  | { status: 'error' };

/** A completed lookup, tagged with the request that produced it. */
export interface RecurrenceResult {
  key: string;
  state: RecurrenceState;
}

export interface RecurrenceRequest {
  latitude: number;
  longitude: number;
  radiusKm: number;
  minMagnitude: number;
}

/**
 * Identity of a request, for matching a reply to the question that asked it.
 *
 * Coordinates are rounded to ~1 m. Without rounding, a selected event and a
 * probe click at visually the same place produce different keys and re-query for
 * a difference no one can see; with it, floating-point noise in the same
 * coordinate cannot invalidate a cached answer.
 */
export function recurrenceKey(request: RecurrenceRequest): string {
  return [
    request.latitude.toFixed(5),
    request.longitude.toFixed(5),
    request.radiusKm,
    request.minMagnitude,
  ].join('|');
}

/**
 * What the panel should show, given the current request and whatever came back.
 *
 * Pure, and separated from the hook because this package deliberately has no
 * jsdom (see `test-setup.ts`) — the same split `useAftershockSequence` uses.
 *
 * **The key comparison is what makes a stale reply unrenderable.** Changing the
 * radius or floor fires a new query while the previous one is still in flight,
 * and IPC promises no ordering. Matching on the request key means an answer to
 * "M6 within 300 km" can never be displayed under a heading that now says
 * "M7 within 100 km" — a mismatch that would look completely normal on screen.
 */
export function resolveRecurrenceState(
  request: RecurrenceRequest,
  result: RecurrenceResult | null,
): RecurrenceState {
  const key = recurrenceKey(request);
  return result !== null && result.key === key ? result.state : { status: 'loading' };
}

/**
 * Loads observed recurrence for a region.
 *
 * Measured against the real 307k-row catalogue: 32–294 ms depending on how many
 * events fall in the region, with the worst realistic case (500 km at M5.5, 783
 * raw events) at 197 ms. Declustering is O(n²) and dominates. That is fine for a
 * click and for changing a selector; it would not be fine on a drag.
 */
export function useRecurrence(request: RecurrenceRequest | null): RecurrenceState {
  const key = request === null ? null : recurrenceKey(request);
  const [result, setResult] = useState<RecurrenceResult | null>(null);

  const { latitude, longitude, radiusKm, minMagnitude } = request ?? {
    latitude: 0,
    longitude: 0,
    radiusKm: 0,
    minMagnitude: 0,
  };

  useEffect(() => {
    if (key === null) return;

    window.terraPulse.earthquakes
      .recurrence({ latitude, longitude, radiusKm, minMagnitude })
      .then(
        (recurrence) => {
          setResult({ key, state: { status: 'ready', recurrence } });
        },
        (error: unknown) => {
          // A failed lookup must not take the panel around it down.
          console.error('Recurrence lookup failed', error);
          setResult({ key, state: { status: 'error' } });
        },
      );
  }, [key, latitude, longitude, radiusKm, minMagnitude]);

  if (request === null) return { status: 'loading' };
  return resolveRecurrenceState(request, result);
}
