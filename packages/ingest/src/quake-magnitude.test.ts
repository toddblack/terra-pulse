import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAGNITUDE_PARAMS,
  DisplacementTracker,
  PD_SCALING,
  estimateMagnitude,
  magnitudeFromPd,
  type WaveGeometry,
} from './quake-magnitude';
import { velocityGainAt, velocityGainOf, type FdsnTextRow } from './fdsn-stations';
import type { AssociatorStation } from './quake-associator';

const RATE = 100;
const T0 = Date.parse('2026-10-01T12:00:00Z');
/** A typical broadband: ~6e8 counts per m/s (CI.ADO measured 6.27e8). */
const GAIN = 6e8;
const GEOMETRY: WaveGeometry = { pVelocityKmS: 6.2, sVelocityKmS: 3.6, depthKm: 8 };

/** Raw counts for a ground velocity v(t) in m/s, on a large DC offset. */
function counts(seconds: number, velocity: (t: number) => number, dc = 20_000): Int32Array {
  const out = new Int32Array(seconds * RATE);
  for (let i = 0; i < out.length; i += 1) out[i] = Math.round(dc + GAIN * velocity(i / RATE));
  return out;
}

/** Feeds a signal in 1 s records, as the ring would. */
function feed(tracker: DisplacementTracker, startMs: number, samples: Int32Array): void {
  for (let i = 0; i < samples.length; i += RATE) {
    tracker.push(startMs + (i / RATE) * 1000, RATE, samples.subarray(i, i + RATE));
  }
}

describe('magnitudeFromPd', () => {
  it('is Kuyuk & Allen’s equation 2', () => {
    // 1 cm at 10 km: log terms 0 and 1.
    expect(magnitudeFromPd(1, 10)).toBeCloseTo(PD_SCALING.distance + PD_SCALING.constant, 10);
    expect(magnitudeFromPd(0.01, 100)).toBeCloseTo(1.23 * -2 + 1.38 * 2 + 5.39, 10);
  });

  it('floors the distance at 1 km instead of running to −∞ above the source', () => {
    expect(magnitudeFromPd(1, 0)).toBe(magnitudeFromPd(1, 1));
    expect(Number.isFinite(magnitudeFromPd(1, 0))).toBe(true);
  });
});

describe('DisplacementTracker', () => {
  it('recovers the displacement of a known 1 Hz velocity sine', () => {
    // v = A sin(2πft) has displacement amplitude A / 2πf. At 1 Hz the 0.075 Hz
    // high-passes and the 3 Hz low-pass each pass ~99%; allow 3%.
    const amplitudeMps = 1e-5;
    const tracker = new DisplacementTracker('CI_ADO__HHZ', GAIN);
    feed(tracker, T0, counts(60, (t) => amplitudeMps * Math.sin(2 * Math.PI * t)));
    const peak = tracker.peak(T0 + 40_000, T0 + 50_000);
    const expectedCm = (amplitudeMps / (2 * Math.PI)) * 100;
    expect(peak).not.toBeNull();
    expect(peak!.peakCm / expectedCm).toBeGreaterThan(0.97);
    expect(peak!.peakCm / expectedCm).toBeLessThan(1.03);
    expect(peak!.complete).toBe(true);
  });

  it('turns a large DC offset into no displacement at all', () => {
    const tracker = new DisplacementTracker('CI_ADO__HHZ', GAIN);
    feed(tracker, T0, counts(60, () => 0, 2_000_000));
    // 1 nm would be invisible; a primed filter should give essentially zero.
    expect(tracker.peak(T0, T0 + 60_000)!.peakCm).toBeLessThan(1e-7);
  });

  it('removes the 3 Hz-and-up content the relation was fitted without', () => {
    // Same velocity amplitude at 10 Hz: displacement 10x smaller by physics,
    // then cut further by the low-pass.
    const tracker = new DisplacementTracker('CI_ADO__HHZ', GAIN);
    feed(tracker, T0, counts(60, (t) => 1e-5 * Math.sin(2 * Math.PI * 10 * t)));
    const unfilteredCm = (1e-5 / (2 * Math.PI * 10)) * 100;
    expect(tracker.peak(T0 + 40_000, T0 + 50_000)!.peakCm).toBeLessThan(unfilteredCm * 0.15);
  });

  it('reports a partial window as partial, with the peak so far', () => {
    const tracker = new DisplacementTracker('CI_ADO__HHZ', GAIN);
    feed(tracker, T0, counts(30, (t) => 1e-5 * Math.sin(2 * Math.PI * t)));
    const peak = tracker.peak(T0 + 25_000, T0 + 35_000);
    expect(peak!.complete).toBe(false);
    expect(peak!.throughMs).toBeCloseTo(T0 + 29_990, 0);
  });

  it('refuses a window that starts before a gap reset the filters', () => {
    const tracker = new DisplacementTracker('CI_ADO__HHZ', GAIN);
    const quiet = counts(30, () => 0);
    feed(tracker, T0, quiet);
    feed(tracker, T0 + 40_000, quiet); // 10 s gap
    expect(tracker.peak(T0 + 35_000, T0 + 45_000)).toBeNull();
    expect(tracker.peak(T0 + 41_000, T0 + 45_000)).not.toBeNull();
  });

  it('refuses a window that has scrolled out of the buffer', () => {
    const tracker = new DisplacementTracker('CI_ADO__HHZ', GAIN);
    feed(tracker, T0, counts(120, () => 0));
    expect(tracker.peak(T0 + 5_000, T0 + 10_000)).toBeNull();
    expect(tracker.peak(T0 + 100_000, T0 + 110_000)).not.toBeNull();
  });
});

describe('estimateMagnitude', () => {
  const station: AssociatorStation = { channelId: 'CI_ADO__HHZ', latitude: 34.0, longitude: -118.0 };
  /** 20 km north of the station. */
  const event = { latitude: 34.0 + 20 / 111.195, longitude: -118.0 };

  /** A small P wave at `pAtS` and a 20x larger S wave at the S−P time after it. */
  function trackerWithPandS(pAtS: number, sMinusPS: number): DisplacementTracker {
    const tracker = new DisplacementTracker(station.channelId, GAIN);
    const burst = (t: number, at: number, a: number): number =>
      t >= at ? a * Math.exp(-(t - at) / 3) * Math.sin(2 * Math.PI * 1.5 * (t - at)) : 0;
    feed(tracker, T0, counts(80, (t) => burst(t, pAtS, 1e-6) + burst(t, pAtS + sMinusPS, 2e-5)));
    return tracker;
  }

  it('reads Pd from the P wave only, cutting the window at the S arrival', () => {
    const hypo = Math.hypot(20, GEOMETRY.depthKm);
    const sMinusP = hypo / GEOMETRY.sVelocityKmS - hypo / GEOMETRY.pVelocityKmS;
    expect(sMinusP).toBeLessThan(DEFAULT_MAGNITUDE_PARAMS.maxWindowS);
    const tracker = trackerWithPandS(40, sMinusP);
    const estimate = estimateMagnitude(
      { ...event, picks: [{ channelId: station.channelId, timeMs: T0 + 40_000, ratio: 20 }] },
      () => station,
      () => tracker,
      GEOMETRY,
    );
    const pd = estimate!.stations[0]!.peakCm;
    // P alone peaks near 1e-6 / (2π·1.5) m; the S wave would be 20x that.
    const pOnlyCm = (1e-6 / (2 * Math.PI * 1.5)) * 100;
    expect(pd).toBeLessThan(pOnlyCm * 1.5);
    expect(pd).toBeGreaterThan(pOnlyCm * 0.3);
    expect(estimate!.stations[0]!.windowS).toBeCloseTo(sMinusP, 1);
  });

  it('scales with gain exactly as the equation says: double the gain, Pd halves', () => {
    const pick = { channelId: station.channelId, timeMs: T0 + 40_000, ratio: 20 };
    const run = (gain: number): number => {
      const tracker = new DisplacementTracker(station.channelId, gain);
      feed(tracker, T0, counts(60, (t) => (t > 40 ? 1e-5 * Math.sin(2 * Math.PI * t) : 0)));
      return estimateMagnitude({ ...event, picks: [pick] }, () => station, () => tracker, GEOMETRY)!.magnitude;
    };
    expect(run(GAIN) - run(2 * GAIN)).toBeCloseTo(PD_SCALING.pd * Math.log10(2), 6);
  });

  it('leaves out stations with no gain, beyond 250 km, or with too little P yet', () => {
    const far: AssociatorStation = { channelId: 'CI_FAR__HHZ', latitude: 37.0, longitude: -118.0 };
    const tracker = trackerWithPandS(40, 3);
    const picks = [
      { channelId: station.channelId, timeMs: T0 + 40_000, ratio: 20 },
      { channelId: far.channelId, timeMs: T0 + 40_000, ratio: 20 },
      { channelId: 'CI_NOGAIN__HHZ', timeMs: T0 + 40_000, ratio: 20 },
    ];
    const stations = new Map([station, far, { ...station, channelId: 'CI_NOGAIN__HHZ' }].map((s) => [s.channelId, s]));
    const trackers = new Map([
      [station.channelId, tracker],
      [far.channelId, tracker],
    ]);
    const estimate = estimateMagnitude({ ...event, picks }, (id) => stations.get(id), (id) => trackers.get(id), GEOMETRY);
    expect(estimate!.stations.map((s) => s.channelId)).toEqual([station.channelId]);

    // A pick 0.5 s before the end of the data has not earned a vote yet.
    const late = [{ channelId: station.channelId, timeMs: T0 + 79_500, ratio: 20 }];
    expect(estimateMagnitude({ ...event, picks: late }, (id) => stations.get(id), () => tracker, GEOMETRY)).toBeNull();
  });
});

describe('velocityGainOf', () => {
  const broadband: FdsnTextRow = {
    Network: 'CI',
    Station: 'ADO',
    Location: '',
    Channel: 'HHZ',
    SensorDescription: 'Velocity Sensor',
    Scale: '6.273686128122232E8',
    ScaleFreq: '0.03',
    ScaleUnits: 'm/s',
    StartTime: '2010-10-28T18:00:00.0000',
    EndTime: '2019-08-20T19:00:00.0000',
  };

  it('takes a broadband velocity gain, in either case of units', () => {
    expect(velocityGainOf(broadband)).toBeCloseTo(6.273686128122232e8, 0);
    expect(velocityGainOf({ ...broadband, ScaleUnits: 'M/S' })).toBeCloseTo(6.273686128122232e8, 0);
  });

  it('refuses geophones, including PB’s mislabelled HHZ ones, and non-velocity units', () => {
    const pb = { ...broadband, Network: 'PB', SensorDescription: 'HS-1-LT/Quanterra 330 Linear Phase Composite' };
    expect(velocityGainOf(pb)).toBeNull();
    expect(velocityGainOf({ ...pb, Channel: 'EHZ' })).toBeNull();
    expect(velocityGainOf({ ...broadband, Channel: 'EHZ' })).toBeNull();
    expect(velocityGainOf({ ...broadband, SensorDescription: 'Sercel L-22D' })).toBeNull();
    expect(velocityGainOf({ ...broadband, ScaleUnits: 'm/s**2' })).toBeNull();
    expect(velocityGainOf({ ...broadband, Scale: '' })).toBeNull();
    expect(velocityGainOf({ ...broadband, Scale: '-1' })).toBeNull();
  });

  it('keeps sensors whose names merely contain similar letters', () => {
    expect(velocityGainOf({ ...broadband, SensorDescription: 'Nanometrics Trillium 120 Sec Response' })).not.toBeNull();
    expect(velocityGainOf({ ...broadband, SensorDescription: 'MBB-2 Mini broadband/Quanterra 330' })).not.toBeNull();
  });

  it('picks the epoch in force at the instant asked about', () => {
    const later = { ...broadband, Scale: '5.0E8', StartTime: '2019-08-20T19:00:00.0000', EndTime: '' };
    const rows = [broadband, later];
    expect(velocityGainAt(rows, 'CI_ADO__HHZ', Date.parse('2019-07-06T03:19:53Z'))).toBeCloseTo(6.27e8, -7);
    expect(velocityGainAt(rows, 'CI_ADO__HHZ', Date.parse('2024-01-01T00:00:00Z'))).toBe(5e8);
    expect(velocityGainAt(rows, 'CI_ADO__HHZ', Date.parse('2009-01-01T00:00:00Z'))).toBeNull();
    expect(velocityGainAt(rows, 'CI_XXX__HHZ', Date.parse('2024-01-01T00:00:00Z'))).toBeNull();
  });
});
