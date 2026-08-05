import { describe, expect, it } from 'vitest';
import type { EarthquakeEvent } from '@terra-pulse/schema';
import { filterEarthquakes, narrowToPlayhead } from './useVisibleEarthquakes';

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
    const events = [makeEvent({ id: 'a', magnitude: 5 }), makeEvent({ id: 'b', magnitude: 6 })];
    const before = events.map((e) => e.id);

    filterEarthquakes(events, 1, 72, NOW);

    expect(events.map((e) => e.id)).toEqual(before);
  });
});

describe('narrowToPlayhead', () => {
  const events = [
    makeEvent({ id: 'oldest', timeUtc: hoursAgo(60) }),
    makeEvent({ id: 'middle', timeUtc: hoursAgo(30) }),
    makeEvent({ id: 'newest', timeUtc: hoursAgo(2) }),
  ];

  it('returns everything when live', () => {
    expect(narrowToPlayhead(events, null)).toHaveLength(3);
  });

  describe('trailing window', () => {
    // The time analogue of isolateBand. Over 57 years "everything up to here"
    // ends with the whole archive on screen and no way to see just the 1990s.
    it('drops events earlier than the trail start', () => {
      const trailStart = NOW - 40 * 60 * 60 * 1000;
      const shown = narrowToPlayhead(events, null, trailStart).map((e) => e.id);

      expect(shown).toEqual(['middle', 'newest']);
    });

    it('applies both bounds together', () => {
      const playhead = NOW - 10 * 60 * 60 * 1000;
      const trailStart = NOW - 40 * 60 * 60 * 1000;

      const shown = narrowToPlayhead(events, playhead, trailStart).map((e) => e.id);

      expect(shown).toEqual(['middle']);
    });

    it('includes an event exactly on the trail start', () => {
      // Inclusive at both ends, so the label "only last 10y" is literally true
      // rather than off by whatever sits on the boundary.
      const trailStart = NOW - 30 * 60 * 60 * 1000;
      const shown = narrowToPlayhead(events, null, trailStart).map((e) => e.id);

      expect(shown).toContain('middle');
    });

    it('is inert when no trail is set', () => {
      expect(narrowToPlayhead(events, null, null)).toHaveLength(3);
    });
  });

  it('drops events later than the playhead', () => {
    const playhead = NOW - 20 * 60 * 60 * 1000;
    const shown = narrowToPlayhead(events, playhead).map((event) => event.id);

    // A replay at T-20h has not reached the event from 2 hours ago.
    expect(shown).toEqual(['oldest', 'middle']);
  });

  it('includes an event landing exactly on the playhead', () => {
    const playhead = Date.parse(hoursAgo(30));
    expect(narrowToPlayhead(events, playhead).map((e) => e.id)).toEqual(['oldest', 'middle']);
  });

  it('shows nothing when the playhead precedes every event', () => {
    expect(narrowToPlayhead(events, NOW - 100 * 60 * 60 * 1000)).toHaveLength(0);
  });

  it('excludes an unparseable timestamp rather than placing it arbitrarily', () => {
    const broken = [makeEvent({ id: 'broken', timeUtc: 'not a date' })];
    expect(narrowToPlayhead(broken, NOW)).toHaveLength(0);
  });

  it('leaves the window filter alone — the two compose', () => {
    // narrowToPlayhead only trims the upper bound; the magnitude and window
    // rules stay with filterEarthquakes.
    const windowed = filterEarthquakes(events, 1, 48, NOW);
    expect(windowed).toHaveLength(2);
    expect(narrowToPlayhead(windowed, NOW)).toHaveLength(2);
  });
});

describe('band isolation', () => {
  const spread = [
    makeEvent({ id: 'micro', magnitude: 1.4 }),
    makeEvent({ id: 'edge-low', magnitude: 2.49 }),
    makeEvent({ id: 'edge-on', magnitude: 2.5 }),
    makeEvent({ id: 'moderate', magnitude: 4.8 }),
    makeEvent({ id: 'major', magnitude: 7.1 }),
  ];

  it('takes everything above the floor when no ceiling is given', () => {
    const shown = filterEarthquakes(spread, 1, 72, NOW).map((e) => e.id);
    expect(shown).toHaveLength(5);
  });

  it('keeps only the band when a ceiling is given', () => {
    const shown = filterEarthquakes(spread, 1, 72, NOW, 2.5).map((e) => e.id);
    expect(shown).toEqual(['micro', 'edge-low']);
  });

  it('excludes an event sitting exactly on the ceiling', () => {
    // Exclusive, so adjacent bands tile without double-counting: an M2.5
    // belongs to M2.5-4.5 and never also to M1-2.5.
    const shown = filterEarthquakes(spread, 1, 72, NOW, 2.5).map((e) => e.id);
    expect(shown).not.toContain('edge-on');

    const next = filterEarthquakes(spread, 2.5, 72, NOW, 4.5).map((e) => e.id);
    expect(next).toContain('edge-on');
  });

  it('tiles bands with no gaps and no overlaps', () => {
    // Every event lands in exactly one band, which is what makes the counts
    // across bands add up to the unfiltered total.
    const bands: [number, number | null][] = [
      [1, 2.5],
      [2.5, 4.5],
      [4.5, 5.5],
      [5.5, null],
    ];
    const seen = bands.flatMap(([floor, ceiling]) =>
      filterEarthquakes(spread, floor, 72, NOW, ceiling).map((e) => e.id),
    );

    expect(seen).toHaveLength(spread.length);
    expect(new Set(seen).size).toBe(spread.length);
  });

  it('hides the largest events, which is the whole point and the whole risk', () => {
    const shown = filterEarthquakes(spread, 1, 72, NOW, 2.5).map((e) => e.id);
    expect(shown).not.toContain('major');
  });
});
