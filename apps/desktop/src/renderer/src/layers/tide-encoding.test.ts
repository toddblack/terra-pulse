import { describe, expect, it } from 'vitest';
import {
  TIDE_HIGH_DOMAIN_M,
  TIDE_LOW_DOMAIN_M,
  TIDE_STRENGTH_GAMMA,
  paintTideRgba,
  tideColor,
  tideLegendStops,
} from './tide-encoding';

const TONES = ['light', 'dark'] as const;

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Perceptual distance in OKLab x100 — the measure the dataviz validator reports. */
function perceptualDistance(a: [number, number, number], b: [number, number, number]): number {
  const toOklab = ([r, g, bl]: [number, number, number]): [number, number, number] => {
    const channel = (c: number): number => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const lr = channel(r);
    const lg = channel(g);
    const lb = channel(bl);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
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

describe('tideColor', () => {
  it('puts a light neutral at zero on both backdrops', () => {
    expect(tideColor(0, 'light')).toEqual([240, 239, 236]);
    expect(tideColor(0, 'dark')).toEqual([236, 234, 230]);
  });

  it('keeps lightness monotonic from each pole in to zero', () => {
    // The diverging ramp must be quietest in the middle. The field layer
    // shipped the opposite once — a dark midpoint punched a dark notch through
    // zero and made the neutral band the loudest thing on screen.
    for (const tone of TONES) {
      for (const sign of [1, -1]) {
        let previous = -Infinity;
        const domain = sign < 0 ? TIDE_LOW_DOMAIN_M : TIDE_HIGH_DOMAIN_M;
        for (let step = 10; step >= 0; step--) {
          const current = luminance(tideColor((sign * step * domain) / 10, tone));
          expect(current).toBeGreaterThan(previous);
          previous = current;
        }
      }
    }
  });

  it('gives the two signs visibly different hues', () => {
    // Violet below, red-orange above. Validated at CVD dE 32.0 protan / 27.0
    // tritan; this is the cheap structural guard that they have not been
    // swapped or collapsed onto one hue.
    const low = tideColor(-TIDE_LOW_DOMAIN_M, 'light');
    const high = tideColor(TIDE_HIGH_DOMAIN_M, 'light');

    // Violet is blue-dominant with red well ahead of green.
    expect(low[2]).toBeGreaterThan(low[0]);
    expect(low[0]).toBeGreaterThan(low[1]);
    // Red-orange is red-dominant.
    expect(high[0]).toBeGreaterThan(high[1]);
    expect(high[0]).toBeGreaterThan(high[2]);
  });

  it('keeps the poles far enough apart for colour-vision deficiency', () => {
    // The floor the dataviz validator applies: 15 for normal vision, 8 under
    // simulated CVD. This test carries only the normal-vision half, because
    // simulating CVD needs the validator; the measured CVD figures are recorded
    // on the ramp itself.
    const low = tideColor(-TIDE_LOW_DOMAIN_M, 'light');
    const high = tideColor(TIDE_HIGH_DOMAIN_M, 'light');

    expect(perceptualDistance(low, high)).toBeGreaterThan(15);
  });

  it('paces the ramp by equal perceptual distance, not by eye', () => {
    // The failure this guards is invisible and was real: the teal/amber ramp's
    // steps ran 3.8, 7.5, 8.5, 9.0, 6.6, 4.1 dE -- bunched at both ends, with
    // the smallest step exactly where most of the globe's cells sit at neap
    // tide. Even pacing is what makes equal movement along the ramp mean equal
    // colour change; a hand-edited stop would undo it with nothing failing.
    //
    // Measured at 1.06 on both arms. The bar is deliberately slack enough to
    // survive 8-bit rounding and tight enough to reject the old ramp's 2.37.
    for (const sign of [-1, 1]) {
      const domain = sign < 0 ? TIDE_LOW_DOMAIN_M : TIDE_HIGH_DOMAIN_M;
      const steps: number[] = [];
      // Sample at the stop positions: 7 stops (midpoint + 6) means the arm's
      // strength runs 0, 1/6 ... 1, and strength is gamma'd, so invert it.
      for (let i = 1; i <= 6; i++) {
        const at = (t: number): [number, number, number] =>
          tideColor(sign * domain * t ** (1 / TIDE_STRENGTH_GAMMA), 'light');
        steps.push(perceptualDistance(at((i - 1) / 6), at(i / 6)));
      }
      expect(Math.max(...steps) / Math.min(...steps)).toBeLessThan(1.3);
    }
  });

  it('spends more of the ramp where the globe actually is', () => {
    // Why the gamma exists. At neap tide the median cell sits at strength 0.199
    // of its arm; linear, that lands on the ramp's very first step and half the
    // month reads as a wash. The gamma has to lift that cell clear of neutral.
    const neutral = tideColor(0, 'light');
    const medianNeapCell = tideColor(-0.199 * TIDE_LOW_DOMAIN_M, 'light');

    expect(perceptualDistance(neutral, medianNeapCell)).toBeGreaterThan(7);
  });

  it('does not flatten spring against neap while doing it', () => {
    // The cost of the gamma, and the reason it is 0.8 rather than 0.6. The
    // physical median-strength ratio between the phases is 2.82; the ramp must
    // not compress that so far that a spring tide stops looking bigger than a
    // neap one. Below 2 it is being spent, not spread.
    const neutral = tideColor(0, 'light');
    const neap = perceptualDistance(neutral, tideColor(0.199 * TIDE_HIGH_DOMAIN_M, 'light'));
    const spring = perceptualDistance(neutral, tideColor(0.562 * TIDE_HIGH_DOMAIN_M, 'light'));

    expect(spring / neap).toBeGreaterThan(2);
  });

  it('saturates beyond each arm rather than wrapping', () => {
    expect(tideColor(TIDE_HIGH_DOMAIN_M * 5, 'light')).toEqual(
      tideColor(TIDE_HIGH_DOMAIN_M, 'light'),
    );
    expect(tideColor(-TIDE_LOW_DOMAIN_M * 5, 'light')).toEqual(
      tideColor(-TIDE_LOW_DOMAIN_M, 'light'),
    );
  });

  it('reaches full strength on both arms, because each runs to its own limit', () => {
    // The bug this replaces: one symmetric +/-60 cm domain capped the low arm
    // at 49% of its range for all time, because a trough can only ever be half
    // as deep as a bulge is tall. Half the ramp was unreachable, and at neap
    // tide 87% of the globe sat within 40% of neutral.
    const lowPole = tideColor(-TIDE_LOW_DOMAIN_M, 'light');
    const highPole = tideColor(TIDE_HIGH_DOMAIN_M, 'light');

    // Both ends must be genuinely dark, not a wash.
    expect(luminance(lowPole)).toBeLessThan(140);
    expect(luminance(highPole)).toBeLessThan(160);

    // And the physical extremes must actually land there, rather than needing
    // a value the tide can never reach.
    expect(tideColor(-0.295, 'light')).not.toEqual(tideColor(0, 'light'));
  });

  it('deepens the warm arm towards spring tide, which is where the signal lives', () => {
    // Measured: the trough is nearly constant at -28 to -30 cm whatever the
    // phase, while the bulge swings 30 cm at neap to 59 cm at spring. So the
    // high arm is what has to show spring/neap, and it must not saturate early.
    const neapBulge = luminance(tideColor(0.3, 'light'));
    const springBulge = luminance(tideColor(0.58, 'light'));

    expect(springBulge).toBeLessThan(neapBulge);
  });
});

describe('paintTideRgba', () => {
  it('paints every cell fully opaque — a tide is never absent', () => {
    // The opposite of the aurora, where transparency carries meaning because
    // most cells are genuine zeroes. Every point on Earth has a tide at every
    // instant, so a see-through cell would misstate coverage.
    //
    // Opacity over the globe is the ImageryLayer's `alpha`, not these pixels,
    // because alpha is also the cross-fade control between frames — baking it
    // in here would leave nothing to fade with and force a `show` toggle, which
    // destroys tile imagery.
    const values = Float64Array.from([-0.3, 0, 0.3, 0.6]);
    const rgba = paintTideRgba(values, 'light');

    expect(rgba).toHaveLength(values.length * 4);
    for (let i = 0; i < values.length; i++) {
      expect(rgba[i * 4 + 3]).toBe(255);
    }
  });

  it('agrees with tideColor cell by cell', () => {
    const values = Float64Array.from([-0.5, -0.1, 0, 0.25, 0.55]);
    const rgba = paintTideRgba(values, 'dark');

    for (let i = 0; i < values.length; i++) {
      const [r, g, b] = tideColor(values[i]!, 'dark');
      expect([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]).toEqual([r, g, b]);
    }
  });
});

describe('tideLegendStops', () => {
  it('runs low to high through the neutral midpoint', () => {
    const stops = tideLegendStops('light', 11);

    expect(stops).toHaveLength(11);
    // Ends differ in magnitude on purpose — each arm runs to its own physical
    // limit, and the legend printing both is how that is disclosed.
    expect(stops[0]?.valueCm).toBe(-31);
    expect(stops[10]?.valueCm).toBe(62);
    expect(stops[5]?.valueCm).toBe(0);
    expect(stops[5]?.color).toEqual(tideColor(0, 'light'));
  });

  it('brightens towards the middle from both ends', () => {
    const stops = tideLegendStops('light', 11);
    const middle = luminance(stops[5]!.color);

    expect(luminance(stops[0]!.color)).toBeLessThan(middle);
    expect(luminance(stops[10]!.color)).toBeLessThan(middle);
  });
});
