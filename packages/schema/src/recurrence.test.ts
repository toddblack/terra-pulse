import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MIN_INTERVALS_FOR_SUMMARY,
  RECURRENCE_FLOORS,
  RECURRENCE_MIN_MAGNITUDE,
  declusterGardnerKnopoff,
  recurrenceEpochYear,
  summariseRecurrence,
} from './recurrence';
import { ARCHIVE_ANALYSIS_MIN_MAGNITUDE } from './archive';
import type { EarthquakeEvent } from './earthquake';

const DAY_MS = 86_400_000;
const BASE = Date.parse('1990-01-01T00:00:00.000Z');

function quake(
  id: string,
  daysAfterBase: number,
  magnitude: number,
  latitude = 0,
  longitude = 0,
): EarthquakeEvent {
  return {
    id,
    source: 'usgs',
    magnitude,
    magnitudeType: 'mww',
    place: 'somewhere',
    timeUtc: new Date(BASE + daysAfterBase * DAY_MS).toISOString(),
    updatedUtc: new Date(BASE + daysAfterBase * DAY_MS).toISOString(),
    longitude,
    latitude,
    depthKm: 10,
    status: 'reviewed',
    tsunami: false,
    alertLevel: null,
    significance: null,
    url: 'https://example.test',
  };
}

describe('floors', () => {
  it('never offers a floor below the flat-since-1970 level', () => {
    // M4.5+ counts rose ~3x on network growth alone. A rate computed there
    // would shorten through the record for instrumental reasons and look like
    // rising seismicity.
    expect(RECURRENCE_MIN_MAGNITUDE).toBe(ARCHIVE_ANALYSIS_MIN_MAGNITUDE);
    for (const floor of RECURRENCE_FLOORS) {
      expect(floor).toBeGreaterThanOrEqual(RECURRENCE_MIN_MAGNITUDE);
    }
  });
});

describe('declusterGardnerKnopoff', () => {
  it('keeps a lone event', () => {
    const result = declusterGardnerKnopoff([quake('a', 0, 6)]);
    expect(result.map((e) => e.id)).toEqual(['a']);
  });

  it('removes an aftershock inside the window', () => {
    // An M6 window is ~54 km / ~510 days. A day later, same spot.
    const result = declusterGardnerKnopoff([quake('main', 0, 6), quake('after', 1, 5.6)]);
    expect(result.map((e) => e.id)).toEqual(['main']);
  });

  it('keeps an event beyond the time window', () => {
    const result = declusterGardnerKnopoff([quake('main', 0, 6), quake('later', 900, 5.6)]);
    expect(result.map((e) => e.id)).toEqual(['main', 'later']);
  });

  it('keeps an event beyond the distance window', () => {
    // ~222 km north, well outside an M6's ~54 km radius.
    const result = declusterGardnerKnopoff([quake('main', 0, 6), quake('far', 1, 5.6, 2)]);
    expect(result.map((e) => e.id).sort()).toEqual(['far', 'main']);
  });

  /**
   * Why the sweep is largest-first, and why an independent event can never be
   * demoted afterwards.
   *
   * `small` (M5.6, day 0) has a ~47 km / ~310 day window that happens to reach
   * `big` (M6.8, day 100, 40 km away). Sweeping earliest-first, the small shock
   * would swallow the large one — plainly wrong, and it would delete the very
   * event a recurrence count cares most about. Largest-first, `big` is decided
   * first and claims its own aftershock at day 300; `small` then survives on its
   * own merits and cannot retroactively claim `big`.
   */
  it('never lets a small early shock swallow a larger later one', () => {
    const result = declusterGardnerKnopoff([
      quake('small', 0, 5.6),
      quake('big', 100, 6.8, 0.36),
      quake('aftershock', 300, 5.7, 0.72),
    ]);
    expect(result.map((e) => e.id)).toEqual(['small', 'big']);
  });

  it('keeps the largest of a cluster when the big one comes first', () => {
    const result = declusterGardnerKnopoff([quake('big', 0, 6.8), quake('small-after', 2, 5.6)]);
    expect(result.map((e) => e.id)).toEqual(['big']);
  });

  it('gives the same answer whatever order the input arrives in', () => {
    const events = [
      quake('a', 0, 5.6),
      quake('b', 2, 6.8),
      quake('c', 5, 5.7),
      quake('d', 900, 6.1),
    ];
    const forward = declusterGardnerKnopoff(events).map((e) => e.id);
    const reversed = declusterGardnerKnopoff([...events].reverse()).map((e) => e.id);
    expect(reversed).toEqual(forward);
  });

  /**
   * Only *later* events are removed. Gardner-Knopoff also defines a foreshock
   * window, but for a recurrence count deleting earlier events is the one error
   * that directly inflates the interval being measured.
   */
  it('does not delete history preceding a large shock', () => {
    const result = declusterGardnerKnopoff([quake('earlier', 0, 5.6), quake('bigger', 3, 6.8)]);
    expect(result.map((e) => e.id)).toEqual(['earlier', 'bigger']);
  });

  it('returns events in time order', () => {
    const result = declusterGardnerKnopoff([quake('c', 900, 6), quake('a', 0, 6.5, 5)]);
    expect(result.map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('survives an unparseable timestamp without dropping everything', () => {
    const broken = { ...quake('bad', 0, 6), timeUtc: 'not a date' };
    const result = declusterGardnerKnopoff([broken, quake('good', 10, 6, 20)]);
    expect(result.map((e) => e.id)).toContain('good');
  });

  it('collapses a long aftershock sequence to one event', () => {
    // The measured effect: raw counts near Tokyo at M6+ give a 0.06 y median
    // gap, declustered 0.32 y. That factor is entirely this.
    const sequence = [quake('main', 0, 7)];
    for (let i = 1; i <= 40; i += 1) sequence.push(quake(`aft${i}`, i * 5, 5.6));
    expect(declusterGardnerKnopoff(sequence)).toHaveLength(1);
  });

  /**
   * Cross-language parity with the Phase 4 engine's independent Python port
   * (`engine/terra_pulse_engine/pipeline/decluster.py`). Both read the same
   * committed fixture — real M5.0+ events from 2011-01-01 to 2011-06-01
   * including the Tohoku M9.1 sequence — so if the two implementations ever
   * disagree on real data, this test fails on one side while
   * `engine/tests/test_decluster.py::test_cross_language_parity_fixture`
   * fails on the other. That pairing, not either test alone, is the signal.
   */
  it('agrees with the Python engine on a real 2011 slice (gk_parity.json)', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const fixturePath = join(__dirname, '../../../engine/tests/fixtures/gk_parity.json');
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
      events: { id: string; timeMs: number; latitude: number; longitude: number; magnitude: number }[];
      independentIds: string[];
    };

    const events: EarthquakeEvent[] = fixture.events.map((e) => ({
      id: e.id,
      source: 'usgs',
      magnitude: e.magnitude,
      magnitudeType: 'mww',
      place: 'fixture',
      timeUtc: new Date(e.timeMs).toISOString(),
      updatedUtc: new Date(e.timeMs).toISOString(),
      longitude: e.longitude,
      latitude: e.latitude,
      depthKm: 10,
      status: 'reviewed',
      tsunami: false,
      alertLevel: null,
      significance: null,
      url: 'https://example.test',
    }));

    const independentIds = declusterGardnerKnopoff(events)
      .map((e) => e.id)
      .sort();

    expect(independentIds).toEqual([...fixture.independentIds].sort());
  });
});

describe('summariseRecurrence', () => {
  const opts = (over: Partial<Parameters<typeof summariseRecurrence>[1]> = {}) => ({
    radiusKm: 300,
    minMagnitude: 6,
    rawCount: 0,
    nowMs: Date.parse('2026-01-01T00:00:00.000Z'),
    ...over,
  });

  it('reports nothing found without inventing an interval', () => {
    // Stable continental interiors genuinely return zero — measured, Denver has
    // no independent M5.5+ within 500 km since 1970. That is an answer.
    const summary = summariseRecurrence([], opts());
    expect(summary.independentCount).toBe(0);
    expect(summary.intervalsYears).toEqual([]);
    expect(summary.medianYears).toBeNull();
    expect(summary.sinceLastYears).toBeNull();
  });

  it('reports a single event as no interval at all', () => {
    // One event yields zero intervals: you cannot measure a gap from one point.
    const summary = summariseRecurrence([quake('a', 0, 6)], opts());
    expect(summary.independentCount).toBe(1);
    expect(summary.intervalsYears).toEqual([]);
    expect(summary.medianYears).toBeNull();
    expect(summary.sinceLastYears).toBeGreaterThan(0);
  });

  it('computes intervals between consecutive events', () => {
    const summary = summariseRecurrence(
      [quake('a', 0, 6), quake('b', 365.25, 6), quake('c', 365.25 * 3, 6)],
      opts(),
    );
    expect(summary.intervalsYears).toHaveLength(2);
    expect(summary.intervalsYears[0]).toBeCloseTo(1, 3);
    expect(summary.intervalsYears[1]).toBeCloseTo(2, 3);
  });

  /**
   * The refusal that keeps the panel honest. Kathmandu at M7+ yields two
   * intervals with a mean of 4.85 y and a median of 9.66 — both true, neither
   * meaningful.
   */
  it('withholds a median below the interval threshold', () => {
    const few = Array.from({ length: MIN_INTERVALS_FOR_SUMMARY }, (_, i) =>
      quake(`e${i}`, i * 400, 6),
    );
    const summary = summariseRecurrence(few, opts());
    expect(summary.intervalsYears).toHaveLength(MIN_INTERVALS_FOR_SUMMARY - 1);
    expect(summary.medianYears).toBeNull();
  });

  it('reports a median once there are enough intervals', () => {
    const enough = Array.from({ length: MIN_INTERVALS_FOR_SUMMARY + 1 }, (_, i) =>
      quake(`e${i}`, i * 365.25, 6),
    );
    const summary = summariseRecurrence(enough, opts());
    expect(summary.intervalsYears).toHaveLength(MIN_INTERVALS_FOR_SUMMARY);
    expect(summary.medianYears).toBeCloseTo(1, 3);
  });

  it('still reports the extremes below the threshold', () => {
    // Shortest and longest are facts at any count; only the summary statistic
    // is withheld. The panel lists the raw gaps in that case.
    const summary = summariseRecurrence([quake('a', 0, 6), quake('b', 730.5, 6)], opts());
    expect(summary.medianYears).toBeNull();
    expect(summary.shortestYears).toBeCloseTo(2, 3);
    expect(summary.longestYears).toBeCloseTo(2, 3);
  });

  it('measures time since the most recent event', () => {
    const summary = summariseRecurrence([quake('a', 0, 6)], {
      ...opts(),
      nowMs: BASE + 365.25 * 2 * DAY_MS,
    });
    expect(summary.sinceLastYears).toBeCloseTo(2, 2);
  });

  it('carries the raw count through so the declustering is visible', () => {
    // "142 recorded, 29 independent" is the honest framing; showing only the
    // second invites the reader to think the region is quieter than it is.
    const summary = summariseRecurrence([quake('a', 0, 6)], opts({ rawCount: 142 }));
    expect(summary.rawCount).toBe(142);
    expect(summary.independentCount).toBe(1);
  });

  it('is not confused by events supplied out of order', () => {
    const summary = summariseRecurrence(
      [quake('c', 365.25 * 3, 6), quake('a', 0, 6), quake('b', 365.25, 6)],
      opts(),
    );
    expect(summary.intervalsYears[0]).toBeCloseTo(1, 3);
    expect(summary.intervalsYears[1]).toBeCloseTo(2, 3);
  });
});

/**
 * Completeness is not uniform across magnitude, so the denominator for a rate
 * cannot be a single constant. M7.5+ is globally complete from 1900 (measured:
 * 0–3 events per decade before, 20–58 after); everything below only from 1970.
 */
describe('recurrenceEpochYear', () => {
  it('reaches 1900 at M7.5 and above', () => {
    expect(recurrenceEpochYear(7.5)).toBe(1900);
    expect(recurrenceEpochYear(8)).toBe(1900);
  });

  it('stays at 1970 below M7.5', () => {
    // Using 1900 at M6 would count seven near-empty decades as observation and
    // inflate every interval running through them.
    for (const floor of [5.5, 6, 6.5, 7, 7.49]) {
      expect(recurrenceEpochYear(floor)).toBe(1970);
    }
  });

  it('gives M7.5 a materially longer record', () => {
    const summary = summariseRecurrence([], {
      radiusKm: 300,
      minMagnitude: 7.5,
      rawCount: 0,
      nowMs: Date.parse('2026-01-01T00:00:00.000Z'),
    });
    expect(summary.epochYear).toBe(1900);
    expect(summary.observedYears).toBeGreaterThan(120);
  });

  it('reports the shorter record below the threshold', () => {
    const summary = summariseRecurrence([], {
      radiusKm: 300,
      minMagnitude: 6,
      rawCount: 0,
      nowMs: Date.parse('2026-01-01T00:00:00.000Z'),
    });
    expect(summary.epochYear).toBe(1970);
    expect(summary.observedYears).toBeLessThan(60);
  });
});
