import { describe, expect, it } from 'vitest';
import { formatCount, formatPValue, formatRatio, formatStatistic } from './result-format';

describe('formatPValue', () => {
  it('never prints "p = 0"', () => {
    expect(formatPValue(0)).toBe('p < 0.0001');
  });

  it('prints a bound below the readable threshold rather than false precision', () => {
    expect(formatPValue(1 / 10_001)).toBe('p < 0.0001');
  });

  it('prints an ordinary value to four decimal places', () => {
    expect(formatPValue(0.0328)).toBe('p = 0.0328');
  });

  it('treats a non-finite input the same as an extreme one', () => {
    expect(formatPValue(NaN)).toBe('p < 0.0001');
  });
});

describe('formatRatio', () => {
  it('formats a finite ratio to two decimal places with a multiplication sign', () => {
    expect(formatRatio(57.445219899376255)).toBe('57.45×');
  });

  it('never prints "NaN×" for an undefined ratio (zero exposure)', () => {
    expect(formatRatio(NaN)).toBe('—');
  });

  it('never prints "Infinity×"', () => {
    expect(formatRatio(Infinity)).toBe('—');
  });
});

describe('formatCount', () => {
  it('adds thousands separators for readability at real catalogue sizes', () => {
    expect(formatCount(92368)).toBe('92,368');
  });

  it('handles zero', () => {
    expect(formatCount(0)).toBe('0');
  });
});

describe('formatStatistic', () => {
  it('falls back to the ratio form when the statistic really is a ratio', () => {
    // H4c/H3b/H1b send no label, meaning observed/expected.
    expect(formatStatistic(1.0234, null)).toBe('1.02×');
  });

  it('drops the × for a statistic that is not a ratio', () => {
    // H5's KS D⁺ of 0.07 under the old formatter read as "0.07×" — a supremum
    // CDF difference presented as "7% of the baseline rate". The column header
    // carries the name, so the cell must not repeat it either.
    expect(formatStatistic(0.0712, 'KS D⁺')).toBe('0.071');
  });

  it('keeps three decimals for a labelled statistic, not two', () => {
    // A KS D lives in [0,1] and its interesting range is small; two decimals
    // collapses distinguishable values onto the same string.
    expect(formatStatistic(0.0004, 'KS D⁺')).toBe('0.000');
    expect(formatStatistic(0.0016, 'KS D⁺')).toBe('0.002');
  });

  it('shows an em dash for a non-finite value either way', () => {
    expect(formatStatistic(Number.NaN, null)).toBe('—');
    expect(formatStatistic(Number.NaN, 'KS D⁺')).toBe('—');
  });
});
