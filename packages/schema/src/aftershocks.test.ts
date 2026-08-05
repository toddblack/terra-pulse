import { describe, expect, it } from 'vitest';
import {
  SEQUENCE_BINS,
  SEQUENCE_MIN_MAGNITUDE,
  gardnerKnopoffRadiusKm,
  gardnerKnopoffWindowDays,
  haversineKm,
  sequenceSearchBoxes,
  summariseSequence,
} from './aftershocks';
import { ARCHIVE_MIN_MAGNITUDE } from './archive';
import type { BoundingBox, EarthquakeEvent } from './earthquake';

function event(overrides: Partial<EarthquakeEvent> & { id: string }): EarthquakeEvent {
  return {
    source: 'usgs',
    magnitude: 5,
    magnitudeType: 'mww',
    place: 'somewhere',
    timeUtc: '2020-01-01T00:00:00.000Z',
    updatedUtc: '2020-01-01T00:00:00.000Z',
    longitude: 0,
    latitude: 0,
    depthKm: 10,
    status: 'reviewed',
    tsunami: false,
    alertLevel: null,
    significance: null,
    url: 'https://example.test',
    ...overrides,
  };
}

/**
 * The windows are the whole basis for calling anything an aftershock, so they
 * are checked against Gardner & Knopoff's published Table 1 rather than against
 * whatever the formula happened to return when it was written. A transposed
 * coefficient would otherwise be invisible — every value would still look
 * plausible.
 *
 * Tolerances are the fit's own: the analytic form approximates the table to a
 * few percent, so these assert agreement to 5%, not equality.
 */
describe('Gardner-Knopoff windows against the published table', () => {
  it.each([
    { magnitude: 5.0, tabulatedKm: 40 },
    { magnitude: 5.5, tabulatedKm: 47 },
    { magnitude: 6.0, tabulatedKm: 54 },
    { magnitude: 6.5, tabulatedKm: 61 },
    { magnitude: 7.0, tabulatedKm: 70 },
    { magnitude: 7.5, tabulatedKm: 81 },
    { magnitude: 8.0, tabulatedKm: 94 },
  ])('radius at M$magnitude is within 5% of $tabulatedKm km', ({ magnitude, tabulatedKm }) => {
    expect(gardnerKnopoffRadiusKm(magnitude)).toBeCloseTo(tabulatedKm, -0.5);
    expect(Math.abs(gardnerKnopoffRadiusKm(magnitude) - tabulatedKm) / tabulatedKm).toBeLessThan(
      0.05,
    );
  });

  it.each([
    { magnitude: 5.0, tabulatedDays: 155 },
    { magnitude: 6.0, tabulatedDays: 510 },
    { magnitude: 7.0, tabulatedDays: 915 },
    { magnitude: 7.5, tabulatedDays: 960 },
    { magnitude: 8.0, tabulatedDays: 985 },
  ])('window at M$magnitude is within 10% of $tabulatedDays days', ({ magnitude, tabulatedDays }) => {
    expect(
      Math.abs(gardnerKnopoffWindowDays(magnitude) - tabulatedDays) / tabulatedDays,
    ).toBeLessThan(0.1);
  });

  it('saturates near 1000 days rather than growing without bound', () => {
    // The point of the M6.5 branch. Without it the sub-6.5 fit would put an M9
    // window at over 100 years, and every large event would claim a decade of
    // unrelated seismicity as its own sequence.
    expect(gardnerKnopoffWindowDays(9.1)).toBeLessThan(1200);
    expect(gardnerKnopoffWindowDays(9.1)).toBeGreaterThan(900);
  });

  it('grows monotonically in radius across the whole range', () => {
    for (let m = 5; m < 9; m += 0.1) {
      expect(gardnerKnopoffRadiusKm(m + 0.1)).toBeGreaterThan(gardnerKnopoffRadiusKm(m));
    }
  });

  it('grows monotonically in time within each branch', () => {
    for (let m = 5; m < 6.4; m += 0.1) {
      expect(gardnerKnopoffWindowDays(m + 0.1)).toBeGreaterThan(gardnerKnopoffWindowDays(m));
    }
    for (let m = 6.5; m < 9; m += 0.1) {
      expect(gardnerKnopoffWindowDays(m + 0.1)).toBeGreaterThan(gardnerKnopoffWindowDays(m));
    }
  });

  /**
   * Pins the discontinuity rather than asserting it away. The published
   * piecewise fit steps *down* at M6.5; this test exists so that if the numbers
   * ever change, it is because someone changed them on purpose. See the note on
   * `gardnerKnopoffWindowDays` for why it isn't smoothed.
   */
  it('steps down by a known ~5% at the M6.5 branch point', () => {
    const justBelow = gardnerKnopoffWindowDays(6.4999);
    const atBoundary = gardnerKnopoffWindowDays(6.5);
    expect(justBelow).toBeGreaterThan(atBoundary);
    expect(justBelow - atBoundary).toBeCloseTo(45.8, 0);
    expect(1 - atBoundary / justBelow).toBeLessThan(0.06);
  });
});

describe('haversineKm', () => {
  it('is zero for a point against itself', () => {
    expect(haversineKm({ latitude: 35, longitude: 139 }, { latitude: 35, longitude: 139 })).toBe(0);
  });

  it('measures a degree of latitude as ~111 km', () => {
    expect(haversineKm({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 })).toBeCloseTo(
      111.19,
      1,
    );
  });

  it('converges longitude at high latitude', () => {
    // The reason the query cannot use a fixed degree box: a degree of longitude
    // is ~111 km at the equator and ~54 km at 61°N.
    const equator = haversineKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 });
    const anchorage = haversineKm({ latitude: 61, longitude: 0 }, { latitude: 61, longitude: 1 });
    expect(anchorage).toBeLessThan(equator * 0.55);
  });

  it('handles the antimeridian without going the long way round', () => {
    const km = haversineKm({ latitude: 0, longitude: 179.5 }, { latitude: 0, longitude: -179.5 });
    expect(km).toBeCloseTo(111.19, 0);
  });
});

describe('sequenceSearchBoxes', () => {
  const contains = (boxes: ReturnType<typeof sequenceSearchBoxes>, lat: number, lon: number) =>
    boxes.some(
      (box) =>
        lon >= box.minLon && lon <= box.maxLon && lat >= box.minLat && lat <= box.maxLat,
    );

  it('returns a single box well inside the map', () => {
    const boxes = sequenceSearchBoxes({ latitude: 35, longitude: 139 }, 100);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.minLon).toBeLessThan(139);
    expect(boxes[0]?.maxLon).toBeGreaterThan(139);
  });

  it('covers every point actually within the radius', () => {
    // The box only has to be a superset — but it does have to be one, or the
    // haversine filter never sees the events it would have kept.
    const center = { latitude: 35, longitude: 139 };
    const boxes = sequenceSearchBoxes(center, 100);
    for (let bearing = 0; bearing < 360; bearing += 15) {
      const rad = (bearing * Math.PI) / 180;
      const dLat = (99 / 111.32) * Math.cos(rad);
      const dLon = (99 / (111.32 * Math.cos((center.latitude * Math.PI) / 180))) * Math.sin(rad);
      expect(contains(boxes, center.latitude + dLat, center.longitude + dLon)).toBe(true);
    }
  });

  /**
   * The failure this function exists to prevent. A naive box around 179°E runs
   * from 177 to 182; SQLite compares those numerically and returns nothing, so
   * an M8 in the Kurils would have reported a clean zero.
   */
  it('splits across the antimeridian instead of producing an impossible box', () => {
    const boxes = sequenceSearchBoxes({ latitude: 50, longitude: 179 }, 200);
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      expect(box.minLon).toBeLessThanOrEqual(box.maxLon);
      expect(box.minLon).toBeGreaterThanOrEqual(-180);
      expect(box.maxLon).toBeLessThanOrEqual(180);
    }
    // A point just the other side of the line is inside the search area.
    expect(contains(boxes, 50, -179.5)).toBe(true);
    expect(contains(boxes, 50, 179.5)).toBe(true);
  });

  it('splits the same way from the western side', () => {
    const boxes = sequenceSearchBoxes({ latitude: -20, longitude: -179 }, 200);
    expect(boxes).toHaveLength(2);
    expect(contains(boxes, -20, 179.5)).toBe(true);
    expect(contains(boxes, -20, -178.5)).toBe(true);
  });

  it('widens longitude with latitude', () => {
    const equator = sequenceSearchBoxes({ latitude: 0, longitude: 0 }, 100)[0];
    const high = sequenceSearchBoxes({ latitude: 65, longitude: 0 }, 100)[0];
    const span = (box: BoundingBox | undefined) => (box ? box.maxLon - box.minLon : 0);
    expect(span(high)).toBeGreaterThan(span(equator) * 2);
  });

  it('falls back to the whole world near the pole rather than dividing by zero', () => {
    const boxes = sequenceSearchBoxes({ latitude: 89.9, longitude: 12 }, 130);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.minLon).toBe(-180);
    expect(boxes[0]?.maxLon).toBe(180);
  });

  it('never lets latitude escape the map', () => {
    const boxes = sequenceSearchBoxes({ latitude: 89, longitude: 0 }, 500);
    for (const box of boxes) {
      expect(box.minLat).toBeGreaterThanOrEqual(-90);
      expect(box.maxLat).toBeLessThanOrEqual(90);
    }
  });
});

describe('summariseSequence', () => {
  const mainshock = { magnitude: 7.0, timeUtc: '2020-01-01T00:00:00.000Z' };
  const originMs = Date.parse(mainshock.timeUtc);
  const hours = (n: number) => new Date(originMs + n * 3600_000).toISOString();
  /** Past the end of an M7's 918-day window, so every bin is fully observed. */
  const ORIGIN_MS_AFTER_WINDOW = originMs + 1000 * 24 * 3600_000;

  it('counts at the archive floor, not at whatever the view is showing', () => {
    expect(SEQUENCE_MIN_MAGNITUDE).toBe(ARCHIVE_MIN_MAGNITUDE);
    const summary = summariseSequence(mainshock, [], originMs);
    expect(summary.minMagnitude).toBe(4.5);
  });

  it('reports an empty sequence without inventing a largest', () => {
    const summary = summariseSequence(mainshock, [], originMs);
    expect(summary.count).toBe(0);
    expect(summary.largest).toBeNull();
    expect(summary.largestAfterHours).toBeNull();
    expect(summary.exceededMainshock).toBe(false);
  });

  it('finds the largest aftershock and how long after it landed', () => {
    const summary = summariseSequence(
      mainshock,
      [
        event({ id: 'a', magnitude: 4.8, timeUtc: hours(2) }),
        event({ id: 'b', magnitude: 6.1, timeUtc: hours(30) }),
        event({ id: 'c', magnitude: 5.2, timeUtc: hours(100) }),
      ],
      originMs,
    );
    expect(summary.count).toBe(3);
    expect(summary.largest?.id).toBe('b');
    expect(summary.largestAfterHours).toBe(30);
    expect(summary.exceededMainshock).toBe(false);
  });

  it('breaks a magnitude tie towards the earlier event', () => {
    const summary = summariseSequence(
      mainshock,
      // Deliberately supplied out of time order — the summary sorts, so the
      // tie-break cannot depend on how the caller happened to hand them over.
      [
        event({ id: 'later', magnitude: 6.2, timeUtc: hours(200) }),
        event({ id: 'earlier', magnitude: 6.2, timeUtc: hours(20) }),
      ],
      originMs,
    );
    expect(summary.largest?.id).toBe('earlier');
  });

  /**
   * The case that makes the panel wrong about its own subject: something bigger
   * followed, so the selected event was a foreshock and the window was sized to
   * the wrong magnitude. It has to be flagged, not quietly folded into a count.
   */
  it('flags a mainshock that was actually a foreshock', () => {
    const summary = summariseSequence(
      { magnitude: 6.0, timeUtc: mainshock.timeUtc },
      [event({ id: 'real', magnitude: 7.4, timeUtc: hours(9) })],
      originMs,
    );
    expect(summary.exceededMainshock).toBe(true);
    expect(summary.largest?.magnitude).toBe(7.4);
  });

  it('does not flag an aftershock of exactly the mainshock magnitude', () => {
    // Equal is not exceeded. A doublet is not evidence the first was a
    // foreshock, and the wording the flag drives would say it was.
    const summary = summariseSequence(
      mainshock,
      [event({ id: 'twin', magnitude: 7.0, timeUtc: hours(50) })],
      originMs,
    );
    expect(summary.exceededMainshock).toBe(false);
  });

  const settled = ORIGIN_MS_AFTER_WINDOW;

  it('bins by time since the mainshock on the log ladder', () => {
    const summary = summariseSequence(
      mainshock,
      [
        event({ id: 'a', magnitude: 5, timeUtc: hours(1) }),
        event({ id: 'b', magnitude: 5, timeUtc: hours(23) }),
        event({ id: 'c', magnitude: 5, timeUtc: hours(48) }),
        event({ id: 'd', magnitude: 5, timeUtc: hours(24 * 20) }),
        event({ id: 'e', magnitude: 5, timeUtc: hours(24 * 100) }),
        event({ id: 'f', magnitude: 5, timeUtc: hours(24 * 300) }),
      ],
      settled,
    );
    expect(summary.bins.map((bin) => bin.count)).toEqual([2, 1, 1, 1, 1]);
    expect(summary.bins.map((bin) => bin.label)).toEqual(SEQUENCE_BINS.map((bin) => bin.label));
  });

  it('puts an event exactly on a bin boundary in the later bin', () => {
    const summary = summariseSequence(
      mainshock,
      [event({ id: 'boundary', magnitude: 5, timeUtc: hours(24) })],
      settled,
    );
    expect(summary.bins[0]?.count).toBe(0);
    expect(summary.bins[1]?.count).toBe(1);
  });

  it('drops nothing on an unparseable timestamp', () => {
    // NaN compares false against every bound, so the naive version wrote to
    // counts[-1] and the event disappeared from the strip while still counting.
    const summary = summariseSequence(
      mainshock,
      [event({ id: 'bad', magnitude: 5, timeUtc: 'not a date' })],
      settled,
    );
    expect(summary.count).toBe(1);
    expect(summary.bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(0);
  });

  /**
   * The correction that turned a misleading strip into a correct one. Log-spaced
   * bins are wildly unequal in width, so raw counts across them describe the
   * bins rather than the sequence — and describe it backwards.
   */
  describe('per-day rates', () => {
    it('divides each bin by the days it actually covers', () => {
      const summary = summariseSequence(
        mainshock,
        [
          // 2 events in the 1-day bin -> 2/day.
          event({ id: 'a', magnitude: 5, timeUtc: hours(1) }),
          event({ id: 'b', magnitude: 5, timeUtc: hours(2) }),
          // 6 events in the 6-day bin -> 1/day.
          ...[25, 30, 50, 80, 120, 160].map((h, i) =>
            event({ id: `w${i}`, magnitude: 5, timeUtc: hours(h) }),
          ),
        ],
        settled,
      );
      expect(summary.bins[0]?.observedDays).toBe(1);
      expect(summary.bins[0]?.perDay).toBeCloseTo(2, 5);
      expect(summary.bins[1]?.observedDays).toBe(6);
      expect(summary.bins[1]?.perDay).toBeCloseTo(1, 5);
    });

    /**
     * Tohoku's real counts. As raw counts the strip rises left to right; as a
     * rate it falls by nearly three orders of magnitude, which is Omori decay.
     */
    it('turns Tohoku-shaped counts into a decaying rate', () => {
      const counts = [182, 236, 204, 223, 289];
      const events = counts.flatMap((count, binIndex) =>
        Array.from({ length: count }, (_, i) => {
          const bin = SEQUENCE_BINS[binIndex];
          if (bin === undefined) throw new Error('missing bin');
          const span = (bin.toHours === Number.POSITIVE_INFINITY ? 24 * 1071 : bin.toHours) - bin.fromHours;
          return event({
            id: `b${binIndex}-${i}`,
            magnitude: 5,
            timeUtc: hours(bin.fromHours + (span * (i + 0.5)) / count),
          });
        }),
      );

      const summary = summariseSequence(
        { magnitude: 9.1, timeUtc: mainshock.timeUtc },
        events,
        originMs + 1200 * 24 * 3600_000,
      );

      const rates = summary.bins.map((bin) => bin.perDay ?? 0);
      expect(summary.bins.map((bin) => bin.count)).toEqual(counts);
      // The counts rise; the rates must fall, monotonically.
      for (let i = 1; i < rates.length; i += 1) {
        expect(rates[i]).toBeLessThan(rates[i - 1] as number);
      }
      expect(rates[0]).toBeGreaterThan(100);
      expect(rates[4]).toBeLessThan(1);
    });

    it('leaves a bin that has not elapsed as null, not zero', () => {
      // Three days after an M7: the month and half-year bins have not happened.
      // A zero there would claim a quiet period rather than an unmeasured one.
      const summary = summariseSequence(mainshock, [], originMs + 3 * 24 * 3600_000);
      expect(summary.bins[0]?.perDay).toBe(0);
      expect(summary.bins[1]?.perDay).toBe(0);
      expect(summary.bins[3]?.perDay).toBeNull();
      expect(summary.bins[4]?.perDay).toBeNull();
    });

    it('measures a partly-elapsed bin over the part that elapsed', () => {
      // 4 days in: the 1-7d bin has covered 3 of its 6 days.
      const summary = summariseSequence(
        mainshock,
        [event({ id: 'x', magnitude: 5, timeUtc: hours(30) })],
        originMs + 4 * 24 * 3600_000,
      );
      expect(summary.bins[1]?.observedDays).toBeCloseTo(3, 5);
      expect(summary.bins[1]?.perDay).toBeCloseTo(1 / 3, 5);
    });

    it('caps the open-ended last bin at the window, not at infinity', () => {
      // Without the window cap the final bin divides by Infinity and every long
      // sequence reports a rate of zero.
      const summary = summariseSequence(mainshock, [], settled);
      const last = summary.bins[4];
      expect(last?.observedDays).toBeGreaterThan(0);
      expect(Number.isFinite(last?.observedDays)).toBe(true);
      expect(last?.observedDays).toBeCloseTo(gardnerKnopoffWindowDays(7) - 180, 5);
    });
  });

  /**
   * The distinction between "this sequence is over" and "this sequence is three
   * days old". Without it a partial count is reported in the same voice as a
   * settled one.
   */
  describe('elapsedFraction', () => {
    it('is 0 at the instant of the mainshock', () => {
      expect(summariseSequence(mainshock, [], originMs).elapsedFraction).toBe(0);
    });

    it('is a fraction while the window is still running', () => {
      const windowMs = gardnerKnopoffWindowDays(7) * 24 * 3600_000;
      const summary = summariseSequence(mainshock, [], originMs + windowMs / 4);
      expect(summary.elapsedFraction).toBeCloseTo(0.25, 5);
    });

    it('clamps to 1 once the window has passed, however long ago', () => {
      const summary = summariseSequence(mainshock, [], originMs + 50 * 365 * 24 * 3600_000);
      expect(summary.elapsedFraction).toBe(1);
    });

    it('clamps to 0 rather than going negative under a playhead in the past', () => {
      // The playhead can sit before the selected event, and a negative fraction
      // would render as a reversed progress bar.
      const summary = summariseSequence(mainshock, [], originMs - 86_400_000);
      expect(summary.elapsedFraction).toBe(0);
    });
  });
});
