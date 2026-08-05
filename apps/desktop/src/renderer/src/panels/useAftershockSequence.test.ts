import { describe, expect, it } from 'vitest';
import type { AftershockSequence, EarthquakeEvent } from '@terra-pulse/schema';
import { SEQUENCE_MIN_MAINSHOCK_MAGNITUDE } from '@terra-pulse/schema';
import {
  hasSequencePanel,
  resolveSequenceState,
  type SequenceResult,
} from './useAftershockSequence';

function makeEvent(magnitude: number): EarthquakeEvent {
  return {
    id: 'evt',
    source: 'usgs',
    magnitude,
    magnitudeType: 'mww',
    place: 'somewhere',
    timeUtc: '2020-01-01T00:00:00.000Z',
    updatedUtc: '2020-01-01T00:00:00.000Z',
    longitude: 0,
    latitude: 0,
    depthKm: 10,
    status: 'reviewed',
    tsunami: false,
    alertLevel: null,
    significance: null,
    url: 'https://example.test',
  };
}

const sequenceFor = (count: number): AftershockSequence => ({
  summary: {
    radiusKm: 70,
    windowDays: 918,
    minMagnitude: 4.5,
    count,
    largest: null,
    largestAfterHours: null,
    exceededMainshock: false,
    elapsedFraction: 1,
    bins: [],
  },
  missingYears: [],
});

describe('hasSequencePanel', () => {
  it('offers the panel at and above the §5.9 threshold', () => {
    expect(hasSequencePanel(makeEvent(SEQUENCE_MIN_MAINSHOCK_MAGNITUDE))).toBe(true);
    expect(hasSequencePanel(makeEvent(7.2))).toBe(true);
  });

  it('withholds it below, where the answer would be structurally zero', () => {
    expect(hasSequencePanel(makeEvent(4.9))).toBe(false);
    expect(hasSequencePanel(makeEvent(2.1))).toBe(false);
  });

  it('handles no selection', () => {
    expect(hasSequencePanel(null)).toBe(false);
  });
});

describe('resolveSequenceState', () => {
  it('is idle with nothing selected', () => {
    expect(resolveSequenceState(null, false, null).status).toBe('idle');
  });

  it('is idle for an event too small to have a panel', () => {
    expect(resolveSequenceState('evt', false, null).status).toBe('idle');
  });

  it('is loading before anything comes back', () => {
    expect(resolveSequenceState('evt', true, null).status).toBe('loading');
  });

  it('shows the result once it matches the selection', () => {
    const result: SequenceResult = {
      eventId: 'evt',
      state: { status: 'ready', sequence: sequenceFor(12) },
    };
    const state = resolveSequenceState('evt', true, result);
    expect(state.status).toBe('ready');
    expect(state.status === 'ready' && state.sequence.summary.count).toBe(12);
  });

  /**
   * The race this function exists to close. Click A, click B, and A's slower
   * reply lands last — IPC promises no ordering. Rendering it would put A's
   * sequence under B's heading with nothing on screen looking wrong.
   */
  it('ignores a reply for a different event and keeps loading', () => {
    const staleFromA: SequenceResult = {
      eventId: 'event-a',
      state: { status: 'ready', sequence: sequenceFor(999) },
    };
    expect(resolveSequenceState('event-b', true, staleFromA).status).toBe('loading');
  });

  it('goes back to loading when the selection moves on from a shown result', () => {
    const shown: SequenceResult = {
      eventId: 'event-a',
      state: { status: 'ready', sequence: sequenceFor(3) },
    };
    expect(resolveSequenceState('event-a', true, shown).status).toBe('ready');
    expect(resolveSequenceState('event-c', true, shown).status).toBe('loading');
  });

  it('surfaces an error only for the event it belongs to', () => {
    const failed: SequenceResult = { eventId: 'event-a', state: { status: 'error' } };
    expect(resolveSequenceState('event-a', true, failed).status).toBe('error');
    expect(resolveSequenceState('event-b', true, failed).status).toBe('loading');
  });
});
