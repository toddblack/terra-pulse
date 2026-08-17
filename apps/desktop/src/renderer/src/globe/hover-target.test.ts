import { describe, expect, it } from 'vitest';
import type { EarthquakeEvent, MagnetometerReading } from '@terra-pulse/schema';
import {
  cursorForHover,
  describeBoundary,
  describeEarthquake,
  describeFault,
  describeMagnetometer,
} from './hover-target';
import type { FaultRecord } from '../layers/fault-association';

function quake(overrides: Partial<EarthquakeEvent> = {}): EarthquakeEvent {
  return {
    id: 'us1',
    source: 'usgs',
    magnitude: 6.2,
    magnitudeType: 'mww',
    place: '120 km SSW of Somewhere',
    timeUtc: '2026-01-01T00:00:00.000Z',
    updatedUtc: '2026-01-01T00:00:00.000Z',
    longitude: 0,
    latitude: 0,
    depthKm: 35,
    status: 'reviewed',
    tsunami: false,
    alertLevel: null,
    significance: null,
    url: 'https://example.test',
    ...overrides,
  };
}

describe('describeEarthquake', () => {
  it('leads with magnitude and follows with place and depth', () => {
    const target = describeEarthquake(quake());
    expect(target.kind).toBe('earthquake');
    expect(target.title).toBe('M6.2');
    expect(target.detail).toContain('120 km SSW of Somewhere');
    expect(target.detail).toContain('35 km');
  });

  it('says depth is not reported rather than showing a zero', () => {
    // Same rule the inspector follows: 0 km would be a claim the catalogue
    // never made. The place is deliberately digit-free here — "120 km SSW"
    // contains "0 km" as a substring and made the first version of this test
    // pass for the wrong reason.
    const target = describeEarthquake(quake({ depthKm: null, place: 'Somewhere' }));
    expect(target.detail).toBe('Somewhere · depth not reported');
  });

  it('keeps one decimal on magnitude', () => {
    expect(describeEarthquake(quake({ magnitude: 7 })).title).toBe('M7.0');
  });

  it('carries the instant, not a formatted age', () => {
    // Formatting here would need a clock, and the answer would then freeze at
    // the moment the pointer last moved. The tooltip formats it against
    // `useNow` instead, which is also the rule the rest of the app follows.
    expect(describeEarthquake(quake()).timeUtc).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('describeFault', () => {
  /**
   * The reason kinematics and slip rate come before the name: 55% of GEM faults
   * have none, so a name-led tooltip reads "unnamed fault" on most hovers.
   */
  it('still says something useful for an unnamed fault', () => {
    const fault: FaultRecord = { z: 0, p: [], t: 'Dextral', s: 30.54, sl: 23.16, sh: 43.26 };
    const target = describeFault(fault);
    expect(target.title).toBe('Unnamed fault');
    expect(target.detail).toBe('dextral · 30.54 mm/yr (23.16–43.26)');
  });

  it('uses the name when there is one', () => {
    const fault: FaultRecord = { z: 0, p: [], n: 'San Andreas (Parkfield)', t: 'Dextral', s: 30.54 };
    expect(describeFault(fault).title).toBe('San Andreas (Parkfield)');
  });

  it('returns no detail when nothing is populated', () => {
    // A quarter of faults have no slip rate and 2% no slip type; the tooltip
    // must degrade to a bare title rather than an empty separator.
    expect(describeFault({ z: 0, p: [] }).detail).toBeNull();
  });

  it('omits the missing half of the detail rather than leaving a dangling separator', () => {
    expect(describeFault({ z: 0, p: [], t: 'Reverse' }).detail).toBe('reverse');
    expect(describeFault({ z: 0, p: [], s: 12 }).detail).toBe('12 mm/yr');
  });

  it('does not mistake a zero slip rate for a missing one', () => {
    expect(describeFault({ z: 0, p: [], s: 0 }).detail).toBe('0 mm/yr');
  });

  it('has no age, because a mapped trace is not an event', () => {
    // The tooltip renders nothing rather than "just now" — a fault has no
    // instant to be a duration from.
    expect(describeFault({ z: 0, p: [], s: 0 }).timeUtc).toBeNull();
    expect(describeBoundary('PA\\OK', 'SUB').timeUtc).toBeNull();
  });
});

describe('describeBoundary', () => {
  it('names the plate pair and the boundary type', () => {
    const target = describeBoundary('PA\\OK', 'SUB');
    expect(target.kind).toBe('boundary');
    expect(target.title).toBe('Pacific–Okhotsk');
    expect(target.detail).toBe('subduction zone');
  });

  it('does not assert which plate subducts', () => {
    // PB2002's separator encodes polarity; stating it backwards would be a
    // confident false claim about the tectonics.
    expect(describeBoundary('PA\\OK', 'SUB').title).toBe(
      describeBoundary('PA/OK', 'SUB').title,
    );
    expect(describeBoundary('PA\\OK', 'SUB').title).not.toMatch(/under|beneath/i);
  });
});

function reading(overrides: Partial<MagnetometerReading> = {}): MagnetometerReading {
  return {
    station: {
      code: 'BRW',
      name: 'Barrow',
      latitude: 71.3,
      longitude: -156.6,
      agency: 'USGS',
    },
    disturbance: {
      code: 'BRW',
      rangeNt: 12.4,
      samples: 60,
      observedAtUtc: '2026-01-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('describeMagnetometer', () => {
  it('leads with the station name, not the IAGA code', () => {
    const target = describeMagnetometer(reading());
    expect(target.kind).toBe('magnetometer');
    expect(target.title).toBe('Barrow');
    expect(target.detail).toContain('BRW');
  });

  it('carries the reading as the instant, so the tooltip can show its age', () => {
    expect(describeMagnetometer(reading()).timeUtc).toBe('2026-01-01T00:00:00.000Z');
  });

  it('calls out a disturbed station', () => {
    const target = describeMagnetometer(
      reading({ disturbance: { code: 'BRW', rangeNt: 62, samples: 60, observedAtUtc: '2026-01-01T00:00:00.000Z' } }),
    );
    expect(target.detail).toContain('disturbed');
  });

  it('does not call a quiet station disturbed', () => {
    const target = describeMagnetometer(reading());
    expect(target.detail).not.toContain('disturbed');
  });

  it('says so, and has no age, when the station reported nothing', () => {
    const target = describeMagnetometer(reading({ disturbance: null }));
    expect(target.detail).toBe('BRW · no reading in the last hour');
    expect(target.timeUtc).toBeNull();
  });
});

describe('cursorForHover', () => {
  it('is a pointer over anything clickable', () => {
    expect(cursorForHover(describeEarthquake(quake()))).toBe('pointer');
    expect(cursorForHover(describeBoundary('AF-AN', 'OSR'))).toBe('pointer');
  });

  it('hands the cursor back to Cesium over empty globe', () => {
    // Empty string rather than 'default': Cesium swaps in its own grab/grabbing
    // cursors while dragging, and forcing 'default' would fight that.
    expect(cursorForHover(null)).toBe('');
  });
});
