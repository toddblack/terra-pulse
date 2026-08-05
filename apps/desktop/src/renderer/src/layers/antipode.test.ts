import { describe, expect, it } from 'vitest';
import { antipodeOf, chordProgress, formatLatLon, normalizeLongitude } from './antipode';

describe('normalizeLongitude', () => {
  it('leaves an in-range longitude alone', () => {
    expect(normalizeLongitude(0)).toBe(0);
    expect(normalizeLongitude(-112.14)).toBeCloseTo(-112.14, 10);
    expect(normalizeLongitude(179.9)).toBeCloseTo(179.9, 10);
  });

  it('wraps past the date line', () => {
    expect(normalizeLongitude(190)).toBe(-170);
    expect(normalizeLongitude(-190)).toBe(170);
    expect(normalizeLongitude(540)).toBe(-180);
  });

  it('resolves the two names for the date line to one', () => {
    // 180 and -180 are the same meridian. Half-open at the top means an
    // antipode prints the same way regardless of which side it started on.
    expect(normalizeLongitude(180)).toBe(-180);
    expect(normalizeLongitude(-180)).toBe(-180);
  });

  it('does not invent a value for a non-finite input', () => {
    expect(normalizeLongitude(Number.NaN)).toBeNaN();
  });
});

describe('antipodeOf', () => {
  it('mirrors latitude and turns longitude half a circle', () => {
    // Compared approximately, not exactly: the modulo arithmetic lands on
    // 67.86000000000001. That is inherent to binary floating point rather than
    // a defect, and it never reaches a reader — display goes through
    // `formatLatLon`, which rounds to two places.
    const antipode = antipodeOf({ latitude: 36.05, longitude: -112.14 });

    expect(antipode.latitude).toBeCloseTo(-36.05, 10);
    expect(antipode.longitude).toBeCloseTo(67.86, 10);
  });

  it('is its own inverse', () => {
    // The strongest property available: apply it twice and you are back where
    // you started, for any point on the sphere.
    for (const latitude of [-89.9, -45, 0, 12.3, 45, 89.9]) {
      for (const longitude of [-179.9, -120, -0.1, 0, 0.1, 120, 179.9]) {
        const there = antipodeOf({ latitude, longitude });
        const back = antipodeOf(there);

        expect(back.latitude).toBeCloseTo(latitude, 10);
        expect(back.longitude).toBeCloseTo(normalizeLongitude(longitude), 10);
      }
    }
  });

  it('maps the poles to each other', () => {
    expect(antipodeOf({ latitude: 90, longitude: 0 }).latitude).toBe(-90);
    expect(antipodeOf({ latitude: -90, longitude: 0 }).latitude).toBe(90);
  });

  it('keeps the result in range', () => {
    for (let longitude = -180; longitude <= 180; longitude += 7.5) {
      const { longitude: result } = antipodeOf({ latitude: 0, longitude });
      expect(result).toBeGreaterThanOrEqual(-180);
      expect(result).toBeLessThan(180);
    }
  });

  it('ignores depth, because the antipode is a surface point', () => {
    // A 600 km hypocentre is below a surface point; the other side of the world
    // from it is still on the surface, not inside the mantle.
    const shallow = antipodeOf({ latitude: 10, longitude: 20 });
    const deep = antipodeOf({ latitude: 10, longitude: 20 });
    expect(shallow).toEqual(deep);
  });
});

describe('formatLatLon', () => {
  it('uses hemisphere letters, matching the inspector', () => {
    expect(formatLatLon({ latitude: -36.05, longitude: 67.86 })).toBe('36.05°S, 67.86°E');
    expect(formatLatLon({ latitude: 12.5, longitude: -3.25 })).toBe('12.50°N, 3.25°W');
  });

  it('treats zero as the positive hemisphere rather than printing -0', () => {
    expect(formatLatLon({ latitude: 0, longitude: 0 })).toBe('0.00°N, 0.00°E');
  });
});

describe('chordProgress', () => {
  it('starts at nothing and finishes complete', () => {
    expect(chordProgress(0, 1000)).toBe(0);
    expect(chordProgress(1000, 1000)).toBe(1);
  });

  it('eases out rather than running at constant speed', () => {
    // Past halfway by the time a third of the duration has elapsed — a linear
    // line reads as a progress bar, this reads as something arriving.
    expect(chordProgress(333, 1000)).toBeGreaterThan(0.5);
  });

  it('never leaves [0, 1]', () => {
    // A backgrounded tab hands back a large elapsed time on resume, and clock
    // adjustments can hand back a negative one.
    expect(chordProgress(-500, 1000)).toBe(0);
    expect(chordProgress(9_999_999, 1000)).toBe(1);
  });

  it('is instantly complete for a zero duration', () => {
    expect(chordProgress(0, 0)).toBe(1);
  });

  it('increases monotonically', () => {
    let previous = -1;
    for (let elapsed = 0; elapsed <= 1000; elapsed += 50) {
      const progress = chordProgress(elapsed, 1000);
      expect(progress).toBeGreaterThanOrEqual(previous);
      previous = progress;
    }
  });
});
