import { describe, expect, it } from 'vitest';
import {
  fetchEarthquakeFeed,
  fetchRecentEarthquakes,
  usgsFeatureToEarthquakeEvent,
} from './usgs-quakes';

// Real feature captured from earthquake.usgs.gov's live feed while designing
// this adapter — not hand-invented, so the shape is trustworthy.
const REAL_SAMPLE_FEATURE = {
  id: 'us7000t38a',
  properties: {
    mag: 5,
    place: '96 km NNW of Port-Olry, Vanuatu',
    time: 1784936650140,
    updated: 1784938688040,
    url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000t38a',
    status: 'reviewed',
    tsunami: 0,
    alert: null,
    sig: 385,
    magType: 'mb',
  },
  geometry: {
    type: 'Point' as const,
    coordinates: [166.7272, -14.2346, 10] as [number, number, number],
  },
};

describe('usgsFeatureToEarthquakeEvent', () => {
  it('normalizes a real USGS feature into the shared EarthquakeEvent shape', () => {
    const event = usgsFeatureToEarthquakeEvent(REAL_SAMPLE_FEATURE);

    expect(event).toEqual({
      id: 'us7000t38a',
      magnitude: 5,
      magnitudeType: 'mb',
      place: '96 km NNW of Port-Olry, Vanuatu',
      timeUtc: new Date(1784936650140).toISOString(),
      updatedUtc: new Date(1784938688040).toISOString(),
      longitude: 166.7272,
      latitude: -14.2346,
      depthKm: 10,
      status: 'reviewed',
      tsunami: false,
      alertLevel: null,
      significance: 385,
      url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000t38a',
    });
  });

  it('converts a tsunami flag of 1 to true', () => {
    const event = usgsFeatureToEarthquakeEvent({
      ...REAL_SAMPLE_FEATURE,
      properties: { ...REAL_SAMPLE_FEATURE.properties, tsunami: 1 },
    });

    expect(event.tsunami).toBe(true);
  });

  it('defaults a null magnitude to 0 rather than passing null through', () => {
    const event = usgsFeatureToEarthquakeEvent({
      ...REAL_SAMPLE_FEATURE,
      properties: { ...REAL_SAMPLE_FEATURE.properties, mag: null },
    });

    expect(event.magnitude).toBe(0);
  });

  it('defaults a null place to a readable fallback', () => {
    const event = usgsFeatureToEarthquakeEvent({
      ...REAL_SAMPLE_FEATURE,
      properties: { ...REAL_SAMPLE_FEATURE.properties, place: null },
    });

    expect(event.place).toBe('Unknown location');
  });

  it('preserves a real (non-null) alert level', () => {
    const event = usgsFeatureToEarthquakeEvent({
      ...REAL_SAMPLE_FEATURE,
      properties: { ...REAL_SAMPLE_FEATURE.properties, alert: 'orange' },
    });

    expect(event.alertLevel).toBe('orange');
  });
});

describe('fetchRecentEarthquakes (real network call)', () => {
  it('returns correctly-shaped events for a known historical window', async () => {
    const events = await fetchRecentEarthquakes({
      startUtc: new Date('2026-07-20T00:00:00Z'),
      endUtc: new Date('2026-07-21T00:00:00Z'),
      minMagnitude: 4.5,
    });

    expect(Array.isArray(events)).toBe(true);
    // Global M4.5+ activity in any 24h window is effectively guaranteed —
    // an empty result here would mean the request shape itself is wrong.
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.magnitude).toBeGreaterThanOrEqual(4.5);
      expect(typeof event.id).toBe('string');
      expect(new Date(event.timeUtc).toString()).not.toBe('Invalid Date');
    }
  });
});

describe('fetchEarthquakeFeed (real network call)', () => {
  it('returns correctly-shaped events from the 2.5_day bucket', async () => {
    const events = await fetchEarthquakeFeed('2.5_day');

    expect(Array.isArray(events)).toBe(true);
    // Global M2.5+ activity over a full day is effectively guaranteed; an
    // empty result here would mean the URL or parsing is wrong.
    expect(events.length).toBeGreaterThan(0);

    for (const event of events) {
      expect(typeof event.id).toBe('string');
      expect(Number.isFinite(event.magnitude)).toBe(true);
      expect(new Date(event.timeUtc).toString()).not.toBe('Invalid Date');
    }
  });

  it('does not guarantee its own magnitude floor — the bucket label is approximate', async () => {
    // Observed live: the "2.5_day" bucket returned an M2.46. USGS revises
    // magnitudes after an event is placed in a bucket, and the boundary uses
    // rounded display magnitude. This adapter reports the feed faithfully
    // (non-negotiable #7); enforcing the app's floor is the caller's job, so
    // the catalogue keeps one consistent rule rather than "2.5+, mostly".
    const events = await fetchEarthquakeFeed('2.5_day');
    const belowFloor = events.filter((event) => event.magnitude < 2.5);

    // Not asserting stragglers *exist* — that depends on the hour. The point
    // is that finding them is normal and must not be treated as a bug.
    for (const event of belowFloor) {
      expect(event.magnitude).toBeGreaterThan(2.0);
    }
  });

  it('produces the same normalised shape as the FDSN path', async () => {
    // The two endpoints return identical GeoJSON, which is why they share a
    // normaliser. If USGS ever diverged them, this catches it.
    const [feedEvent] = await fetchEarthquakeFeed('2.5_day');
    expect(feedEvent).toBeDefined();
    expect(Object.keys(feedEvent!).sort()).toEqual(
      [
        'alertLevel',
        'depthKm',
        'id',
        'latitude',
        'longitude',
        'magnitude',
        'magnitudeType',
        'place',
        'significance',
        'status',
        'timeUtc',
        'tsunami',
        'updatedUtc',
        'url',
      ].sort(),
    );
  });

  it('tolerates a quiet bucket returning no events', async () => {
    // 2.5_hour legitimately returns count: 0 during quiet hours. An empty
    // array must be a normal result, never an error or a signal to clear.
    const events = await fetchEarthquakeFeed('2.5_hour');
    expect(Array.isArray(events)).toBe(true);
  });
});
