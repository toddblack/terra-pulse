import { describe, expect, it } from 'vitest';
import { emscFeatureToEarthquakeEvent, fetchEmscEarthquakes } from './emsc-quakes';

// Captured from a live seismicportal.eu response while building this adapter.
const REAL_SAMPLE_FEATURE = {
  properties: {
    unid: '20260728_0000334',
    time: '2026-07-28T16:14:55.0Z',
    lastupdate: '2026-07-28T16:21:24.081528Z',
    flynn_region: 'SOUTHERN SUMATRA, INDONESIA',
    lat: -5.35,
    lon: 103.47,
    depth: 42,
    mag: 2.7,
    magtype: 'm',
    auth: 'BMKG',
  },
};

describe('emscFeatureToEarthquakeEvent', () => {
  it('normalises a real EMSC record into the shared shape', () => {
    const event = emscFeatureToEarthquakeEvent(REAL_SAMPLE_FEATURE);

    expect(event).toEqual({
      id: 'emsc:20260728_0000334',
      source: 'emsc',
      magnitude: 2.7,
      magnitudeType: 'm',
      place: 'SOUTHERN SUMATRA, INDONESIA',
      timeUtc: new Date('2026-07-28T16:14:55.0Z').toISOString(),
      updatedUtc: new Date('2026-07-28T16:21:24.081528Z').toISOString(),
      longitude: 103.47,
      latitude: -5.35,
      depthKm: 42,
      status: null,
      tsunami: false,
      alertLevel: null,
      significance: null,
      url: 'https://www.seismicportal.eu/eventdetails.html?unid=20260728_0000334',
    });
  });

  it('namespaces the id so it cannot collide with a USGS id', () => {
    const event = emscFeatureToEarthquakeEvent(REAL_SAMPLE_FEATURE);
    expect(event.id.startsWith('emsc:')).toBe(true);
  });

  it('leaves USGS-only fields null rather than defaulting them to zero', () => {
    // significance 0 and significance unknown are different claims, and the
    // inspector must be able to tell them apart.
    const event = emscFeatureToEarthquakeEvent(REAL_SAMPLE_FEATURE);
    expect(event.significance).toBeNull();
    expect(event.status).toBeNull();
    expect(event.alertLevel).toBeNull();
  });

  it('falls back when optional fields are missing', () => {
    const event = emscFeatureToEarthquakeEvent({
      properties: {
        ...REAL_SAMPLE_FEATURE.properties,
        flynn_region: null,
        mag: null,
        magtype: null,
        depth: null,
        lastupdate: null,
      },
    });

    expect(event.place).toBe('Unknown location');
    expect(event.magnitude).toBe(0);
    expect(event.magnitudeType).toBe('unknown');
    expect(event.depthKm).toBe(0);
    // With no lastupdate, the origin time is the best available answer.
    expect(event.updatedUtc).toBe(new Date(REAL_SAMPLE_FEATURE.properties.time).toISOString());
  });
});

describe('fetchEmscEarthquakes (real network call)', () => {
  it('returns correctly-shaped global events', async () => {
    const startUtc = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const events = await fetchEmscEarthquakes({ startUtc, minMagnitude: 4 });

    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);

    for (const event of events) {
      expect(event.source).toBe('emsc');
      expect(typeof event.id).toBe('string');
      expect(new Date(event.timeUtc).toString()).not.toBe('Invalid Date');
      expect(Number.isFinite(event.latitude)).toBe(true);
      expect(Number.isFinite(event.longitude)).toBe(true);
    }
  });

  it('reaches beyond the United States, which is the whole point', async () => {
    // USGS is ~69% US at M2+; EMSC was measured at 13%. If this adapter ever
    // starts returning a US-dominated set, something is wrong with the query.
    const startUtc = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const events = await fetchEmscEarthquakes({ startUtc, minMagnitude: 2 });

    const usPattern = /TEXAS|CALIFORNIA|ALASKA|OKLAHOMA|NEVADA|HAWAII|UTAH/;
    const nonUs = events.filter((event) => !usPattern.test(event.place.toUpperCase()));

    expect(nonUs.length).toBeGreaterThan(events.length / 2);
  });
});
