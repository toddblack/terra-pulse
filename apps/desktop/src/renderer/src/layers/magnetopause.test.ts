import { describe, expect, it } from 'vitest';
import {
  dynamicPressureNPa,
  GEOSYNCHRONOUS_RE,
  magnetopauseProfile,
  magnetopauseRadiusRe,
  magnetopauseStandoff,
  SHUE_BZ_RANGE_NT,
  subsolarPoint,
} from './magnetopause';

describe('dynamicPressureNPa', () => {
  it('gives the textbook 1-3 nPa for ordinary solar wind', () => {
    // n = 5 cm^-3 at 400 km/s is the canonical quiet wind.
    expect(dynamicPressureNPa(5, 400)).toBeCloseTo(1.34, 2);
  });

  it('scales with the square of speed, not with speed', () => {
    // The reason speed alone cannot stand in for pressure: doubling it
    // quadruples the force.
    expect(dynamicPressureNPa(5, 800) / dynamicPressureNPa(5, 400)).toBeCloseTo(4, 5);
  });

  it('scales linearly with density', () => {
    // And the reason density alone cannot either: a fast tenuous stream and a
    // slow dense one can push equally hard.
    expect(dynamicPressureNPa(10, 400)).toBeCloseTo(dynamicPressureNPa(5, 400) * 2, 5);
    expect(dynamicPressureNPa(20, 400)).toBeCloseTo(dynamicPressureNPa(5, 800), 5);
  });
});

describe('magnetopauseStandoff', () => {
  it('puts the quiet-time boundary near 10 Earth radii', () => {
    // The textbook value, and the check that the formula is transcribed right.
    const quiet = magnetopauseStandoff(0, 2);
    expect(quiet.standoffRe).toBeGreaterThan(9.5);
    expect(quiet.standoffRe).toBeLessThan(11);
    expect(quiet.insideGeosynchronous).toBe(false);
  });

  it('compresses under pressure alone', () => {
    const quiet = magnetopauseStandoff(0, 2);
    const compressed = magnetopauseStandoff(0, 8);
    expect(compressed.standoffRe).toBeLessThan(quiet.standoffRe);
  });

  it('erodes under southward Bz at the same pressure', () => {
    // The physical point of using Shue over a plain pressure balance: a
    // southward field strips dayside flux by reconnection, so the boundary moves
    // in for a reason pressure does not capture.
    const northward = magnetopauseStandoff(10, 2);
    const southward = magnetopauseStandoff(-10, 2);
    expect(southward.standoffRe).toBeLessThan(northward.standoffRe);
  });

  it('saturates rather than collapsing without limit', () => {
    // The tanh is what stops an extreme Bz driving the boundary to zero. Between
    // -20 and -50 nT the erosion term is already near its floor.
    const strong = magnetopauseStandoff(-20, 2).standoffRe;
    const extreme = magnetopauseStandoff(-50, 2).standoffRe;
    expect(extreme).toBeLessThan(strong);
    expect(strong - extreme).toBeLessThan(0.2);
  });

  it('pushes inside geosynchronous orbit under severe storm conditions', () => {
    // The documented and consequential case: satellites at 6.6 Re end up
    // outside the magnetosphere, directly in the solar wind. This is what makes
    // the number mean something.
    const severe = magnetopauseStandoff(-20, 10);
    expect(severe.standoffRe).toBeLessThan(GEOSYNCHRONOUS_RE);
    expect(severe.insideGeosynchronous).toBe(true);
  });

  it('flags extrapolation beyond the range Shue et al. fitted', () => {
    // The events most worth looking at are the ones that leave the range — the
    // Halloween 2003 storm reached about -50 nT, nearly three times the floor.
    expect(magnetopauseStandoff(0, 2).extrapolated).toBe(false);
    expect(magnetopauseStandoff(-50, 2).extrapolated).toBe(true);
    expect(magnetopauseStandoff(0, 40).extrapolated).toBe(true);
    expect(magnetopauseStandoff(SHUE_BZ_RANGE_NT.min - 1, 2).extrapolated).toBe(true);
  });

  it('does not divide by zero on a pressure of zero', () => {
    // Not physical — the wind never stops — but a null-ish input must not
    // produce Infinity on the globe.
    const shape = magnetopauseStandoff(0, 0);
    expect(Number.isFinite(shape.standoffRe)).toBe(true);
    expect(Number.isFinite(shape.flaring)).toBe(true);
  });
});

describe('magnetopauseRadiusRe', () => {
  it('returns the standoff distance at the subsolar point', () => {
    const shape = magnetopauseStandoff(0, 2);
    expect(magnetopauseRadiusRe(shape, 0)).toBeCloseTo(shape.standoffRe, 10);
  });

  it('opens outward toward the tail', () => {
    const shape = magnetopauseStandoff(0, 2);
    const subsolar = magnetopauseRadiusRe(shape, 0);
    const flank = magnetopauseRadiusRe(shape, Math.PI / 2);
    expect(flank).toBeGreaterThan(subsolar);
  });

  it('diverges directly antisunward, which is why the profile is truncated', () => {
    // The fit does not close the tail: the real magnetotail runs past 200 Re,
    // far beyond where the model was constrained. Drawing a closed teardrop
    // would be inventing a tail the model does not provide.
    expect(magnetopauseRadiusRe(magnetopauseStandoff(0, 2), Math.PI)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe('subsolarPoint', () => {
  it('puts the Sun over the tropics at the solstices', () => {
    // The obliquity, 23.44 degrees, is the check that the declination term is
    // right: June solstice over the Tropic of Cancer, December over Capricorn.
    const june = subsolarPoint(new Date('2026-06-21T12:00:00Z'));
    expect(june.latitudeDeg).toBeCloseTo(23.4, 0);

    const december = subsolarPoint(new Date('2026-12-21T12:00:00Z'));
    expect(december.latitudeDeg).toBeCloseTo(-23.4, 0);
  });

  it('puts the Sun near the equator at the equinoxes', () => {
    expect(Math.abs(subsolarPoint(new Date('2026-03-20T12:00:00Z')).latitudeDeg)).toBeLessThan(1);
    expect(Math.abs(subsolarPoint(new Date('2026-09-23T12:00:00Z')).latitudeDeg)).toBeLessThan(1);
  });

  it('sits near the Greenwich meridian at noon UTC', () => {
    // Within the equation of time, which runs to about +/-16 minutes — four
    // degrees. Anything much larger would mean the sidereal term is wrong.
    const noon = subsolarPoint(new Date('2026-03-20T12:00:00Z'));
    expect(Math.abs(noon.longitudeDeg)).toBeLessThan(5);
  });

  it('travels westward roughly 15 degrees an hour', () => {
    const at12 = subsolarPoint(new Date('2026-03-20T12:00:00Z')).longitudeDeg;
    const at15 = subsolarPoint(new Date('2026-03-20T15:00:00Z')).longitudeDeg;
    // Three hours of Earth rotation: 45 degrees west.
    expect(at12 - at15).toBeCloseTo(45, 0);
  });

  it('stays within a legal longitude', () => {
    for (let hour = 0; hour < 48; hour += 1) {
      const point = subsolarPoint(new Date(Date.UTC(2026, 5, 1, hour)));
      expect(point.longitudeDeg).toBeGreaterThan(-180.001);
      expect(point.longitudeDeg).toBeLessThanOrEqual(180.001);
    }
  });
});

describe('magnetopauseProfile', () => {
  it('samples from the subsolar point outward, all finite', () => {
    const points = magnetopauseProfile(magnetopauseStandoff(0, 2));
    expect(points.length).toBeGreaterThan(10);
    expect(points[0]?.thetaRad).toBe(0);
    expect(points.every((p) => Number.isFinite(p.radiusRe))).toBe(true);
  });

  it('increases monotonically away from the Sun', () => {
    const points = magnetopauseProfile(magnetopauseStandoff(0, 2));
    const radii = points.map((p) => p.radiusRe);
    expect([...radii].sort((a, b) => a - b)).toEqual(radii);
  });

  it('stays finite even if asked for the full half-turn', () => {
    // Clamped short of 180 degrees, so a caller cannot produce an infinity by
    // asking for one.
    const points = magnetopauseProfile(magnetopauseStandoff(0, 2), 180);
    expect(points.every((p) => Number.isFinite(p.radiusRe))).toBe(true);
  });
});
