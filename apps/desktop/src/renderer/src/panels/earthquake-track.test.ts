import { describe, expect, it } from 'vitest';
import type { EarthquakeEvent } from '@terra-pulse/schema';
import { layoutEarthquakeTrack, peakEarthquake } from './earthquake-track';

const START = Date.UTC(2020, 0, 1);
const END = Date.UTC(2020, 0, 2);

function quake(hour: number, magnitude: number, overrides: Partial<EarthquakeEvent> = {}): EarthquakeEvent {
  return {
    id: `q-${String(hour)}-${String(magnitude)}`,
    source: 'usgs',
    magnitude,
    magnitudeType: 'mww',
    place: 'Somewhere',
    timeUtc: new Date(Date.UTC(2020, 0, 1, hour)).toISOString(),
    updatedUtc: new Date(Date.UTC(2020, 0, 1, hour)).toISOString(),
    longitude: 0,
    latitude: 0,
    depthKm: 10,
    status: 'reviewed',
    tsunami: false,
    alertLevel: null,
    significance: null,
    url: 'https://example.test',
    ...overrides,
  };
}

describe('layoutEarthquakeTrack', () => {
  it('positions a bin by time, dividing the window evenly', () => {
    // 24 bins across a 24-hour window is one bin per hour.
    const bars = layoutEarthquakeTrack([quake(6, 5.0)], START, END, 24);
    expect(bars).toHaveLength(24);
    expect(bars[6]?.magnitude).toBe(5.0);
    expect(bars[6]?.count).toBe(1);
    expect(bars[0]?.magnitude).toBeNull();
  });

  it('keeps the largest magnitude in a bin, not the mean', () => {
    // Averaging would repeat the exact mistake this project already ruled out
    // for Kp — both scales are quasi-logarithmic, so a mean isn't a real
    // quantity. The bin's one meaningful number is its biggest event.
    const bars = layoutEarthquakeTrack([quake(6, 3.0), quake(6, 6.5)], START, END, 24);
    expect(bars[6]?.magnitude).toBe(6.5);
    expect(bars[6]?.count).toBe(2);
  });

  it('folds an event exactly on the trailing edge into the last bin rather than dropping it', () => {
    // The trailing edge is often the live playhead — the one moment readers
    // most want a fresh event to actually show up.
    const bars = layoutEarthquakeTrack([quake(23, 5.5, { timeUtc: new Date(END).toISOString() })], START, END, 24);
    expect(bars[23]?.magnitude).toBe(5.5);
  });

  it('drops an event outside the window', () => {
    const before = quake(0, 7, { timeUtc: new Date(START - 3_600_000).toISOString() });
    const bars = layoutEarthquakeTrack([before], START, END, 24);
    expect(peakEarthquake(bars).count).toBe(0);
  });

  it('flags a bin at or above M5.5 as emphasized, matching the globe ring threshold', () => {
    const bars = layoutEarthquakeTrack([quake(1, 5.5), quake(2, 5.4)], START, END, 24);
    expect(bars[1]?.emphasized).toBe(true);
    expect(bars[2]?.emphasized).toBe(false);
  });

  it('returns one bar per bin regardless of how many earthquakes cluster into it', () => {
    // The whole reason this buckets rather than drawing one marker per event:
    // a swarm can put thousands of events in one hour, and the row must stay
    // bounded by the bucket count, not by the catalogue size.
    const swarm = Array.from({ length: 500 }, (_, i) => quake(1, 3 + (i % 3) * 0.1));
    const bars = layoutEarthquakeTrack(swarm, START, END, 24);
    expect(bars).toHaveLength(24);
    expect(bars[1]?.count).toBe(500);
  });

  it('returns nothing for a zero or negative span', () => {
    expect(layoutEarthquakeTrack([quake(1, 5)], END, START, 24)).toEqual([]);
    expect(layoutEarthquakeTrack([quake(1, 5)], START, START, 24)).toEqual([]);
  });
});

describe('peakEarthquake', () => {
  it('reports the largest magnitude and the total count across all bins', () => {
    const bars = layoutEarthquakeTrack([quake(1, 4.0), quake(5, 6.8), quake(5, 4.5)], START, END, 24);
    expect(peakEarthquake(bars)).toEqual({ magnitude: 6.8, count: 3 });
  });

  it('reports null and zero for an empty window', () => {
    const bars = layoutEarthquakeTrack([], START, END, 24);
    expect(peakEarthquake(bars)).toEqual({ magnitude: null, count: 0 });
  });
});
