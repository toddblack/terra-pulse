import { describe, expect, it } from 'vitest';
import { dstBackfillYears } from './space-weather';
import { DST_START_YEAR, KP_START_YEAR } from '@terra-pulse/schema';

describe('dstBackfillYears', () => {
  it('starts where OMNI does, not where the record does', () => {
    // Kp reaches 1932 via GFZ, but that arrives in one request and has no year
    // loop. This list is Dst only, so it must start at OMNI's 1963 — asking
    // OMNI for 1932 would be 31 straight 404s.
    expect(dstBackfillYears(2026)[0]).toBe(DST_START_YEAR);
    expect(dstBackfillYears(2026)).not.toContain(KP_START_YEAR);
  });

  it('runs oldest first, so an interrupted backfill leaves a contiguous span', () => {
    const years = dstBackfillYears(2026);
    expect(years[years.length - 1]).toBe(2026);
    expect([...years].sort((a, b) => a - b)).toEqual(years);
  });

  it('covers every year inclusive of the current one', () => {
    expect(dstBackfillYears(2026)).toHaveLength(2026 - DST_START_YEAR + 1);
  });

  it('is empty when asked for a year before the record', () => {
    expect(dstBackfillYears(1900)).toEqual([]);
  });
});
