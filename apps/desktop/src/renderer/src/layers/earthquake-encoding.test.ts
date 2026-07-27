import { describe, expect, it } from 'vitest';
import {
  DEPTH_BINS,
  EMPHASIS_MAGNITUDE_THRESHOLD,
  depthBinIndex,
  depthClass,
  depthColorHex,
  depthLegendColors,
  emphasisRingColorHex,
  emphasisRingPixelSize,
  haloColorHex,
  isEmphasized,
  magnitudePixelSize,
} from './earthquake-encoding';

describe('depthBinIndex', () => {
  // Boundaries are the whole point of a binned scale — an off-by-one here
  // silently miscolors every event sitting exactly on an edge, and real
  // catalogs pile events on round numbers like 10/35/70.
  it.each([
    [0, 0],
    [19.9, 0],
    [20, 1],
    [69.9, 1],
    [70, 2],
    [299.9, 2],
    [300, 3],
    [499.9, 3],
    [500, 4],
    [700, 4],
  ])('puts %ikm in bin %i', (depthKm, expected) => {
    expect(depthBinIndex(depthKm)).toBe(expected);
  });

  it('clamps negative depths (events above sea level) into the shallowest bin', () => {
    expect(depthBinIndex(-3.2)).toBe(0);
  });

  it('falls back to the shallowest bin for non-finite input', () => {
    expect(depthBinIndex(Number.NaN)).toBe(0);
  });

  it('never returns an index outside DEPTH_BINS', () => {
    for (const depthKm of [-100, 0, 35, 150, 400, 800, 99999]) {
      const index = depthBinIndex(depthKm);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(DEPTH_BINS.length);
    }
  });
});

describe('depthClass', () => {
  // The conventional classes must land exactly on bin edges, otherwise the
  // legend and the inspector panel would disagree with each other.
  it.each([
    [0, 'shallow'],
    [69.9, 'shallow'],
    [70, 'intermediate'],
    [299.9, 'intermediate'],
    [300, 'deep'],
    [650, 'deep'],
  ])('classifies %ikm as %s', (depthKm, expected) => {
    expect(depthClass(depthKm)).toBe(expected);
  });

  it('aligns its boundaries with the bin edges', () => {
    // shallow = bins 0-1, intermediate = bin 2, deep = bins 3-4
    expect(depthBinIndex(69.9)).toBe(1);
    expect(depthBinIndex(70)).toBe(2);
    expect(depthBinIndex(299.9)).toBe(2);
    expect(depthBinIndex(300)).toBe(3);
  });
});

describe('depthColorHex', () => {
  it('returns a distinct colour per bin for a given backdrop tone', () => {
    const colors = [0, 35, 150, 400, 600].map((d) => depthColorHex(d, 'light'));
    expect(new Set(colors).size).toBe(DEPTH_BINS.length);
  });

  it('uses a different ramp per backdrop tone so marks stay readable on both', () => {
    expect(depthColorHex(10, 'light')).not.toBe(depthColorHex(10, 'dark'));
  });

  it('keeps shallow events the most prominent on both backdrop tones', () => {
    // Inverted lightness direction per basemap is deliberate: on light
    // terrain "prominent" means dark, on dark imagery it means light.
    const [lightShallow] = depthLegendColors('light');
    const [darkShallow] = depthLegendColors('dark');
    expect(lightShallow).toBe('#0d366b'); // darkest step
    expect(darkShallow).toBe('#cde2fb'); // lightest step
  });

  it('supplies one legend swatch per bin', () => {
    expect(depthLegendColors('light')).toHaveLength(DEPTH_BINS.length);
    expect(depthLegendColors('dark')).toHaveLength(DEPTH_BINS.length);
  });
});

describe('haloColorHex', () => {
  it('opposes the fill ramp so marks separate from any terrain underneath', () => {
    expect(haloColorHex('light')).toBe('#ffffff');
    expect(haloColorHex('dark')).toBe('#0b0b0b');
  });
});

describe('magnitudePixelSize', () => {
  it('grows monotonically with magnitude', () => {
    const sizes = [2.5, 4, 5.5, 7, 8].map(magnitudePixelSize);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]!).toBeGreaterThan(sizes[i - 1]!);
    }
  });

  it('clamps below the minimum magnitude so small events stay clickable', () => {
    expect(magnitudePixelSize(0)).toBe(magnitudePixelSize(2.5));
    expect(magnitudePixelSize(-1)).toBe(magnitudePixelSize(2.5));
  });

  it('clamps above the maximum so a great earthquake cannot blow out the view', () => {
    expect(magnitudePixelSize(9.5)).toBe(magnitudePixelSize(8));
  });

  it('is linear in magnitude, not exponential', () => {
    // Magnitude is already log-energy; a further curve would oversell big
    // events. Equal magnitude steps must give equal pixel steps.
    const a = magnitudePixelSize(4) - magnitudePixelSize(3);
    const b = magnitudePixelSize(7) - magnitudePixelSize(6);
    expect(a).toBeCloseTo(b, 6);
  });

  it('stays within the declared pixel range', () => {
    for (const magnitude of [-5, 2.5, 4.7, 8, 12, Number.NaN]) {
      const size = magnitudePixelSize(magnitude);
      expect(size).toBeGreaterThanOrEqual(5);
      expect(size).toBeLessThanOrEqual(22);
    }
  });
});

describe('magnitude emphasis', () => {
  it.each([
    [2.5, false],
    [5.4, false],
    [5.49, false],
    [5.5, true], // inclusive at the threshold
    [7.8, true],
  ])('emphasises M%s: %s', (magnitude, expected) => {
    expect(isEmphasized(magnitude)).toBe(expected);
  });

  it('does not emphasise a non-finite magnitude', () => {
    expect(isEmphasized(Number.NaN)).toBe(false);
  });

  it('draws the ring clear of the dot at every magnitude', () => {
    for (const magnitude of [EMPHASIS_MAGNITUDE_THRESHOLD, 6.5, 8, 9.9]) {
      expect(emphasisRingPixelSize(magnitude)).toBeGreaterThan(magnitudePixelSize(magnitude));
    }
  });

  it('opposes the halo, since the ring sits on bare terrain rather than on the fill', () => {
    expect(emphasisRingColorHex('light')).not.toBe(haloColorHex('light'));
    expect(emphasisRingColorHex('dark')).not.toBe(haloColorHex('dark'));
  });
});
