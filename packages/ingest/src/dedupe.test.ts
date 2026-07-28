import { describe, expect, it } from 'vitest';
import type { EarthquakeEvent } from '@terra-pulse/schema';
import { distanceKm, isProbableDuplicate, rejectDuplicates } from './dedupe';

function makeEvent(overrides: Partial<EarthquakeEvent> = {}): EarthquakeEvent {
  return {
    id: 'us0001',
    source: 'usgs',
    magnitude: 5,
    magnitudeType: 'mb',
    place: 'somewhere',
    timeUtc: '2026-07-28T12:00:00.000Z',
    updatedUtc: '2026-07-28T12:05:00.000Z',
    longitude: 100,
    latitude: 0,
    depthKm: 10,
    status: 'reviewed',
    tsunami: false,
    alertLevel: null,
    significance: 400,
    url: 'https://example.test/us0001',
    ...overrides,
  };
}

/** Roughly `km` east of the origin at the equator. */
function shiftedEast(km: number): number {
  return 100 + km / 111.32;
}

describe('distanceKm', () => {
  it('is zero for identical points', () => {
    const a = makeEvent();
    expect(distanceKm(a, a)).toBe(0);
  });

  it('measures a known separation at the equator', () => {
    // 1° of longitude at the equator is ~111.32 km.
    const a = makeEvent({ longitude: 0, latitude: 0 });
    const b = makeEvent({ longitude: 1, latitude: 0 });
    expect(distanceKm(a, b)).toBeCloseTo(111.32, 0);
  });

  it('handles the antimeridian without wrapping wrong', () => {
    // 1° apart across the date line, not 359°.
    const a = makeEvent({ longitude: 179.5, latitude: 0 });
    const b = makeEvent({ longitude: -179.5, latitude: 0 });
    expect(distanceKm(a, b)).toBeCloseTo(111.32, 0);
  });
});

describe('isProbableDuplicate — the calibration cases', () => {
  it('matches a typical real pair (7.5 km apart, 0.5 s apart)', () => {
    // The measured median for genuine USGS/EMSC duplicates.
    const usgs = makeEvent();
    const emsc = makeEvent({
      source: 'emsc',
      longitude: shiftedEast(7.5),
      timeUtc: '2026-07-28T12:00:00.500Z',
    });
    expect(isProbableDuplicate(usgs, emsc)).toBe(true);
  });

  it('matches at the measured p99 separation (32 km)', () => {
    const usgs = makeEvent();
    const emsc = makeEvent({ source: 'emsc', longitude: shiftedEast(32) });
    expect(isProbableDuplicate(usgs, emsc)).toBe(true);
  });

  it('rejects events 200 km apart even at the same instant', () => {
    const usgs = makeEvent();
    const emsc = makeEvent({ source: 'emsc', longitude: shiftedEast(200) });
    expect(isProbableDuplicate(usgs, emsc)).toBe(false);
  });

  it('rejects events in the same place 10 minutes apart', () => {
    // Two genuine events in an aftershock sequence, not one event twice.
    const usgs = makeEvent();
    const emsc = makeEvent({ source: 'emsc', timeUtc: '2026-07-28T12:10:00.000Z' });
    expect(isProbableDuplicate(usgs, emsc)).toBe(false);
  });

  it('rejects a magnitude mismatch at the same place and time', () => {
    // A M2.1 and a M4.8 metres apart are two events, not a disagreement —
    // real pairs agree to within 0.20.
    const usgs = makeEvent({ magnitude: 2.1 });
    const emsc = makeEvent({ source: 'emsc', magnitude: 4.8 });
    expect(isProbableDuplicate(usgs, emsc)).toBe(false);
  });

  it('tolerates the magnitude disagreement real pairs actually show', () => {
    const usgs = makeEvent({ magnitude: 5 });
    const emsc = makeEvent({ source: 'emsc', magnitude: 5.2 });
    expect(isProbableDuplicate(usgs, emsc)).toBe(true);
  });
});

describe('isProbableDuplicate — edges', () => {
  it('is symmetric', () => {
    const a = makeEvent();
    const b = makeEvent({ source: 'emsc', longitude: shiftedEast(20) });
    expect(isProbableDuplicate(a, b)).toBe(isProbableDuplicate(b, a));
  });

  it('keeps both records when a timestamp is unparseable', () => {
    // Failing open: a surviving duplicate is visible, a dropped event is not.
    const a = makeEvent();
    const b = makeEvent({ source: 'emsc', timeUtc: 'not a date' });
    expect(isProbableDuplicate(a, b)).toBe(false);
  });
});

describe('rejectDuplicates', () => {
  it('drops candidates matching an existing record and keeps the rest', () => {
    const existing = [makeEvent({ id: 'us-known' })];
    const candidates = [
      makeEvent({ id: 'emsc-dupe', source: 'emsc', longitude: shiftedEast(5) }),
      makeEvent({ id: 'emsc-new', source: 'emsc', longitude: shiftedEast(500) }),
    ];

    const kept = rejectDuplicates(candidates, existing);

    expect(kept.map((e) => e.id)).toEqual(['emsc-new']);
  });

  it('keeps everything when there is nothing to compare against', () => {
    const candidates = [makeEvent({ id: 'a', source: 'emsc' })];
    expect(rejectDuplicates(candidates, [])).toHaveLength(1);
  });

  it('does not mutate its inputs', () => {
    const existing = [makeEvent({ id: 'x' })];
    const candidates = [makeEvent({ id: 'y', source: 'emsc' })];

    rejectDuplicates(candidates, existing);

    expect(existing).toHaveLength(1);
    expect(candidates).toHaveLength(1);
  });
});
