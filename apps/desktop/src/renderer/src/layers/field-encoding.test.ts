import { describe, expect, it } from 'vitest';
import {
  FIELD_SCALES,
  fieldColor,
  fieldLegendStops,
  paintFieldRgba,
  rampAt,
} from './field-encoding';
import { sampleFieldGrid } from './igrf';

describe('field scales', () => {
  it('covers the whole measured range of the model', () => {
    // Measured across 1900-2030 at 2-degree resolution: intensity runs
    // 21,909 to 69,432 nT. The domain is rounded outward so clamping never
    // silently flattens the extremes.
    const [lo, hi] = FIELD_SCALES.intensity.domain;
    expect(lo).toBeLessThan(21_909);
    expect(hi).toBeGreaterThan(69_432);
  });

  it('narrows declination to where the data actually lives, and flags the clamp', () => {
    // The definitional range is [-180, 180] and using it was a real bug: the
    // median |D| is 13.1 degrees and 77% of the surface is within 30, so almost
    // the whole planet rendered as the neutral midpoint and only the magnetic
    // poles took a colour. A clamped domain has to announce itself, because its
    // ends are a floor and a ceiling rather than measurements.
    expect(FIELD_SCALES.declination.domain).toEqual([-30, 30]);
    expect(FIELD_SCALES.declination.clamped).toBe(true);
  });

  it('leaves inclination on its definitional range, because the data fills it', () => {
    // Median |I| is 61.7 degrees and only 16% of the surface is within 30.
    expect(FIELD_SCALES.inclination.domain).toEqual([-90, 90]);
    expect(FIELD_SCALES.inclination.clamped).toBeUndefined();
  });

  it('spreads declination across the ramp instead of pooling at neutral', () => {
    // The regression guard for the bug above, stated as the thing the user
    // actually saw: a globe that was grey everywhere except the poles.
    const grid = sampleFieldGrid(2026, 180, 91, 'declination');
    let neutral = 0;
    for (const value of grid) {
      const [r, , b] = fieldColor(value, 'declination', 'dark');
      if (Math.abs(r - b) < 24) neutral += 1;
    }
    // Measured at 14.6% with the corrected domain; it was most of the globe
    // before. Anything approaching half means the domain has drifted wide again.
    expect(neutral / grid.length).toBeLessThan(0.3);
  });

  it('treats only the signed quantities as diverging', () => {
    // Intensity has no meaningful zero — the field is never absent — so a
    // diverging ramp would invent a midpoint that means nothing.
    expect(FIELD_SCALES.intensity.diverging).toBe(false);
    expect(FIELD_SCALES.declination.diverging).toBe(true);
    expect(FIELD_SCALES.inclination.diverging).toBe(true);
  });
});

describe('rampAt', () => {
  it('returns the endpoints exactly', () => {
    expect(rampAt(['#000000', '#ffffff'], 0)).toEqual([0, 0, 0]);
    expect(rampAt(['#000000', '#ffffff'], 1)).toEqual([255, 255, 255]);
  });

  it('interpolates between neighbouring steps', () => {
    expect(rampAt(['#000000', '#ffffff'], 0.5)).toEqual([128, 128, 128]);
  });

  it('clamps rather than extrapolating past either end', () => {
    expect(rampAt(['#000000', '#ffffff'], -5)).toEqual([0, 0, 0]);
    expect(rampAt(['#000000', '#ffffff'], 5)).toEqual([255, 255, 255]);
  });

  it('picks the right segment of a multi-step ramp', () => {
    const steps = ['#000000', '#808080', '#ffffff'];
    expect(rampAt(steps, 0.5)).toEqual([128, 128, 128]);
    expect(rampAt(steps, 0.25)[0]).toBeGreaterThan(0);
    expect(rampAt(steps, 0.25)[0]).toBeLessThan(128);
  });
});

describe('fieldColor', () => {
  it('is monotonically lighter as intensity rises', () => {
    // Viridis runs dark (weak) to light (strong). The direction matters less
    // than the monotonicity: lightness has to carry magnitude on its own, so
    // the ramp still reads in greyscale and for colour-blind viewers. This is
    // the guard against someone swapping in a rainbow, whose lightness rises
    // and falls and therefore invents boundaries the data does not have.
    const luminance = (v: number) => {
      const [r, g, b] = fieldColor(v, 'intensity', 'light');
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    let previous = -Infinity;
    for (let v = 20_000; v <= 70_000; v += 2_500) {
      const current = luminance(v);
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
  });

  it('puts the neutral midpoint at zero for diverging quantities', () => {
    // Not decoration: for declination this band *is* the agonic line, and for
    // inclination it is the magnetic equator.
    expect(fieldColor(0, 'declination', 'light')).toEqual([240, 239, 236]);
    expect(fieldColor(0, 'inclination', 'dark')).toEqual([236, 234, 230]);
  });

  it('keeps lightness monotonic from each pole in to zero', () => {
    // The diverging ramp must be quietest in the middle. Taking the palette's
    // dark *chart surface* as the midpoint inverted that: both arms run light
    // near the centre out to dark at the poles, so a dark midpoint punched a
    // dark notch through zero — the magnetic equator drew as a black line and
    // the agonic lines as dark seams, making the neutral band the loudest thing
    // on screen.
    const luminance = (v: number, tone: 'light' | 'dark') => {
      const [r, g, b] = fieldColor(v, 'inclination', tone);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const tone of ['light', 'dark'] as const) {
      for (const sign of [1, -1]) {
        let previous = -Infinity;
        for (let magnitude = 90; magnitude >= 0; magnitude -= 10) {
          const current = luminance(sign * magnitude, tone);
          expect(current).toBeGreaterThan(previous);
          previous = current;
        }
      }
    }
  });

  it('sends opposite signs to opposite hues', () => {
    const east = fieldColor(25, 'declination', 'light');
    const west = fieldColor(-25, 'declination', 'light');
    // Red arm is red-dominant; blue arm is blue-dominant.
    expect(east[0]).toBeGreaterThan(east[2]);
    expect(west[2]).toBeGreaterThan(west[0]);
  });

  it('is symmetric in strength about zero', () => {
    // Unequal arms would make one sign look like it covers more ground.
    const [er, eg, eb] = fieldColor(90, 'inclination', 'light');
    const [wr, wg, wb] = fieldColor(-90, 'inclination', 'light');
    const spread = (r: number, g: number, b: number) =>
      Math.max(r, g, b) - Math.min(r, g, b);
    expect(Math.abs(spread(er, eg, eb) - spread(wr, wg, wb))).toBeLessThan(40);
  });

  it('clamps out-of-domain values rather than wrapping', () => {
    expect(fieldColor(1e9, 'intensity', 'light')).toEqual(
      fieldColor(70_000, 'intensity', 'light'),
    );
  });
});

describe('paintFieldRgba', () => {
  it('produces four bytes per cell', () => {
    const values = sampleFieldGrid(2025, 8, 4, 'intensity');
    const rgba = paintFieldRgba(values, 8, 4, 'intensity', 'light');
    expect(rgba).toHaveLength(8 * 4 * 4);
  });

  it('writes a uniform alpha', () => {
    // Varying opacity with the value would be a second, contradictory encoding
    // of the same number.
    const values = sampleFieldGrid(2025, 8, 4, 'intensity');
    const rgba = paintFieldRgba(values, 8, 4, 'intensity', 'light', 200);
    for (let i = 3; i < rgba.length; i += 4) expect(rgba[i]).toBe(200);
  });

  it('draws the South Atlantic Anomaly darker than its surroundings', () => {
    // End-to-end through the encoding: the anomaly must actually be visible as
    // a pale patch, which is the reason the intensity view exists.
    const width = 360;
    const height = 181;
    const values = sampleFieldGrid(2025, width, height, 'intensity');
    const at = (lat: number, lon: number) => {
      const j = Math.round(((90 - lat) / 180) * height - 0.5);
      const i = Math.round(((lon + 180) / 360) * width - 0.5);
      const [r, g, b] = fieldColor(values[j * width + i] ?? 0, 'intensity', 'light');
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    // The measured 2025 minimum sits near 26S, 60W. Viridis puts weak field at
    // the dark end, so the anomaly is now a dark basin rather than a pale
    // smudge — which is the readability the ramp was changed for.
    expect(at(-26, -60)).toBeLessThan(at(-26, 140));
  });
});

describe('fieldLegendStops', () => {
  it('spans the domain end to end', () => {
    const stops = fieldLegendStops('intensity', 'light', 5);
    expect(stops).toHaveLength(5);
    expect(stops[0]?.value).toBe(20_000);
    expect(stops[4]?.value).toBe(70_000);
  });

  it('emits usable css colours', () => {
    for (const stop of fieldLegendStops('declination', 'dark')) {
      expect(stop.color).toMatch(/^rgb\(\d+ \d+ \d+\)$/);
    }
  });
});
