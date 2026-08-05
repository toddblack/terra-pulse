import { describe, expect, it } from 'vitest';
import {
  ALERT_MIN_MAGNITUDE,
  COVERAGE_TIERS,
  MAGNITUDE_FLOORS,
  coverageTierFor,
  ingestPasses,
  longestCoverageHours,
  magnitudeFloorsForWindow,
  minMagnitudeForWindow,
  nextMagnitudeFloorAbove,
  offeredWindowHours,
  previousWindowHours,
} from './earthquake';
import { ARCHIVE_MIN_MAGNITUDE, ARCHIVE_SPANS, archiveSpanHours } from './archive';

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

describe('archive spans stay out of ingest', () => {
  // The trap this guards is expensive and silent: main loops COVERAGE_TIERS to
  // decide what to fetch on launch, so an archive span leaking into that list
  // would make the app try to re-download 57 years of catalogue on every single
  // start. View spans are the renderer's business only.
  it('never appears as an ingest pass', () => {
    const archiveHours = new Set(ARCHIVE_SPANS.map(archiveSpanHours));
    for (const pass of ingestPasses()) {
      expect(archiveHours.has(pass.windowHours)).toBe(false);
    }
  });

  it('is longer than anything ingest fetches', () => {
    // A span shorter than the pruning horizon would be served by the rolling
    // cache and wouldn't need the archive at all — a sign the two lists had
    // drifted into overlapping.
    for (const span of ARCHIVE_SPANS) {
      expect(archiveSpanHours(span)).toBeGreaterThan(longestCoverageHours());
    }
  });

  it('never lowers its floor as the span grows', () => {
    const sorted = [...ARCHIVE_SPANS].sort((a, b) => a.years - b.years);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]!.minMagnitude).toBeGreaterThanOrEqual(sorted[i - 1]!.minMagnitude);
    }
  });

  it('offers only floors the selector can render a button for', () => {
    for (const span of ARCHIVE_SPANS) {
      expect(MAGNITUDE_FLOORS).toContain(span.minMagnitude);
    }
  });

  it('never offers a floor below the archive itself', () => {
    // Nothing under M4.5 exists before the rolling window, so offering it would
    // show an empty globe that reads as a quiet decade.
    for (const span of ARCHIVE_SPANS) {
      for (const floor of magnitudeFloorsForWindow(archiveSpanHours(span))) {
        expect(floor).toBeGreaterThanOrEqual(ARCHIVE_MIN_MAGNITUDE);
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
    // though it were a quiet month is not. The fallback spans both tier lists,
    // since an unrecognised window could be either kind.
    const strictest = Math.max(
      ...COVERAGE_TIERS.map((t) => t.minMagnitude),
      ...ARCHIVE_SPANS.map((s) => s.minMagnitude),
    );
    expect(minMagnitudeForWindow(99999)).toBe(strictest);
  });

  it('resolves archive spans, not just live tiers', () => {
    // One resolver for both, so the store's floor-auto-raise crosses the
    // live/archive boundary with no special case.
    for (const span of ARCHIVE_SPANS) {
      expect(minMagnitudeForWindow(archiveSpanHours(span))).toBe(span.minMagnitude);
    }
  });

  it('caps the M4.5-5.5 band at one year', () => {
    // The whole reason spans carry floors. 5y at M4.5 is 38,538 marks and the
    // full archive at M4.5 is an out-of-memory crash, measured.
    const oneYear = ARCHIVE_SPANS.find((s) => s.years === 1);
    const longer = ARCHIVE_SPANS.filter((s) => s.years > 1);

    expect(oneYear?.minMagnitude).toBe(4.5);
    for (const span of longer) {
      expect(span.minMagnitude).toBeGreaterThanOrEqual(5.5);
    }
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

describe('previousWindowHours', () => {
  it('steps down the ladder the selector already offers', () => {
    // The trailing window's length. Derived rather than a constant, so the
    // trail is always "one step of history" and adding a span can't leave it
    // stale.
    const offered = offeredWindowHours();

    for (let i = 1; i < offered.length; i++) {
      expect(previousWindowHours(offered[i]!)).toBe(offered[i - 1]);
    }
  });

  it('returns null at the shortest span, where a trail would be a no-op', () => {
    // The UI uses this to omit the checkbox, exactly as nextMagnitudeFloorAbove
    // does at the top floor.
    expect(previousWindowHours(Math.min(...offeredWindowHours()))).toBeNull();
  });

  it('spans the live/archive boundary in one ladder', () => {
    // The step below the shortest archive span is the longest live tier — the
    // two lists are one continuum for this purpose even though the UI groups
    // them separately.
    const shortestArchive = Math.min(...ARCHIVE_SPANS.map(archiveSpanHours));
    expect(previousWindowHours(shortestArchive)).toBe(longestCoverageHours());
  });

  it('is always shorter than the window it trails', () => {
    for (const hours of offeredWindowHours()) {
      const trail = previousWindowHours(hours);
      if (trail !== null) expect(trail).toBeLessThan(hours);
    }
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
    // checkbox that does nothing. Against the list's own top rather than a
    // literal, so adding a floor can't quietly make this assert nothing.
    const top = Math.max(...MAGNITUDE_FLOORS);
    expect(nextMagnitudeFloorAbove(top)).toBeNull();
  });

  it('has a ceiling for every floor except the last', () => {
    const withCeiling = MAGNITUDE_FLOORS.filter((m) => nextMagnitudeFloorAbove(m) !== null);
    expect(withCeiling).toHaveLength(MAGNITUDE_FLOORS.length - 1);
  });

  it('handles a value between floors', () => {
    expect(nextMagnitudeFloorAbove(3)).toBe(4.5);
  });
});

describe('alert threshold', () => {
  it('fires rarely enough to keep meaning something', () => {
    // Measured over 365 days: M5.5 is 1.3 alerts/day, M5.8 is one per 1.6 days,
    // M6 is one per 2.6 days. Anything at or below M5.5 crosses into daily,
    // where an alert stops being read.
    expect(ALERT_MIN_MAGNITUDE).toBeGreaterThan(5.5);
  });

  it('is not so high it never fires', () => {
    // M7 is ~16/year. A threshold people forget exists is its own failure.
    expect(ALERT_MIN_MAGNITUDE).toBeLessThan(7);
  });
});
