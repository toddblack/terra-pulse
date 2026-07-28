import { describe, expect, it } from 'vitest';
import type { EarthquakeEvent } from '@terra-pulse/schema';
import { filterEarthquakes } from './useVisibleEarthquakes';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');

function makeEvent(overrides: Partial<EarthquakeEvent> = {}): EarthquakeEvent {
  return {
    id: 'us0001',
    source: 'usgs',
    magnitude: 5.2,
    magnitudeType: 'mb',
    place: '10km SSW of Somewhere',
    timeUtc: '2026-07-28T11:00:00.000Z',
    updatedUtc: '2026-07-28T11:05:00.000Z',
    longitude: -112.14,
    latitude: 36.05,
    depthKm: 10,
    status: 'reviewed',
    tsunami: false,
    alertLevel: null,
    significance: 400,
    url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us0001',
    ...overrides,
  };
}

/** Hours before NOW, as an ISO string. */
function hoursAgo(hours: number): string {
  return new Date(NOW - hours * 60 * 60 * 1000).toISOString();
}

describe('filterEarthquakes — magnitude floor', () => {
  it('is inclusive at the boundary', () => {
    // A user selecting M4+ expects to see the M4.0 events, not just M4.1+.
    const events = [
      makeEvent({ id: 'exactly', magnitude: 4 }),
      makeEvent({ id: 'below', magnitude: 3.99 }),
      makeEvent({ id: 'above', magnitude: 4.01 }),
    ];

    const visible = filterEarthquakes(events, 4, 72, NOW);

    expect(visible.map((e) => e.id).sort()).toEqual(['above', 'exactly']);
  });

  it('lets everything through at the lowest floor', () => {
    const events = [makeEvent({ magnitude: 1 }), makeEvent({ id: 'b', magnitude: 7 })];
    expect(filterEarthquakes(events, 1, 72, NOW)).toHaveLength(2);
  });

  it('returns an empty array when nothing qualifies, not everything', () => {
    // Regression guard: a filter that returns the full set on no matches
    // would look like it worked while showing the wrong data.
    const events = [makeEvent({ magnitude: 2 })];
    expect(filterEarthquakes(events, 5, 72, NOW)).toEqual([]);
  });
});

describe('filterEarthquakes — time window', () => {
  it('keeps events inside the window and drops older ones', () => {
    const events = [
      makeEvent({ id: 'recent', timeUtc: hoursAgo(1) }),
      makeEvent({ id: 'edge', timeUtc: hoursAgo(23) }),
      makeEvent({ id: 'old', timeUtc: hoursAgo(30) }),
    ];

    const visible = filterEarthquakes(events, 1, 24, NOW);

    expect(visible.map((e) => e.id).sort()).toEqual(['edge', 'recent']);
  });

  it('measures the window from now, not from the newest event', () => {
    // If the catalogue went stale, a 24h window must still mean "the last 24
    // hours" and legitimately come back empty — not "the newest 24 hours of
    // whatever we happen to have".
    const events = [makeEvent({ timeUtc: hoursAgo(100) })];
    expect(filterEarthquakes(events, 1, 24, NOW)).toEqual([]);
  });

  it('widens correctly as the window grows', () => {
    const events = [
      makeEvent({ id: 'h12', timeUtc: hoursAgo(12) }),
      makeEvent({ id: 'h40', timeUtc: hoursAgo(40) }),
      makeEvent({ id: 'h90', timeUtc: hoursAgo(90) }),
    ];

    expect(filterEarthquakes(events, 1, 24, NOW)).toHaveLength(1);
    expect(filterEarthquakes(events, 1, 48, NOW)).toHaveLength(2);
    expect(filterEarthquakes(events, 1, 96, NOW)).toHaveLength(3);
  });

  it('excludes an event with an unparseable timestamp', () => {
    const events = [makeEvent({ id: 'bad', timeUtc: 'not a date' })];
    expect(filterEarthquakes(events, 1, 72, NOW)).toEqual([]);
  });
});

describe('filterEarthquakes — combined', () => {
  it('applies both constraints, not just one', () => {
    const events = [
      makeEvent({ id: 'passes', magnitude: 5, timeUtc: hoursAgo(2) }),
      makeEvent({ id: 'too-small', magnitude: 2, timeUtc: hoursAgo(2) }),
      makeEvent({ id: 'too-old', magnitude: 5, timeUtc: hoursAgo(80) }),
      makeEvent({ id: 'both-fail', magnitude: 2, timeUtc: hoursAgo(80) }),
    ];

    const visible = filterEarthquakes(events, 4, 24, NOW);

    expect(visible.map((e) => e.id)).toEqual(['passes']);
  });

  it('does not mutate or reorder the source array', () => {
    const events = [
      makeEvent({ id: 'a', magnitude: 5 }),
      makeEvent({ id: 'b', magnitude: 6 }),
    ];
    const before = events.map((e) => e.id);

    filterEarthquakes(events, 1, 72, NOW);

    expect(events.map((e) => e.id)).toEqual(before);
  });
});
