import { describe, expect, it } from 'vitest';
import { GNSS_BEFORE_SPANS, GNSS_MAX_BEFORE_DAYS, gnssEligible, gnssQuakeDayMs, gnssReachKm } from './gnss';

describe('gnssReachKm', () => {
  it("is the lab's own rule, matching the distances its readme lists", () => {
    // steps_readme.txt lists 162, 512, 1622 and 5129 km for M6-M9. Its own
    // rounding is uneven — 512.86 is printed 512, 5128.6 is printed 5129 —
    // so the check is to the kilometre, not exact.
    for (const [magnitude, listed] of [[6, 162], [7, 512], [8, 1622], [9, 5129]] as const) {
      expect(Math.abs(gnssReachKm(magnitude) - listed)).toBeLessThan(1);
    }
  });
});

describe('gnssQuakeDayMs', () => {
  it("is midnight UTC of the quake's day", () => {
    // Ridgecrest M7.1, 2019-07-06 03:19 UTC.
    expect(gnssQuakeDayMs(Date.parse('2019-07-06T03:19:53Z'))).toBe(Date.UTC(2019, 6, 6));
    expect(gnssQuakeDayMs(Date.UTC(2019, 6, 6))).toBe(Date.UTC(2019, 6, 6));
  });
});

describe('the spans', () => {
  it('have the longest one equal to what main fetches', () => {
    expect(Math.max(...GNSS_BEFORE_SPANS.map((s) => s.days))).toBe(GNSS_MAX_BEFORE_DAYS);
  });
});

describe('gnssEligible', () => {
  it('offers the window from M6', () => {
    expect(gnssEligible({ magnitude: 6 })).toBe(true);
    expect(gnssEligible({ magnitude: 5.9 })).toBe(false);
  });
});
