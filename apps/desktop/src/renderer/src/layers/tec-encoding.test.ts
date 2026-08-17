import { describe, expect, it } from 'vitest';
import { TEC_ANOMALY_RANGE_TECU, TEC_MAX_TECU, type TecGrid } from '@terra-pulse/schema';
import { paintTecRgba, tecColor, tecLegendStops, TEC_SCALES } from './tec-encoding';

/** Relative luminance, the same stand-in for lightness the field tests use. */
const luminance = (rgb: [number, number, number]): number =>
  0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

describe('TEC_SCALES', () => {
  it('takes the TEC domain from the distribution, not the product definition', () => {
    // GloTEC declares tec 0-300 in its own metadata. A month of real data runs
    // p50 12.9, p95 41.9, max 60.5 — so the declared range would leave every
    // ordinary map in the bottom fifth of the ramp, which is precisely the
    // mistake the declination scale made once.
    expect(TEC_SCALES.tec.max).toBe(TEC_MAX_TECU);
    expect(TEC_SCALES.tec.max).toBeLessThan(300);
    expect(TEC_SCALES.tec.clamped).toBe(true);
  });

  it('treats only the anomaly as diverging', () => {
    // TEC has no meaningful zero on its scale — the ionosphere is never absent.
    // The anomaly does: it is a departure from expectation and runs both ways.
    expect(TEC_SCALES.tec.diverging).toBe(false);
    expect(TEC_SCALES.anomaly.diverging).toBe(true);
    expect(TEC_SCALES.anomaly.min).toBe(-TEC_ANOMALY_RANGE_TECU);
    expect(TEC_SCALES.anomaly.max).toBe(TEC_ANOMALY_RANGE_TECU);
  });
});

describe('tecColor — sequential', () => {
  it('is monotonically lighter as TEC rises', () => {
    // The guard against a rainbow. A ramp whose lightness rises and falls
    // invents contour boundaries the data does not contain, and fails outright
    // in greyscale, in print and under colour blindness.
    let previous = -Infinity;
    for (let v = 0; v <= TEC_MAX_TECU; v += 2.5) {
      const current = luminance(tecColor(v, 'tec', 'light'));
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
  });

  it('clamps past either end rather than extrapolating', () => {
    // Severe storms exceed 60 TECU. They saturate; they do not wrap around to
    // the dark end and read as quiet.
    expect(tecColor(500, 'tec', 'light')).toEqual(tecColor(TEC_MAX_TECU, 'tec', 'light'));
    expect(tecColor(-5, 'tec', 'light')).toEqual(tecColor(0, 'tec', 'light'));
  });

  it('brightens with magnitude, matching the aurora and the field', () => {
    // Those two rasters already establish "brighter means more". Reversing it
    // here would make a bright patch mean opposite things on layers a reader
    // flips between.
    expect(luminance(tecColor(TEC_MAX_TECU, 'tec', 'light'))).toBeGreaterThan(
      luminance(tecColor(0, 'tec', 'light')),
    );
  });
});

describe('tecColor — diverging', () => {
  it('puts the neutral midpoint at zero', () => {
    const [r, g, b] = tecColor(0, 'anomaly', 'light');
    // Greyscale by design: zero means "as expected", so it should be the
    // quietest thing on the ramp.
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(12);
  });

  it('keeps lightness monotonic from each pole in to zero', () => {
    // The failure this pins: a midpoint matched to a dark surface makes
    // lightness run dark, light, dark — punching a notch through zero and
    // turning the quietest band into the loudest thing on screen.
    for (const tone of ['light', 'dark'] as const) {
      let previous = -Infinity;
      for (let v = -TEC_ANOMALY_RANGE_TECU; v <= 0; v += 1) {
        const current = luminance(tecColor(v, 'anomaly', tone));
        expect(current).toBeGreaterThan(previous);
        previous = current;
      }
      previous = Infinity;
      for (let v = 0; v <= TEC_ANOMALY_RANGE_TECU; v += 1) {
        const current = luminance(tecColor(v, 'anomaly', tone));
        expect(current).toBeLessThan(previous);
        previous = current;
      }
    }
  });

  it('sends depletion and enhancement to opposite hues', () => {
    const depleted = tecColor(-8, 'anomaly', 'light');
    const enhanced = tecColor(8, 'anomaly', 'light');
    // Purple is blue-dominant against red; orange is the reverse.
    expect(depleted[2]).toBeGreaterThan(depleted[0]);
    expect(enhanced[0]).toBeGreaterThan(enhanced[2]);
  });

  it('is symmetric in strength about zero', () => {
    // Equal steps per arm, or one sign looks like it covers more ground.
    const near = tecColor(2, 'anomaly', 'light');
    const far = tecColor(9, 'anomaly', 'light');
    const nearDepleted = tecColor(-2, 'anomaly', 'light');
    const farDepleted = tecColor(-9, 'anomaly', 'light');
    expect(luminance(near)).toBeGreaterThan(luminance(far));
    expect(luminance(nearDepleted)).toBeGreaterThan(luminance(farDepleted));
  });
});

describe('paintTecRgba', () => {
  const grid = (tec: (number | null)[]): TecGrid => ({
    tec,
    anomaly: tec,
    qualityFlag: tec.map(() => 0),
    observedAtUtc: '2026-08-16T04:15:00Z',
  });

  it('paints every supplied cell opaquely', () => {
    // Unlike the aurora, transparency does not carry meaning here: the
    // ionosphere is everywhere, so a see-through cell would misstate coverage.
    const bytes = paintTecRgba(grid([10, 20, 30]), 'tec', 'light');
    expect(bytes).toHaveLength(12);
    expect(bytes[3]).toBeGreaterThan(0);
    expect(bytes[7]).toBeGreaterThan(0);
  });

  it('leaves an unsupplied cell fully transparent', () => {
    // A gap has to read as a gap rather than as a low value.
    const bytes = paintTecRgba(grid([10, null, 30]), 'tec', 'light');
    expect(bytes[7]).toBe(0);
    expect(bytes[4]).toBe(0);
    expect(bytes[3]).toBeGreaterThan(0);
  });
});

describe('tecLegendStops', () => {
  it('spans the scale and returns drawable colours', () => {
    const stops = tecLegendStops('tec', 'light');
    expect(stops[0]?.value).toBe(0);
    expect(stops.at(-1)?.value).toBe(TEC_MAX_TECU);
    expect(stops.every((s) => /^rgb\(\d+ \d+ \d+\)$/.test(s.color))).toBe(true);
  });

  it('starts the anomaly legend at depletion, not at zero', () => {
    const stops = tecLegendStops('anomaly', 'light');
    expect(stops[0]?.value).toBe(-TEC_ANOMALY_RANGE_TECU);
    expect(stops.at(-1)?.value).toBe(TEC_ANOMALY_RANGE_TECU);
  });
});
