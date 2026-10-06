import { describe, expect, it } from 'vitest';
import { arrivalOrder, asLiveRecords, gradeDetections, teleseismicPSeconds, type CatalogueQuake } from './detector-replay';
import type { MiniSeedDataRecord } from './miniseed';
import type { QuakeDetection } from './quake-detector';

const T0 = Date.parse('2026-10-01T12:00:00Z');

function record(channelId: string, startTimeMs: number, samples: number, rate = 100): MiniSeedDataRecord {
  return {
    kind: 'data',
    channel: { network: 'XX', station: channelId, location: '', channel: 'HHZ' },
    channelId,
    quality: 'D',
    encoding: 11,
    startTimeMs,
    sampleRateHz: rate,
    samples: new Int32Array(samples),
  };
}

describe('teleseismicPSeconds', () => {
  it('keeps the IASP91 table where the script used it', () => {
    expect(teleseismicPSeconds(30)).toBe(372);
    expect(teleseismicPSeconds(45)).toBeCloseTo(499, 0);
    expect(teleseismicPSeconds(150)).toBe(818);
  });

  it('uses a regional line below 20°, not the table extrapolated backwards', () => {
    // A Baja M7 500 km from Burbank: the extrapolated table said 130 s against
    // a real ~65 s, which would have aimed the replay window past the P wave.
    const deg = 500 / 111.19;
    expect(teleseismicPSeconds(deg)).toBeGreaterThan(60);
    expect(teleseismicPSeconds(deg)).toBeLessThan(75);
  });

  it('meets the table at 20° within a few seconds', () => {
    expect(Math.abs(teleseismicPSeconds(19.999) - teleseismicPSeconds(20))).toBeLessThan(8);
  });
});

describe('arrivalOrder', () => {
  it('releases a record only after its last sample plus transit', () => {
    const [a] = arrivalOrder([record('A', T0, 101)], 2_000);
    // 101 samples at 100 Hz: last sample 1.0 s after the first.
    expect(a!.arrivedAtMs).toBe(T0 + 1_000 + 2_000);
  });

  it('orders by when records would have landed, not when they started', () => {
    // A long, slow-filling record that started first lands after a short one
    // that started later — which is how a quiet station falls behind live.
    const slow = record('SLOW', T0, 700); // 7 s of data
    const fast = record('FAST', T0 + 2_000, 100); // 1 s of data
    expect(arrivalOrder([slow, fast]).map((r) => r.record.channelId)).toEqual(['FAST', 'SLOW']);
  });
});

describe('asLiveRecords', () => {
  it('leaves a 512-byte record alone', () => {
    const r = record('A', T0, 300);
    expect(asLiveRecords(r, 512)).toEqual([r]);
  });

  it('cuts a 4096-byte archive record into the nine live records its bytes would fill', () => {
    // 4032 data bytes / 448 per live record = 9.
    const r = record('A', T0, 900);
    const parts = asLiveRecords(r, 4096);
    expect(parts).toHaveLength(9);
    expect(parts.reduce((n, p) => n + p.samples.length, 0)).toBe(900);
    expect(parts[1]!.startTimeMs).toBe(T0 + 1_000);
    // So the first piece lands 8 s before the whole record would have.
    const [first] = arrivalOrder([parts[0]!], 2_000);
    const [whole] = arrivalOrder([r], 2_000);
    expect(whole!.arrivedAtMs - first!.arrivedAtMs).toBe(8_000);
  });
});

function detection(originMs: number, latitude: number, longitude: number, declaredAtMs: number): QuakeDetection {
  return { id: 0, originMs, latitude, longitude, picks: [], rmsS: 0, missedStations: [], declaredAtMs, magnitude: null };
}

function quake(id: string, originMs: number, latitude: number, longitude: number, magnitude = 3): CatalogueQuake {
  return { id, originMs, latitude, longitude, magnitude };
}

describe('gradeDetections', () => {
  it('matches a detection to its quake and measures how late it knew', () => {
    const grade = gradeDetections([detection(T0 + 500, 34.01, -118, T0 + 9_000)], [quake('q', T0, 34, -118)]);
    expect(grade.matched).toHaveLength(1);
    expect(grade.matched[0]!.declaredAfterOriginS).toBe(9);
    expect(grade.matched[0]!.originErrorS).toBe(0.5);
    expect(grade.spurious).toEqual([]);
    expect(grade.missed).toEqual([]);
  });

  it('counts a second detection of the same quake as a false alarm', () => {
    // Two alerts for one earthquake is two alerts to the person receiving them.
    const grade = gradeDetections(
      [detection(T0, 34, -118, T0 + 8_000), detection(T0 + 1_000, 34.02, -118, T0 + 12_000)],
      [quake('q', T0, 34, -118)],
    );
    expect(grade.matched).toHaveLength(1);
    expect(grade.matched[0]!.detection.declaredAtMs).toBe(T0 + 8_000);
    expect(grade.spurious).toHaveLength(1);
  });

  it('does not credit a detection to a quake elsewhere or at another time', () => {
    const grade = gradeDetections(
      [detection(T0, 34, -118, T0 + 8_000), detection(T0 + 60_000, 34, -118, T0 + 68_000)],
      [quake('far', T0, 36, -118), quake('later', T0 + 30_000, 34, -118)],
    );
    expect(grade.matched).toEqual([]);
    expect(grade.spurious).toHaveLength(2);
    expect(grade.missed.map((q) => q.id)).toEqual(['far', 'later']);
  });

  it('pairs each detection with the closest-in-time quake when two are near', () => {
    const grade = gradeDetections(
      [detection(T0 + 4_000, 34, -118, T0 + 12_000)],
      [quake('early', T0, 34, -118), quake('close', T0 + 3_500, 34, -118)],
    );
    expect(grade.matched[0]!.quake.id).toBe('close');
    expect(grade.missed.map((q) => q.id)).toEqual(['early']);
  });
});
