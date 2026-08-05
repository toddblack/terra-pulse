import { describe, expect, it, vi } from 'vitest';
import type { EarthquakeEvent } from '@terra-pulse/schema';
import { createLargeEventAlerter, selectAlert } from './large-event-alerts';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function makeEvent(overrides: Partial<EarthquakeEvent> = {}): EarthquakeEvent {
  return {
    id: 'us0001',
    source: 'usgs',
    magnitude: 6.4,
    magnitudeType: 'mww',
    place: '10km SSW of Somewhere',
    timeUtc: new Date(NOW - 5 * MINUTE).toISOString(),
    updatedUtc: new Date(NOW - 2 * MINUTE).toISOString(),
    longitude: -112.14,
    latitude: 36.05,
    depthKm: 10,
    status: 'reviewed',
    tsunami: false,
    alertLevel: null,
    significance: 700,
    url: 'https://example.test',
    ...overrides,
  };
}

const RULES = {
  minMagnitude: 6,
  maxAgeMs: HOUR,
  nowMs: NOW,
  alreadyAlerted: new Set<string>(),
};

describe('selectAlert', () => {
  it('announces a fresh event at or above the threshold', () => {
    expect(selectAlert([makeEvent()], RULES)?.id).toBe('us0001');
    expect(selectAlert([makeEvent({ magnitude: 6 })], RULES)?.id).toBe('us0001');
  });

  it('ignores anything below the threshold', () => {
    expect(selectAlert([makeEvent({ magnitude: 5.9 })], RULES)).toBeNull();
  });

  it('ignores an event older than the freshness bound', () => {
    // The first poll after launch pulls a 24-hour feed. An M6 from yesterday is
    // new *to us* without being news, and announcing it would claim something
    // just happened when it didn't.
    const stale = makeEvent({ timeUtc: new Date(NOW - 3 * HOUR).toISOString() });
    expect(selectAlert([stale], RULES)).toBeNull();
  });

  it('keeps an event exactly on the freshness boundary', () => {
    const edge = makeEvent({ timeUtc: new Date(NOW - HOUR).toISOString() });
    expect(selectAlert([edge], RULES)?.id).toBe('us0001');
  });

  it('announces a future-dated event rather than discarding it', () => {
    // Clock skew between USGS and this machine puts the newest events slightly
    // ahead. Those are the ones most worth announcing.
    const skewed = makeEvent({ timeUtc: new Date(NOW + 2 * MINUTE).toISOString() });
    expect(selectAlert([skewed], RULES)?.id).toBe('us0001');
  });

  it('skips an already-announced event', () => {
    const rules = { ...RULES, alreadyAlerted: new Set(['us0001']) };
    expect(selectAlert([makeEvent()], rules)).toBeNull();
  });

  it('picks the newest when several qualify', () => {
    // One slot, so the batch has to resolve to a single event. The newest is
    // the one still unfolding.
    const events = [
      makeEvent({ id: 'older', timeUtc: new Date(NOW - 30 * MINUTE).toISOString() }),
      makeEvent({ id: 'newest', timeUtc: new Date(NOW - 1 * MINUTE).toISOString() }),
      makeEvent({ id: 'middle', timeUtc: new Date(NOW - 10 * MINUTE).toISOString() }),
    ];

    expect(selectAlert(events, RULES)?.id).toBe('newest');
  });

  it('ignores an unparseable timestamp instead of treating it as fresh', () => {
    expect(selectAlert([makeEvent({ timeUtc: 'not a date' })], RULES)).toBeNull();
  });

  it('returns null for an empty batch, which is a normal quiet poll', () => {
    expect(selectAlert([], RULES)).toBeNull();
  });
});

describe('createLargeEventAlerter', () => {
  function alerter(onAlert?: (event: EarthquakeEvent) => void) {
    return createLargeEventAlerter(
      { minMagnitude: 6, maxAgeMs: HOUR, onAlert },
      () => NOW,
    );
  }

  it('announces an event once, however many polls carry it', () => {
    // USGS returns the same event in every poll for hours. Without this the
    // banner would reappear every five minutes for the same earthquake.
    const alerts = alerter();

    expect(alerts.consider([makeEvent()])?.id).toBe('us0001');
    expect(alerts.consider([makeEvent()])).toBeNull();
    expect(alerts.consider([makeEvent()])).toBeNull();
  });

  it('announces an event that crosses the threshold on revision', () => {
    // The trap that makes this track *alerted* rather than *seen*. USGS revises
    // magnitudes: an M5.8 arrives below the bar, and the same event comes back
    // as M6.1 an hour later. Recording everything seen would swallow exactly
    // the events that grew into being worth announcing.
    const alerts = alerter();

    expect(alerts.consider([makeEvent({ magnitude: 5.8 })])).toBeNull();
    expect(alerts.consider([makeEvent({ magnitude: 6.1 })])?.id).toBe('us0001');
  });

  it('still announces a different event after one has fired', () => {
    const alerts = alerter();
    alerts.consider([makeEvent({ id: 'first' })]);

    expect(alerts.consider([makeEvent({ id: 'second' })])?.id).toBe('second');
  });

  it('calls onAlert once per announced event', () => {
    const onAlert = vi.fn();
    const alerts = alerter(onAlert);

    alerts.consider([makeEvent()]);
    alerts.consider([makeEvent()]);

    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0]?.[0]).toMatchObject({ id: 'us0001' });
  });

  it('does not re-announce when a listener throws', () => {
    // Recorded before notifying, so a broken listener can't turn one
    // earthquake into an alert on every subsequent poll.
    const alerts = alerter(() => {
      throw new Error('listener exploded');
    });

    expect(() => alerts.consider([makeEvent()])).toThrow();
    expect(alerts.consider([makeEvent()])).toBeNull();
  });
});
