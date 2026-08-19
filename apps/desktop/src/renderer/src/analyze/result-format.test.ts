import { describe, expect, it } from 'vitest';
import { formatCount, formatPValue, formatRatio } from './result-format';

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
