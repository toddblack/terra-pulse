import { describe, expect, it } from 'vitest';
import type { GnssDailyPosition, GnssStep } from '@terra-pulse/schema';
import {
  BASELINE_DAYS,
  changeAcrossQuake,
  componentSamples,
  consecutiveRuns,
  describeStep,
  fitDomain,
  formatMm,
  nearestSample,
  offScale,
  relativeTicks,
  timeExtent,
  visibleSteps,
} from './gnss-plot';

const DAY = 86_400_000;
const ORIGIN = Date.parse('2019-07-06T03:19:53Z');
const QUAKE_DAY = Date.UTC(2019, 6, 6);

/** A station that sits still, then jumps `jumpM` east on the quake's day. */
function jumping(jumpM: number, { from = -400, to = 30, missing = [] as number[] } = {}): GnssDailyPosition[] {
  const positions: GnssDailyPosition[] = [];
  for (let d = from; d <= to; d += 1) {
    if (missing.includes(d)) continue;
    // A millimetre of alternating scatter, so the before-days have a range.
    const scatter = d % 2 === 0 ? 0.001 : -0.001;
    positions.push({ dayMs: QUAKE_DAY + d * DAY, eastM: 100 + scatter + (d > 0 ? jumpM : 0), northM: 50, upM: 10 });
  }
  return positions;
}

describe('componentSamples', () => {
  it('measures from the mean of the last week before the quake', () => {
    const samples = componentSamples({ positions: jumping(0.62), velocity: null }, 'east', ORIGIN, 30, false);
    const lastWeek = samples.filter((s) => s.side === 'before').slice(-BASELINE_DAYS);
    const mean = lastWeek.reduce((sum, s) => sum + s.mm, 0) / lastWeek.length;
    expect(mean).toBeCloseTo(0, 9);
  });

  it('cuts to the span asked for and labels each side of the quake', () => {
    const samples = componentSamples({ positions: jumping(0.62), velocity: null }, 'east', ORIGIN, 30, false);
    expect(samples[0]?.dayMs).toBe(QUAKE_DAY - 30 * DAY);
    expect(samples.at(-1)?.dayMs).toBe(QUAKE_DAY + 30 * DAY);
    expect(samples.find((s) => s.dayMs === QUAKE_DAY)?.side).toBe('quake-day');
    expect(samples.find((s) => s.dayMs === QUAKE_DAY + DAY)?.side).toBe('after');
  });

  it('draws each day at its middle, since a daily position averages the day', () => {
    const samples = componentSamples({ positions: jumping(0), velocity: null }, 'east', ORIGIN, 30, false);
    expect(samples[0]?.atMs).toBe(QUAKE_DAY - 30 * DAY + DAY / 2);
  });

  it("removes the station's published velocity, measured from the quake", () => {
    // A station drifting 36.525 mm a year east — 0.1 mm a day — and nothing else.
    const positions: GnssDailyPosition[] = [];
    for (let d = -365; d <= 30; d += 1) {
      positions.push({ dayMs: QUAKE_DAY + d * DAY, eastM: d * 0.0001, northM: 0, upM: 0 });
    }
    const velocity = { eastMPerYr: 0.036525, northMPerYr: 0, upMPerYr: 0 };
    const raw = componentSamples({ positions, velocity }, 'east', ORIGIN, 365, false);
    const flat = componentSamples({ positions, velocity }, 'east', ORIGIN, 365, true);
    expect(raw[0]?.mm).toBeLessThan(-30); // a year of drift
    for (const sample of flat) expect(Math.abs(sample.mm)).toBeLessThan(1e-6);
  });

  it('leaves the drift in when there is no velocity, rather than failing', () => {
    const samples = componentSamples({ positions: jumping(0), velocity: null }, 'east', ORIGIN, 30, true);
    expect(samples.length).toBeGreaterThan(0);
  });

  it('is empty for a station with nothing before the quake', () => {
    expect(componentSamples({ positions: jumping(0, { from: 1 }), velocity: null }, 'east', ORIGIN, 30, false)).toEqual([]);
  });
});

describe('fitDomain', () => {
  const samples = componentSamples({ positions: jumping(0.62), velocity: null }, 'east', ORIGIN, 90, false);

  it('is fitted to the days before the quake, not to the jump', () => {
    // At Ridgecrest the jump was 620 mm and the week before varied by about 2.
    // On one scale the before-days would be a flat line.
    const domain = fitDomain(samples, 1);
    expect(domain.hi).toBeLessThan(5);
    expect(domain.lo).toBeGreaterThan(-5);
  });

  it('holds a minimum span, so a quiet station is not magnified into motion', () => {
    const domain = fitDomain(samples, 12);
    expect(domain.hi - domain.lo).toBeCloseTo(12, 9);
  });

  it('always includes zero', () => {
    const shifted = samples.map((s) => ({ ...s, mm: s.mm + 50 }));
    const domain = fitDomain(shifted, 4);
    expect(domain.lo).toBeLessThanOrEqual(0);
  });
});

describe('changeAcrossQuake', () => {
  it('compares five days after against five before, leaving out the quake day', () => {
    const samples = componentSamples({ positions: jumping(0.62), velocity: null }, 'east', ORIGIN, 30, false);
    expect(changeAcrossQuake(samples)).toBeCloseTo(620, 0);
  });

  it('is null with no days after yet — the lab runs two weeks behind', () => {
    const samples = componentSamples({ positions: jumping(0.62, { to: 0 }), velocity: null }, 'east', ORIGIN, 30, false);
    expect(changeAcrossQuake(samples)).toBeNull();
  });

  it('is not moved by one wild day', () => {
    const positions = jumping(0.62).map((p) =>
      p.dayMs === QUAKE_DAY + 2 * DAY ? { ...p, eastM: p.eastM + 5 } : p,
    );
    const samples = componentSamples({ positions, velocity: null }, 'east', ORIGIN, 30, false);
    expect(changeAcrossQuake(samples)).toBeCloseTo(620, 0);
  });
});

describe('offScale', () => {
  it('says which way the days after leave the scale', () => {
    const up = componentSamples({ positions: jumping(0.62), velocity: null }, 'east', ORIGIN, 30, false);
    expect(offScale(up, fitDomain(up, 4))).toBe('above');
    const down = componentSamples({ positions: jumping(-0.25), velocity: null }, 'east', ORIGIN, 30, false);
    expect(offScale(down, fitDomain(down, 4))).toBe('below');
    const still = componentSamples({ positions: jumping(0), velocity: null }, 'east', ORIGIN, 30, false);
    expect(offScale(still, fitDomain(still, 4))).toBeNull();
  });
});

describe('consecutiveRuns', () => {
  it('never bridges a missing day', () => {
    const samples = componentSamples(
      { positions: jumping(0.62, { missing: [-10, -9, 3] }), velocity: null },
      'east',
      ORIGIN,
      30,
      false,
    );
    const runs = consecutiveRuns(samples);
    expect(runs).toHaveLength(3);
    for (const run of runs) {
      for (let i = 1; i < run.length; i += 1) {
        expect((run[i]?.dayMs ?? 0) - (run[i - 1]?.dayMs ?? 0)).toBe(DAY);
      }
    }
  });
});

describe('relativeTicks', () => {
  it('counts days from the quake at a step that suits the span', () => {
    expect(relativeTicks(ORIGIN, 30).map((t) => t.label)).toEqual(['−30 d', '−20 d', '−10 d', '+10 d', '+20 d', '+30 d']);
    expect(relativeTicks(ORIGIN, 90).map((t) => t.label)).toEqual(['−90 d', '−60 d', '−30 d', '+30 d']);
    expect(relativeTicks(ORIGIN, 365).map((t) => t.label)).toEqual(['−360 d', '−270 d', '−180 d', '−90 d', '+30 d']);
  });

  it('keeps every tick inside the drawn span', () => {
    for (const span of [30, 90, 365]) {
      const { startMs, endMs } = timeExtent(ORIGIN, span);
      for (const tick of relativeTicks(ORIGIN, span)) {
        expect(tick.atMs).toBeGreaterThanOrEqual(startMs);
        expect(tick.atMs).toBeLessThanOrEqual(endMs);
      }
    }
  });
});

describe('visibleSteps', () => {
  const steps: GnssStep[] = [
    { dayMs: QUAKE_DAY - 40 * DAY, kind: 'equipment', detail: 'Antenna_Type_Changed', magnitude: null, distanceKm: null },
    { dayMs: QUAKE_DAY - 40 * DAY, kind: 'equipment', detail: 'Receiver_Make_and_Model_Changed', magnitude: null, distanceKm: null },
    { dayMs: QUAKE_DAY - 2 * DAY, kind: 'earthquake', detail: 'ci38443183', magnitude: 6.4, distanceKm: 9.2 },
    { dayMs: QUAKE_DAY, kind: 'earthquake', detail: 'ci38457511', magnitude: 7.1, distanceKm: 19.5 },
    { dayMs: QUAKE_DAY + DAY, kind: 'earthquake', detail: 'ci38457687', magnitude: 5.5, distanceKm: 38.6 },
    { dayMs: QUAKE_DAY - 400 * DAY, kind: 'equipment', detail: 'Antenna_Type_Changed', magnitude: null, distanceKm: null },
  ];

  it('leaves out the quake itself and its next day, and steps outside the span', () => {
    expect(visibleSteps(steps, ORIGIN, 90).map((s) => s.detail)).toEqual(['Antenna_Type_Changed', 'ci38443183']);
  });

  it('keeps the foreshock: another quake that could have moved the station', () => {
    expect(visibleSteps(steps, ORIGIN, 30).some((s) => s.magnitude === 6.4)).toBe(true);
  });
});

describe('labels', () => {
  it('describes steps in words', () => {
    expect(describeStep({ dayMs: 0, kind: 'equipment', detail: 'Antenna_Type_Changed', magnitude: null, distanceKm: null })).toBe('antenna type changed');
    expect(describeStep({ dayMs: 0, kind: 'earthquake', detail: 'x', magnitude: 6.4, distanceKm: 9.2 })).toBe('M6.4, 9 km from the station');
  });

  it('formats millimetres signed, at a precision that suits the size', () => {
    expect(formatMm(620.4)).toBe('+620 mm');
    expect(formatMm(-2.34)).toBe('−2.3 mm');
    expect(formatMm(0.01)).toBe('0 mm');
  });
});

describe('nearestSample', () => {
  const samples = componentSamples({ positions: jumping(0, { missing: [-5] }), velocity: null }, 'east', ORIGIN, 30, false);

  it('finds the day under the pointer', () => {
    expect(nearestSample(samples, QUAKE_DAY - 3 * DAY + 1000)?.dayMs).toBe(QUAKE_DAY - 3 * DAY);
  });

  it('names no day when the pointer is over a gap', () => {
    expect(nearestSample(samples, QUAKE_DAY - 5 * DAY + DAY / 2)).toBeNull();
  });
});
