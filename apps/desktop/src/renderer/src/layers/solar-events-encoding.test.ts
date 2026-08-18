import { describe, expect, it } from 'vitest';
import type { CmeArrival } from '@terra-pulse/schema';
import {
  cmeMarkerColorHex,
  cmeMarkerPixelSize,
  flareMarkerColorHex,
  flareMarkerPixelSize,
} from './solar-events-encoding';

const arrival = (overrides: Partial<CmeArrival> = {}): CmeArrival => ({
  simulationId: 'WSA-ENLIL/1234',
  arrivalTimeUtc: '2026-07-05T12:00:00.000Z',
  predictedKp: 5,
  glancingBlow: false,
  minorImpact: false,
  link: null,
  ...overrides,
});

describe('flareMarkerColorHex', () => {
  it('gives X-class the app-wide emphasis red, M-class its own orange', () => {
    expect(flareMarkerColorHex('X')).toBe('#f87171');
    expect(flareMarkerColorHex('M')).toBe('#fb923c');
    expect(flareMarkerColorHex('X')).not.toBe(flareMarkerColorHex('M'));
  });
});

describe('flareMarkerPixelSize', () => {
  it('gives X-class flares a larger base size than M-class', () => {
    expect(flareMarkerPixelSize('X', 1)).toBeGreaterThan(flareMarkerPixelSize('M', 1));
  });

  it('grows with magnitude within a class', () => {
    expect(flareMarkerPixelSize('M', 5)).toBeGreaterThan(flareMarkerPixelSize('M', 1));
  });

  it('clamps the within-class boost so an outsized X28 does not blow out', () => {
    expect(flareMarkerPixelSize('X', 28)).toBe(flareMarkerPixelSize('X', 10));
  });
});

describe('cmeMarkerColorHex', () => {
  it('colours a direct hit and a glancing blow apart', () => {
    const hit = cmeMarkerColorHex(arrival());
    const graze = cmeMarkerColorHex(arrival({ glancingBlow: true }));
    expect(hit).not.toBe(graze);
  });

  it('treats a minor impact the same as a glancing blow', () => {
    expect(cmeMarkerColorHex(arrival({ minorImpact: true }))).toBe(
      cmeMarkerColorHex(arrival({ glancingBlow: true })),
    );
  });
});

describe('cmeMarkerPixelSize', () => {
  it('grows with predicted Kp', () => {
    expect(cmeMarkerPixelSize(8)).toBeGreaterThan(cmeMarkerPixelSize(2));
  });

  it('draws at the floor rather than guessing when the model produced no estimate', () => {
    expect(cmeMarkerPixelSize(null)).toBeLessThanOrEqual(cmeMarkerPixelSize(0));
  });

  it('is bounded even past the top of the Kp scale', () => {
    expect(cmeMarkerPixelSize(9)).toBe(cmeMarkerPixelSize(20));
  });
});
