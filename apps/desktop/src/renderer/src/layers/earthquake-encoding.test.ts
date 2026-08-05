import { describe, expect, it } from 'vitest';

/**
 * Perceptual colour difference in OKLab, scaled by 100 — the same measure the
 * dataviz validator reports, so thresholds here mean what they mean elsewhere
 * in this project.
 *
 * Deliberately *not* WCAG contrast ratio. That measures luminance only, and a
 * red ring on a blue dot does its work through hue: the pair can be obvious to
 * the eye while scoring badly on luminance. The first version of this test used
 * contrast ratio and rejected a perfectly good colour — for the record, even
 * plain white only reaches 2.50:1 against the lightest depth fill, so a 3:1
 * text threshold was never the right bar for a decorative edge.
 */
function perceptualDistance(a: string, b: string): number {
  const toOklab = (hex: string): [number, number, number] => {
    const channel = (c: number): number => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const r = channel(parseInt(hex.slice(1, 3), 16));
    const g = channel(parseInt(hex.slice(3, 5), 16));
    const bl = channel(parseInt(hex.slice(5, 7), 16));

    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);

    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  };

  const [l1, a1, b1] = toOklab(a);
  const [l2, a2, b2] = toOklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100;
}

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2026-07-29T12:00:00Z');
const agedHours = (hours: number): string => new Date(NOW - hours * HOUR_MS).toISOString();

describe('isRecentEvent', () => {
  it('counts an event from an hour ago', () => {
    expect(isRecentEvent(agedHours(1), NOW)).toBe(true);
  });

  it('excludes an event older than the window', () => {
    expect(isRecentEvent(agedHours(RECENT_WINDOW_HOURS + 1), NOW)).toBe(false);
  });

  it('includes an event exactly at the boundary', () => {
    // Inclusive, so "past 24h" in the legend is literally true.
    expect(isRecentEvent(agedHours(RECENT_WINDOW_HOURS), NOW)).toBe(true);
  });

  it('treats a future-dated event as recent', () => {
    // Clock skew between the agency and this machine produces small negative
    // ages. Hiding those would drop the newest events, which is the opposite
    // of what this encoding is for.
    expect(isRecentEvent(agedHours(-2), NOW)).toBe(true);
  });

  it('does not treat an unparseable timestamp as recent', () => {
    // Falling back to "recent" would light up the globe on bad data.
    expect(isRecentEvent('not a date', NOW)).toBe(false);
    expect(isRecentEvent('', NOW)).toBe(false);
  });
});

describe('recency halo', () => {
  it('reads clearly against every depth fill on both basemaps', () => {
    // The stroke must be obvious against the dot it surrounds, whatever depth
    // that dot encodes. Measured ΔE runs 29-44 on light and 31-50 on dark, so
    // the 20 floor here is comfortable headroom above the 15 the rest of this
    // project uses — a colour that dropped near blue would fail loudly.
    for (const tone of ['light', 'dark'] as const) {
      const halo = recentHaloColorHex(tone);
      for (const fill of depthLegendColors(tone)) {
        expect(perceptualDistance(halo, fill)).toBeGreaterThan(20);
      }
    }
  });

  it('inverts per tone, following the neutral halo', () => {
    // The light basemap's ramp runs dark so its recency stroke is bright; the
    // dark basemap's ramp runs pale so its stroke is deep. Comparing each
    // against black orders them by lightness.
    const light = perceptualDistance(recentHaloColorHex('light'), '#000000');
    const dark = perceptualDistance(recentHaloColorHex('dark'), '#000000');
    expect(light).toBeGreaterThan(dark);
  });

  it('stays distinct from the neutral halo it replaces', () => {
    for (const tone of ['light', 'dark'] as const) {
      expect(recentHaloColorHex(tone)).not.toBe(haloColorHex(tone));
    }
  });

  it('draws slightly heavier than the neutral halo', () => {
    // Hue alone is easy to miss on a 5px dot.
    expect(RECENT_HALO_WIDTH).toBeGreaterThan(HALO_WIDTH);
  });
});

import {
  DEPTH_BINS,
  EMPHASIS_MAGNITUDE_THRESHOLD,
  HALO_WIDTH,
  RECENT_HALO_WIDTH,
  RECENT_WINDOW_HOURS,
  UNKNOWN_DEPTH_COLOR,
  depthBinIndex,
  depthClass,
  depthColorHex,
  depthLegendColors,
  emphasisRingColorHex,
  emphasisRingPixelSize,
  haloColorHex,
  isEmphasized,
  isRecentEvent,
  magnitudePixelSize,
  recentHaloColorHex,
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

  it('returns null for an unknown depth rather than inventing a fourth class', () => {
    // "Unknown" is the absence of a classification. A string here would let it
    // be formatted as though the catalogue had made a call it never made.
    expect(depthClass(null)).toBeNull();
  });
});

describe('isEmphasized', () => {
  it('rings everything at or above M5.5, on every view', () => {
    // Fixed rather than relative to the current floor. A floor-relative
    // version was tried and reverted: M5.5 means the same thing on every
    // screen, and "is this a big one?" does not change because the view
    // narrowed. See the note on EMPHASIS_MAGNITUDE_THRESHOLD.
    expect(isEmphasized(EMPHASIS_MAGNITUDE_THRESHOLD)).toBe(true);
    expect(isEmphasized(7.1)).toBe(true);
  });

  it('leaves anything below it unringed', () => {
    expect(isEmphasized(5.4)).toBe(false);
    expect(isEmphasized(1)).toBe(false);
  });

  it('does not ring an unparseable magnitude', () => {
    expect(isEmphasized(Number.NaN)).toBe(false);
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

  describe('unknown depth', () => {
    it('never binned as a depth — least of all as shallow', () => {
      // The failure this guards is quiet and wrong: a null falling through to
      // bin 0 would paint a possibly-deep 1970s event as a surface event.
      for (const tone of ['light', 'dark'] as const) {
        expect(depthColorHex(null, tone)).toBe(UNKNOWN_DEPTH_COLOR);
        expect(depthLegendColors(tone)).not.toContain(UNKNOWN_DEPTH_COLOR);
      }
    });

    it('keeps the same colour on both backdrops, unlike the ordinal ramp', () => {
      // The ramp flips direction per basemap so shallow stays loudest. This
      // value isn't on the ramp, so flipping it would imply an order it lacks.
      expect(depthColorHex(null, 'light')).toBe(depthColorHex(null, 'dark'));
    });
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
    expect(magnitudePixelSize(0)).toBe(magnitudePixelSize(1));
    expect(magnitudePixelSize(-1)).toBe(magnitudePixelSize(1));
  });

  it('still differentiates across the smallest magnitudes the UI can select', () => {
    // Regression guard: the scale floor must track the lowest selectable
    // floor. When it was stuck at 2.5, every M1-2.5 event drew identically.
    expect(magnitudePixelSize(2)).toBeGreaterThan(magnitudePixelSize(1));
    expect(magnitudePixelSize(2.5)).toBeGreaterThan(magnitudePixelSize(2));
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
