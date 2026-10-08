import { describe, expect, it } from 'vitest';
import { WATCH_STATUS_OFF, type QuakeWatchAlert, type QuakeWatchStatus } from '@terra-pulse/schema';
import { alertWords, watchChipLabel, watchDetail, watchHealth } from './watch-labels';

const PIN = { latitude: 34.1808, longitude: -118.309, label: 'Burbank' };

const WATCHING: QuakeWatchStatus = {
  ...WATCH_STATUS_OFF,
  pin: PIN,
  state: 'watching',
  stations: 75,
  liveStations: 71,
  magnitudeStations: 60,
  nearestKm: 4,
  connected: true,
  detections: 3,
};

describe('watchHealth', () => {
  it('is running when data flows and the pin is in reach', () => {
    expect(watchHealth(WATCHING)).toBe('running');
    expect(watchHealth(WATCH_STATUS_OFF)).toBe('off');
  });

  it('is trouble whenever no alert could fire: unavailable, reconnecting, or no gains', () => {
    expect(watchHealth({ ...WATCHING, state: 'unavailable' })).toBe('trouble');
    expect(watchHealth({ ...WATCHING, connected: false, retries: 2 })).toBe('trouble');
    expect(watchHealth({ ...WATCHING, magnitudeStations: 0 })).toBe('trouble');
  });

  it('is limited when the pin is out of the detector’s reach', () => {
    expect(watchHealth({ ...WATCHING, limit: 'too-far', nearestKm: 120 })).toBe('limited');
  });
});

describe('watchChipLabel', () => {
  it('names the place and how many stations are delivering', () => {
    expect(watchChipLabel(WATCHING)).toBe('Watching Burbank · 71/75');
    expect(watchChipLabel({ ...WATCHING, connected: false, retries: 1 })).toBe('Watching Burbank · reconnecting');
    expect(watchChipLabel({ ...WATCHING, state: 'starting' })).toBe('Watching Burbank · connecting');
    expect(watchChipLabel(WATCH_STATUS_OFF)).toBe('');
  });
});

describe('watchDetail', () => {
  it('states the limit in words, and the alert rule', () => {
    const detail = watchDetail({ ...WATCHING, limit: 'too-far', nearestKm: 118.4 });
    expect(detail).toMatch(/Nearest station 118 km away/);
    expect(detail).toMatch(/M4\.5\+ and predicted to be felt/);
    expect(watchDetail({ ...WATCHING, limit: 'too-few-stations' })).toMatch(/cannot declare anything/);
  });
});

describe('alertWords', () => {
  const alert: QuakeWatchAlert = {
    id: 'x-1',
    pin: PIN,
    alertedAtMs: 1_000,
    originMs: 0,
    // Ridgecrest: ~20° east of north from Burbank, inside the N sector.
    latitude: 35.77,
    longitude: -117.6,
    epicentralKm: 188,
    sArrivalAtPinMs: 53_000,
    magnitude: 6.12,
    intensity: 4.2,
    magnitudeStations: 9,
  };

  it('counts down to the shaking, then switches tense', () => {
    expect(alertWords(alert, 41_000).countdown).toBe('Shaking in ~12 s');
    expect(alertWords(alert, 41_000).ahead).toBe(true);
    expect(alertWords(alert, 60_000).countdown).toBe('Shaking should have arrived');
    expect(alertWords(alert, 60_000).ahead).toBe(false);
  });

  it('says where from the pin, and the intensity as a numeral', () => {
    const words = alertWords(alert, 0);
    expect(words.magnitude).toBe('M6.1');
    expect(words.where).toBe('188 km N of Burbank');
    expect(words.intensity).toBe('IV');
    expect(alertWords({ ...alert, epicentralKm: 4 }, 0).where).toBe('at Burbank');
  });
});
