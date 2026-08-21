import { describe, expect, it } from 'vitest';
import {
  equilibriumTideM,
  lunarBody,
  normaliseLongitude,
  sampleTideGrid,
  solarBody,
  tidalAmplitudeM,
  tidalBodies,
} from './tides';
import { subsolarPoint } from './magnetopause';

const DEG = Math.PI / 180;

function separationDeg(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z))) / DEG;
}

function globalRangeCm(at: Date): { lowCm: number; highCm: number; rangeCm: number } {
  const { values } = sampleTideGrid(at, 2);
  let low = Infinity;
  let high = -Infinity;
  for (const value of values) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  return { lowCm: low * 100, highCm: high * 100, rangeCm: (high - low) * 100 };
}

/**
 * The ephemeris is validated against things that are true by construction or
 * published, rather than against another implementation of the same series —
 * which would only prove the series was transcribed twice.
 */
describe('lunar ephemeris', () => {
  it('reproduces the published perigee and apogee distances', () => {
    // The single most important quantity here: the tide goes as 1/d^3, so a
    // circular-orbit Moon would be wrong by 17% twice a month.
    let minKm = Infinity;
    let maxKm = -Infinity;
    for (let day = 0; day < 730; day++) {
      const km = lunarBody(new Date(Date.UTC(2024, 0, 1) + day * 86_400_000)).distanceM / 1000;
      minKm = Math.min(minKm, km);
      maxKm = Math.max(maxKm, km);
    }

    // Published extremes are 356,400 and 406,700 km.
    expect(minKm).toBeGreaterThan(355_000);
    expect(minKm).toBeLessThan(358_000);
    expect(maxKm).toBeGreaterThan(404_000);
    expect(maxKm).toBeLessThan(408_000);
  });

  it('puts the Moon beside the Sun at new moon and opposite it at full', () => {
    // New and full moon are defined by ecliptic longitude, so the angular
    // separation is bounded by the Moon's ecliptic latitude — up to 5.1
    // degrees, which is exactly why there is not an eclipse every month.
    for (const iso of ['2024-01-11T11:57:00Z', '2000-01-06T18:14:00Z']) {
      const at = new Date(iso);
      expect(separationDeg(solarBody(at), lunarBody(at))).toBeLessThan(6);
    }

    for (const iso of ['2024-01-25T17:54:00Z', '2024-08-19T18:26:00Z']) {
      const at = new Date(iso);
      expect(separationDeg(solarBody(at), lunarBody(at))).toBeGreaterThan(174);
    }
  });
});

describe('solar ephemeris', () => {
  it('agrees with the magnetopause layer, which derived it independently', () => {
    // Two independent transcriptions of the low-precision solar series. Pinned
    // against each other rather than shared, the same way the Gardner-Knopoff
    // port is pinned across TypeScript and Python — a divergence should fail a
    // test on whichever side drifted.
    let worstLatDeg = 0;
    let worstLonDeg = 0;

    for (let day = 0; day < 400; day += 7) {
      const at = new Date(Date.UTC(2020, 0, 1) + day * 86_400_000);
      const mine = solarBody(at);
      const theirs = subsolarPoint(at);

      worstLatDeg = Math.max(worstLatDeg, Math.abs(mine.sublatitudeDeg - theirs.latitudeDeg));
      const dLon = Math.abs(mine.sublongitudeDeg - theirs.longitudeDeg);
      worstLonDeg = Math.max(worstLonDeg, dLon > 180 ? 360 - dLon : dLon);
    }

    expect(worstLatDeg).toBeLessThan(0.01);
    expect(worstLonDeg).toBeLessThan(0.01);
  });

  it('puts Earth at perihelion in early January', () => {
    const perihelion = solarBody(new Date('2024-01-03T00:00:00Z')).distanceM;
    const aphelion = solarBody(new Date('2024-07-05T00:00:00Z')).distanceM;

    expect(perihelion).toBeLessThan(aphelion);
    // 0.9833 and 1.0167 AU.
    expect(perihelion / 1.495_978_707e11).toBeCloseTo(0.9833, 3);
    expect(aphelion / 1.495_978_707e11).toBeCloseTo(1.0167, 3);
  });
});

describe('tidal amplitude', () => {
  it('matches the textbook values at mean distance', () => {
    // The one number that encodes GM, the Earth's radius and the 1/d^3 law at
    // once. Anything wrong in the constants shows up here.
    const meanMoon = { ...lunarBody(new Date()), distanceM: 384_400_000 };
    const meanSun = { ...solarBody(new Date()), distanceM: 1.495_978_707e11 };

    expect(tidalAmplitudeM(meanMoon)).toBeCloseTo(0.3573, 3);
    expect(tidalAmplitudeM(meanSun)).toBeCloseTo(0.1641, 3);
    expect(tidalAmplitudeM(meanSun) / tidalAmplitudeM(meanMoon)).toBeCloseTo(0.459, 2);
  });

  it('swings with lunar distance as an inverse cube', () => {
    const near = { ...lunarBody(new Date()), distanceM: 356_400_000 };
    const far = { ...lunarBody(new Date()), distanceM: 406_700_000 };

    expect(tidalAmplitudeM(near) / tidalAmplitudeM(far)).toBeCloseTo((406_700 / 356_400) ** 3, 6);
  });
});

describe('the equilibrium tide field', () => {
  it('is exactly antipodally symmetric — the reason there are two high tides a day', () => {
    // `(3cos^2(psi) - 1) / 2` is unchanged when psi -> 180 - psi, and that
    // holds for each body independently, so the sum is symmetric to floating
    // point. This is structural, not approximate: if it ever stops being true,
    // the potential is no longer degree 2.
    const bodies = tidalBodies(new Date('2024-03-15T07:30:00Z'));

    for (const [lat, lon] of [
      [0, 0],
      [37.5, -122.3],
      [-45, 170],
      [80, 15],
    ] as const) {
      const here = equilibriumTideM(bodies, lat, lon);
      const antipode = equilibriumTideM(bodies, -lat, normaliseLongitude(lon + 180));
      expect(antipode).toBeCloseTo(here, 12);
    }
  });

  it('peaks beneath the Moon and troughs a quarter turn away', () => {
    const bodies = tidalBodies(new Date('2024-01-11T11:57:00Z')); // new moon
    const { sublatitudeDeg, sublongitudeDeg } = bodies.moon;

    const beneath = equilibriumTideM(bodies, sublatitudeDeg, sublongitudeDeg);
    const quarterTurn = equilibriumTideM(
      bodies,
      sublatitudeDeg,
      normaliseLongitude(sublongitudeDeg + 90),
    );

    expect(beneath).toBeGreaterThan(quarterTurn);
    expect(beneath).toBeGreaterThan(0);
    expect(quarterTurn).toBeLessThan(0);
  });

  it('produces spring tides at syzygy and neap tides at quadrature', () => {
    // The behaviour everyone has heard of, and it falls out of summing two
    // bodies rather than being put in by hand.
    const springRange = Math.min(
      globalRangeCm(new Date('2024-01-11T11:57:00Z')).rangeCm,
      globalRangeCm(new Date('2024-01-25T17:54:00Z')).rangeCm,
    );
    const neapRange = Math.max(
      globalRangeCm(new Date('2024-01-18T03:53:00Z')).rangeCm,
      globalRangeCm(new Date('2024-02-02T23:18:00Z')).rangeCm,
    );

    expect(springRange).toBeGreaterThan(neapRange);
    // Measured 73-88 cm at syzygy against 50-58 cm at quadrature.
    expect(springRange).toBeGreaterThan(70);
    expect(neapRange).toBeLessThan(60);
  });

  it('stays inside physically plausible bounds across a decade', () => {
    // A guard against a units slip or a runaway series: nothing should ever
    // reach a metre.
    for (let day = 0; day < 3650; day += 37) {
      const { lowCm, highCm } = globalRangeCm(new Date(Date.UTC(2020, 0, 1) + day * 86_400_000));
      expect(highCm).toBeLessThan(80);
      expect(highCm).toBeGreaterThan(20);
      expect(lowCm).toBeGreaterThan(-45);
      expect(lowCm).toBeLessThan(-10);
    }
  });
});

describe('sampleTideGrid', () => {
  it('agrees exactly with evaluating each point directly', () => {
    // The hoisted per-row work must be an optimisation and nothing else —
    // the same guarantee `sampleFieldGrid` carries.
    const at = new Date('2024-06-01T12:00:00Z');
    const grid = sampleTideGrid(at, 2);

    for (let row = 0; row < grid.height; row += 7) {
      for (let col = 0; col < grid.width; col += 11) {
        const direct = equilibriumTideM(grid.bodies, 90 - row * 2, -180 + col * 2);
        expect(grid.values[row * grid.width + col]).toBeCloseTo(direct, 15);
      }
    }
  });

  it('covers the globe with the expected shape', () => {
    const grid = sampleTideGrid(new Date(), 2);
    expect(grid.width).toBe(180);
    expect(grid.height).toBe(91);
    expect(grid.values).toHaveLength(180 * 91);
  });

  it('is cheap enough to compute live, unlike the geomagnetic field', () => {
    // The field layer pre-renders frames because a grid costs 7.1 ms and the
    // field is static over a year. The tide changes every minute, so
    // pre-rendering cannot work — this has to be affordable live, and is.
    const start = performance.now();
    const frames = 20;
    for (let i = 0; i < frames; i++) {
      sampleTideGrid(new Date(Date.UTC(2024, 0, 1) + i * 3_600_000), 2);
    }
    const msPerFrame = (performance.now() - start) / frames;

    // Measured at 0.11 ms; this is a regression bound, not a target.
    expect(msPerFrame).toBeLessThan(3);
  });
});

describe('normaliseLongitude', () => {
  it('maps onto (-180, 180]', () => {
    expect(normaliseLongitude(0)).toBe(0);
    expect(normaliseLongitude(180)).toBe(180);
    expect(normaliseLongitude(190)).toBe(-170);
    expect(normaliseLongitude(-190)).toBe(170);
    expect(normaliseLongitude(540)).toBe(180);
  });
});
