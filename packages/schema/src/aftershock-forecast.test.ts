import { describe, expect, it } from 'vitest';
import {
  expectedAftershocks,
  forecastAftershocks,
  FORECAST_MAX_ELAPSED_DAYS,
  FORECAST_MIN_MAINSHOCK_MAGNITUDE,
  FORECAST_MAGNITUDE_BINS,
  FORECAST_VERIFIABLE_MAGNITUDE,
  FORECAST_WINDOWS_HOURS,
  isForecastEligible,
  poissonInterval,
  probabilityOfAtLeastOne,
  RJ_A,
  RJ_B,
  RJ_C_DAYS,
  RJ_P,
} from './aftershock-forecast';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 10);

/** The forecast row for one magnitude bin. */
function row(forecast: ReturnType<typeof forecastAftershocks>, magnitude: number) {
  const found = forecast.rows.find((r) => r.magnitude === magnitude);
  if (!found) throw new Error(`no row for M${magnitude}`);
  return found;
}

describe('the registered parameters', () => {
  it('are the global stack from Page et al. (2016), not RJ89’s own values', () => {
    // Pinned because they are a *registration*: changing any of them means
    // registering M1b in HYPOTHESES.md, not editing the constant. RJ89's own
    // a = -1.67 is documented in that paper as biased upward (it fitted only
    // sequences with enough data), informally corrected to -1.85 by Felzer et
    // al. 2003 — so the classic number is the one to avoid, not the one to use.
    expect(RJ_A).toBe(-1.97);
    expect(RJ_B).toBe(1.0);
    expect(RJ_P).toBe(0.92);
    expect(RJ_C_DAYS).toBe(0.018);
  });

  it('registers M1b’s three windows — 24 h, 7 d, 30 d', () => {
    // M1 registered two (24 h, 7 d); M1b added 30 d along with the magnitude
    // bins, to match the USGS product's layout.
    expect(FORECAST_WINDOWS_HOURS).toEqual([24, 168, 720]);
  });
});

describe('expectedAftershocks', () => {
  it('matches the closed-form integral computed independently', () => {
    // An independent evaluation of N = 10^(a+b(Mm-M)) * [(t2+c)^(1-p) -
    // (t1+c)^(1-p)] / (1-p), so a refactor of the implementation cannot
    // quietly change the arithmetic.
    const Mm = 7.0;
    const M = 5.0;
    const t1 = 0;
    const t2 = 1;
    const productivity = 10 ** (RJ_A + RJ_B * (Mm - M));
    const decay =
      ((t2 + RJ_C_DAYS) ** (1 - RJ_P) - (t1 + RJ_C_DAYS) ** (1 - RJ_P)) / (1 - RJ_P);
    expect(expectedAftershocks(Mm, M, t1, t2)).toBeCloseTo(productivity * decay, 10);
  });

  it('scales by a factor of ten per magnitude unit, because b is 1', () => {
    // Gutenberg-Richter, straight through: one unit of mainshock magnitude is
    // ten times the aftershocks at a fixed target magnitude.
    const small = expectedAftershocks(6.0, 5.0, 0, 1);
    const large = expectedAftershocks(7.0, 5.0, 0, 1);
    expect(large / small).toBeCloseTo(10, 6);
  });

  it('decays: the second day expects fewer than the first', () => {
    const dayOne = expectedAftershocks(7.0, 5.0, 0, 1);
    const dayTwo = expectedAftershocks(7.0, 5.0, 1, 2);
    const dayTen = expectedAftershocks(7.0, 5.0, 9, 10);
    expect(dayTwo).toBeLessThan(dayOne);
    expect(dayTen).toBeLessThan(dayTwo);
  });

  it('is additive across adjacent windows', () => {
    // An integral of a rate must be. If this fails, the decay term is wrong.
    const whole = expectedAftershocks(7.0, 5.0, 0, 7);
    const parts =
      expectedAftershocks(7.0, 5.0, 0, 2) +
      expectedAftershocks(7.0, 5.0, 2, 5) +
      expectedAftershocks(7.0, 5.0, 5, 7);
    expect(parts).toBeCloseTo(whole, 10);
  });

  it('is zero for an empty or inverted window', () => {
    expect(expectedAftershocks(7.0, 5.0, 3, 3)).toBe(0);
    expect(expectedAftershocks(7.0, 5.0, 5, 2)).toBe(0);
  });

  it('gives a plausible count for a great earthquake', () => {
    // Sanity, not a fit: an M9.1 should expect hundreds of M5+ in the first
    // day, which is the order the 2011 Tohoku sequence actually produced.
    const first24h = expectedAftershocks(9.1, 5.0, 0, 1);
    expect(first24h).toBeGreaterThan(100);
    expect(first24h).toBeLessThan(2000);
  });
});

describe('poissonInterval', () => {
  it('brackets the mean', () => {
    for (const lambda of [0.5, 3, 12, 50, 400]) {
      const { low, high } = poissonInterval(lambda);
      expect(low).toBeLessThanOrEqual(lambda);
      expect(high).toBeGreaterThanOrEqual(lambda);
    }
  });

  it('includes zero when the expectation is small', () => {
    // The honest part of a small forecast: "0 to 2" says the likeliest single
    // outcome is nothing at all, which "0.4 expected" does not.
    expect(poissonInterval(0.4).low).toBe(0);
  });

  it('survives a large mean, where exp(-lambda) underflows', () => {
    // The reason the recurrence runs in log space. A multiplicative recurrence
    // seeded with Math.exp(-466) starts at 0 and returns all zeros — a wrong
    // interval with no error at all.
    const { low, high } = poissonInterval(466);
    expect(low).toBeGreaterThan(400);
    expect(high).toBeLessThan(540);
    expect(high).toBeGreaterThan(low);
  });

  it('agrees with an exact small-lambda computation', () => {
    // Independent check against a direct (non-log) evaluation, valid while
    // exp(-lambda) is representable.
    const lambda = 6;
    let pmf = Math.exp(-lambda);
    let cumulative = 0;
    let low: number | null = null;
    let high = 0;
    for (let k = 0; k < 200; k += 1) {
      if (k > 0) pmf = (pmf * lambda) / k;
      cumulative += pmf;
      if (low === null && cumulative >= 0.025) low = k;
      if (cumulative >= 0.975) {
        high = k;
        break;
      }
    }
    expect(poissonInterval(lambda)).toEqual({ low, high });
  });

  it('is degenerate at zero rather than throwing', () => {
    expect(poissonInterval(0)).toEqual({ low: 0, high: 0 });
    expect(poissonInterval(-1)).toEqual({ low: 0, high: 0 });
  });
});

describe('forecastAftershocks', () => {
  it('forecasts forward from now, not from the mainshock', () => {
    // Aftershocks between the mainshock and now have already happened; they
    // are the observed panel's subject. A forecast can only answer "how many
    // more?".
    const fresh = forecastAftershocks(7.0, NOW - 1 * DAY, NOW);
    const stale = forecastAftershocks(7.0, NOW - 100 * DAY, NOW);
    expect(row(stale, 5).windows[0]!.expected).toBeLessThan(row(fresh, 5).windows[0]!.expected);
    expect(fresh.elapsedDays).toBeCloseTo(1, 6);
  });

  it('expects more over seven days than over one', () => {
    const forecast = forecastAftershocks(7.0, NOW - DAY, NOW);
    expect(row(forecast, 5).windows[1]!.expected).toBeGreaterThan(
      row(forecast, 5).windows[0]!.expected,
    );
  });

  it('puts the foreshock probability in the few-percent range', () => {
    // The cross-check that this is calibrated like the real thing: USGS quotes
    // roughly a 5% chance that a given earthquake is followed by something
    // larger within the following week.
    const forecast = forecastAftershocks(6.0, NOW, NOW);
    expect(forecast.probabilityOfLarger).toBeGreaterThan(0.02);
    expect(forecast.probabilityOfLarger).toBeLessThan(0.12);
  });

  it('gives the same foreshock probability whatever the mainshock magnitude', () => {
    // A real property of the model, not a bug: b(Mm - M) is zero when M = Mm,
    // so the expected count of events at least as large as the mainshock is
    // 10^a times the decay integral, independent of Mm. Pinned because it looks
    // wrong at first glance and someone will otherwise "fix" it.
    const small = forecastAftershocks(5.2, NOW, NOW).probabilityOfLarger;
    const great = forecastAftershocks(8.2, NOW, NOW).probabilityOfLarger;
    expect(small).toBeCloseTo(great, 12);
  });

  it('reports an interval for every window, never a bare number', () => {
    const forecast = forecastAftershocks(7.5, NOW - DAY, NOW);
    expect(forecast.rows).toHaveLength(FORECAST_MAGNITUDE_BINS.length);
    for (const window of row(forecast, 5).windows) {
      expect(window.high).toBeGreaterThanOrEqual(window.low);
      expect(window.expected).toBeGreaterThan(0);
    }
  });

  it('reports every registered magnitude bin', () => {
    const forecast = forecastAftershocks(7.0, NOW, NOW);
    expect(forecast.rows.map((r) => r.magnitude)).toEqual([...FORECAST_MAGNITUDE_BINS]);
  });
});

describe('isForecastEligible', () => {
  it('refuses a mainshock below the registered floor', () => {
    expect(isForecastEligible(FORECAST_MIN_MAINSHOCK_MAGNITUDE - 0.1, NOW - DAY, NOW)).toBe(false);
    expect(isForecastEligible(FORECAST_MIN_MAINSHOCK_MAGNITUDE, NOW - DAY, NOW)).toBe(true);
  });

  it('refuses an event too old for the decay to mean anything', () => {
    expect(isForecastEligible(7.0, NOW - (FORECAST_MAX_ELAPSED_DAYS + 1) * DAY, NOW)).toBe(false);
    expect(isForecastEligible(7.0, NOW - (FORECAST_MAX_ELAPSED_DAYS - 1) * DAY, NOW)).toBe(true);
  });

  it('refuses a future-dated event, which is a clock problem', () => {
    expect(isForecastEligible(7.0, NOW + DAY, NOW)).toBe(false);
  });
});

describe('probabilityOfAtLeastOne', () => {
  it('is the Poisson complement, not the expected count', () => {
    // The reading that makes a small forecast legible. For a mean of 0.7 the
    // chance of at least one event is 50%, not 70% — mistaking one for the
    // other is the easy error here.
    expect(probabilityOfAtLeastOne(0.7)).toBeCloseTo(1 - Math.exp(-0.7), 12);
    expect(probabilityOfAtLeastOne(0.7)).toBeLessThan(0.7);
  });

  it('is zero at zero and approaches one for a large mean', () => {
    expect(probabilityOfAtLeastOne(0)).toBe(0);
    expect(probabilityOfAtLeastOne(-5)).toBe(0);
    expect(probabilityOfAtLeastOne(20)).toBeGreaterThan(0.999);
  });
});

describe('why M1b bins by magnitude', () => {
  it('gives a moderate mainshock a near-empty M5+ row, which is why bins exist', () => {
    // This is why the alternate wording exists: an M5.5 expects a few
    // hundredths of an M5+ aftershock, so a table of counts shows "0-0" and
    // "<0.1" — arithmetically right and useless. Measured here so the
    // threshold's purpose is pinned rather than asserted.
    const forecast = forecastAftershocks(5.5, NOW - 2 * DAY, NOW);
    for (const window of row(forecast, 5).windows) {
      expect(window.expected).toBeLessThan(1);
      expect(window.low).toBe(0);
    }
    // And the probability form says something a reader can use.
    expect(row(forecast, 5).windows[1]!.chanceOfAny).toBeGreaterThan(0.01);
    expect(row(forecast, 5).windows[1]!.chanceOfAny).toBeLessThan(0.25);
  });

  it('gives a large mainshock a populated M5+ row', () => {
    const forecast = forecastAftershocks(7.5, NOW, NOW);
    expect(row(forecast, 5).windows[0]!.expected).toBeGreaterThan(1);
    expect(row(forecast, 5).windows[0]!.chanceOfAny).toBeGreaterThan(0.9);
  });
});

describe('M1b — the magnitude bins', () => {
  it('registers M3+ through M7+ and three windows', () => {
    expect(FORECAST_MAGNITUDE_BINS).toEqual([3, 4, 5, 6, 7]);
    expect(FORECAST_WINDOWS_HOURS).toEqual([24, 168, 720]);
  });

  it('marks the bins this catalogue cannot verify', () => {
    // M3 and M4 are below the app's own completeness, so those rows can never
    // be checked against the observed-sequence panel above them. Registered
    // anyway — a forecast is model output, not a catalogue claim — but the UI
    // has to say so rather than invite the comparison.
    const forecast = forecastAftershocks(6.5, NOW, NOW);
    expect(row(forecast, 3).verifiable).toBe(false);
    expect(row(forecast, 4).verifiable).toBe(false);
    expect(row(forecast, 5).verifiable).toBe(true);
    expect(row(forecast, 7).verifiable).toBe(true);
    expect(FORECAST_VERIFIABLE_MAGNITUDE).toBe(5);
  });

  it('puts real numbers in the small bins where M5+ rounds to nothing', () => {
    // The measured reason for the amendment. An M5.5 is the common selection:
    // over a week it expects a fifth of one M5+ aftershock — a count that
    // renders "0-0" — against nearly nineteen M3+. Asserted as counts rather
    // than probabilities because the count is what the table shows and what
    // goes illegible; the ratio is exactly 100 because b = 1 and the bins are
    // two magnitude units apart.
    const forecast = forecastAftershocks(5.5, NOW, NOW);
    const week = 1;
    const big = row(forecast, 5).windows[week]!;
    const small = row(forecast, 3).windows[week]!;

    expect(big.expected).toBeLessThan(0.25);
    expect(big.low).toBe(0);
    expect(big.high).toBeLessThanOrEqual(1);

    expect(small.expected).toBeGreaterThan(10);
    expect(small.high).toBeGreaterThan(big.high);
    expect(small.expected / big.expected).toBeCloseTo(100, 6);
  });

  it('falls monotonically with magnitude, in every window', () => {
    // Gutenberg-Richter: a bigger bin can never be more likely than a smaller
    // one. A row ordering or indexing slip would break this and nothing else.
    const forecast = forecastAftershocks(7.2, NOW - 2 * DAY, NOW);
    for (let w = 0; w < FORECAST_WINDOWS_HOURS.length; w += 1) {
      for (let i = 1; i < forecast.rows.length; i += 1) {
        expect(forecast.rows[i]!.windows[w]!.expected).toBeLessThan(
          forecast.rows[i - 1]!.windows[w]!.expected,
        );
      }
    }
  });

  it('rises monotonically with window length, in every bin', () => {
    const forecast = forecastAftershocks(7.2, NOW - 2 * DAY, NOW);
    for (const r of forecast.rows) {
      for (let w = 1; w < r.windows.length; w += 1) {
        expect(r.windows[w]!.expected).toBeGreaterThan(r.windows[w - 1]!.expected);
      }
    }
  });

  it('keeps every M1 parameter unchanged — only the reporting was amended', () => {
    // Rule 3: M1b amends what is reported, not the model. If any of these move,
    // it is a different registration.
    expect([RJ_A, RJ_B, RJ_P, RJ_C_DAYS]).toEqual([-1.97, 1.0, 0.92, 0.018]);
  });
});
