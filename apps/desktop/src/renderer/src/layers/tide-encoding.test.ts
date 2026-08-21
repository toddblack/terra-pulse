import { describe, expect, it } from 'vitest';
import {
  TIDE_HIGH_DOMAIN_M,
  TIDE_LOW_DOMAIN_M,
  paintTideRgba,
  tideColor,
  tideLegendStops,
} from './tide-encoding';

const TONES = ['light', 'dark'] as const;

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
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
    // Teal below, amber above. Validated at CVD dE 11.8 protan / 23.5 tritan;
    // this is the cheap structural guard that they have not been swapped or
    // collapsed onto one hue.
    const [lowR, lowG, lowB] = tideColor(-TIDE_LOW_DOMAIN_M, 'light');
    const [highR, highG, highB] = tideColor(TIDE_HIGH_DOMAIN_M, 'light');

    expect(lowB).toBeGreaterThan(lowR);
    expect(lowG).toBeGreaterThan(lowR);
    expect(highR).toBeGreaterThan(highB);
    expect(highG).toBeGreaterThan(highB);
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

  it('deepens the amber towards spring tide, which is where the signal lives', () => {
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
