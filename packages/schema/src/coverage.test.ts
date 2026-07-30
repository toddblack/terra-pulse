import { describe, expect, it } from 'vitest';
import {
  COVERAGE_TIERS,
  MAGNITUDE_FLOORS,
  coverageTierFor,
  ingestPasses,
  longestCoverageHours,
  magnitudeFloorsForWindow,
  minMagnitudeForWindow,
  nextMagnitudeFloorAbove,
} from './earthquake';

describe('coverage tiers', () => {
  it('offers only floors that exist in the shared list', () => {
    // A tier floor absent from MAGNITUDE_FLOORS would be unreachable: the
    // selector would clamp up to a value it never renders a button for.
    for (const tier of COVERAGE_TIERS) {
      expect(MAGNITUDE_FLOORS).toContain(tier.minMagnitude);
    }
  });

  it('never lowers its floor as the span grows', () => {
    // Ordered longest-covering-least. A dip would mean a longer window claiming
    // deeper coverage than a shorter one, which ingest cannot deliver.
    const sorted = [...COVERAGE_TIERS].sort((a, b) => a.windowHours - b.windowHours);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]!.minMagnitude).toBeGreaterThanOrEqual(sorted[i - 1]!.minMagnitude);
    }
  });

  it('gives every tier a distinct window', () => {
    const windows = COVERAGE_TIERS.map((tier) => tier.windowHours);
    expect(new Set(windows).size).toBe(windows.length);
  });
});

describe('every offered view is one ingest actually fetches', () => {
  /**
   * The reason `COVERAGE_TIERS` is shared between main and renderer at all.
   *
   * If the selectors could offer a (span, magnitude) pair no ingest pass
   * covers, the globe would come up empty and look like a quiet month rather
   * than a fetch that never happened.
   */
  it.each(COVERAGE_TIERS.map((tier) => [tier.label, tier] as const))(
    '%s is covered by an ingest pass',
    (_label, tier) => {
      const covering = ingestPasses().filter(
        (pass) =>
          pass.windowHours >= tier.windowHours && pass.minMagnitude <= tier.minMagnitude,
      );
      expect(covering.length).toBeGreaterThan(0);
    },
  );

  it('covers every floor the selector offers for each span', () => {
    for (const tier of COVERAGE_TIERS) {
      for (const floor of magnitudeFloorsForWindow(tier.windowHours)) {
        const covered = ingestPasses().some(
          (pass) => pass.windowHours >= tier.windowHours && pass.minMagnitude <= floor,
        );
        expect(covered, `${tier.label} at M${floor}+`).toBe(true);
      }
    }
  });
});

describe('ingestPasses', () => {
  it('collapses tiers sharing a floor into one fetch', () => {
    // Four of the five tiers sit at M1, so they cost one request, not four.
    expect(ingestPasses().length).toBeLessThan(COVERAGE_TIERS.length);
  });

  it('keeps the longest window for each distinct floor', () => {
    for (const pass of ingestPasses()) {
      const sameFloor = COVERAGE_TIERS.filter((t) => t.minMagnitude === pass.minMagnitude);
      expect(pass.windowHours).toBe(Math.max(...sameFloor.map((t) => t.windowHours)));
    }
  });

  it('covers one distinct floor each, with none missed', () => {
    const passFloors = ingestPasses().map((pass) => pass.minMagnitude);
    expect(new Set(passFloors).size).toBe(passFloors.length);
    expect(new Set(passFloors)).toEqual(new Set(COVERAGE_TIERS.map((t) => t.minMagnitude)));
  });
});

describe('minMagnitudeForWindow', () => {
  it('returns the tier floor for a known window', () => {
    expect(minMagnitudeForWindow(24)).toBe(1);
    expect(minMagnitudeForWindow(720)).toBe(2.5);
  });

  it('falls back to the strictest floor for an unknown window', () => {
    // Showing less than exists is recoverable; showing an empty globe as
    // though it were a quiet month is not.
    const strictest = Math.max(...COVERAGE_TIERS.map((t) => t.minMagnitude));
    expect(minMagnitudeForWindow(99999)).toBe(strictest);
  });
});

describe('magnitudeFloorsForWindow', () => {
  it('offers every floor on the shortest span', () => {
    expect(magnitudeFloorsForWindow(24)).toEqual(MAGNITUDE_FLOORS);
  });

  it('drops floors below what the span was ingested at', () => {
    expect(magnitudeFloorsForWindow(720)).not.toContain(1);
    expect(magnitudeFloorsForWindow(720)).toContain(2.5);
  });

  it('never returns an empty list', () => {
    for (const tier of COVERAGE_TIERS) {
      expect(magnitudeFloorsForWindow(tier.windowHours).length).toBeGreaterThan(0);
    }
  });
});

describe('longestCoverageHours', () => {
  it('matches the longest tier, since it is the pruning horizon', () => {
    // Pruning to less than this would delete data a selectable span needs.
    expect(longestCoverageHours()).toBe(Math.max(...COVERAGE_TIERS.map((t) => t.windowHours)));
  });
});

describe('coverageTierFor', () => {
  it('finds a known window and rejects an unknown one', () => {
    expect(coverageTierFor(168)?.label).toBe('7d');
    expect(coverageTierFor(1)).toBeUndefined();
  });
});

describe('nextMagnitudeFloorAbove', () => {
  it('turns each floor into a band', () => {
    expect(nextMagnitudeFloorAbove(1)).toBe(2.5);
    expect(nextMagnitudeFloorAbove(2.5)).toBe(4.5);
    expect(nextMagnitudeFloorAbove(4.5)).toBe(5.5);
  });

  it('returns null at the top, where there is nothing to hide', () => {
    // The UI uses this to omit the isolate control rather than render a
    // checkbox that does nothing.
    expect(nextMagnitudeFloorAbove(5.5)).toBeNull();
  });

  it('has a ceiling for every floor except the last', () => {
    const withCeiling = MAGNITUDE_FLOORS.filter((m) => nextMagnitudeFloorAbove(m) !== null);
    expect(withCeiling).toHaveLength(MAGNITUDE_FLOORS.length - 1);
  });

  it('handles a value between floors', () => {
    expect(nextMagnitudeFloorAbove(3)).toBe(4.5);
  });
});
