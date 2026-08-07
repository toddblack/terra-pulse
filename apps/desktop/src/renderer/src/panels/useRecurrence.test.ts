import { describe, expect, it } from 'vitest';
import type { RegionalRecurrence } from '@terra-pulse/schema';
import {
  recurrenceKey,
  resolveRecurrenceState,
  type RecurrenceRequest,
  type RecurrenceResult,
} from './useRecurrence';

const request = (over: Partial<RecurrenceRequest> = {}): RecurrenceRequest => ({
  latitude: 35.68,
  longitude: 139.77,
  radiusKm: 300,
  minMagnitude: 6,
  ...over,
});

const recurrenceFor = (independentCount: number): RegionalRecurrence => ({
  summary: {
    radiusKm: 300,
    minMagnitude: 6,
    rawCount: independentCount,
    independentCount,
    intervalsYears: [],
    medianYears: null,
    shortestYears: null,
    longestYears: null,
    sinceLastYears: null,
    observedYears: 56,
    epochYear: 1970,
  },
  independent: [],
  archiveComplete: true,
});

describe('recurrenceKey', () => {
  it('is stable for the same request', () => {
    expect(recurrenceKey(request())).toBe(recurrenceKey(request()));
  });

  it.each([
    ['radius', { radiusKm: 100 }],
    ['floor', { minMagnitude: 7 }],
    ['latitude', { latitude: 34 }],
    ['longitude', { longitude: 140 }],
  ])('changes when the %s changes', (_label, over) => {
    expect(recurrenceKey(request(over))).not.toBe(recurrenceKey(request()));
  });

  /**
   * Coordinates round to ~1 m. Floating-point noise in the same coordinate must
   * not invalidate an answer the user is already looking at, and a difference
   * nobody can see is not worth a 200 ms re-query.
   */
  it('ignores differences below a metre', () => {
    expect(recurrenceKey(request({ latitude: 35.680000001 }))).toBe(recurrenceKey(request()));
  });
});

describe('resolveRecurrenceState', () => {
  it('is loading before anything comes back', () => {
    expect(resolveRecurrenceState(request(), null).status).toBe('loading');
  });

  it('shows a result matching the current request', () => {
    const result: RecurrenceResult = {
      key: recurrenceKey(request()),
      state: { status: 'ready', recurrence: recurrenceFor(64) },
    };
    const state = resolveRecurrenceState(request(), result);
    expect(state.status).toBe('ready');
    expect(state.status === 'ready' && state.recurrence.summary.independentCount).toBe(64);
  });

  /**
   * The race this closes. Changing the radius fires a new query while the old
   * one is in flight, and IPC gives no ordering guarantee — so an answer for
   * "300 km" could otherwise land under a heading now reading "100 km", looking
   * entirely correct while describing a different question.
   */
  it('ignores a reply for a different radius', () => {
    const stale: RecurrenceResult = {
      key: recurrenceKey(request({ radiusKm: 300 })),
      state: { status: 'ready', recurrence: recurrenceFor(64) },
    };
    expect(resolveRecurrenceState(request({ radiusKm: 100 }), stale).status).toBe('loading');
  });

  it('ignores a reply for a different magnitude floor', () => {
    const stale: RecurrenceResult = {
      key: recurrenceKey(request({ minMagnitude: 6 })),
      state: { status: 'ready', recurrence: recurrenceFor(64) },
    };
    expect(resolveRecurrenceState(request({ minMagnitude: 7 }), stale).status).toBe('loading');
  });

  it('ignores a reply for a different place', () => {
    const stale: RecurrenceResult = {
      key: recurrenceKey(request()),
      state: { status: 'ready', recurrence: recurrenceFor(64) },
    };
    expect(resolveRecurrenceState(request({ latitude: -33.45 }), stale).status).toBe('loading');
  });

  it('surfaces an error only for the request it belongs to', () => {
    const failed: RecurrenceResult = { key: recurrenceKey(request()), state: { status: 'error' } };
    expect(resolveRecurrenceState(request(), failed).status).toBe('error');
    expect(resolveRecurrenceState(request({ radiusKm: 500 }), failed).status).toBe('loading');
  });
});
