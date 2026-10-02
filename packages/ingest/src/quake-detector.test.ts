import { describe, expect, it } from 'vitest';
import { haversineKm } from '@terra-pulse/schema';
import { DEFAULT_PICKER_PARAMS, StationPicker, type Pick } from './quake-picker';
import { DEFAULT_ASSOCIATOR_PARAMS, QuakeAssociator, type AssociatorStation } from './quake-associator';
import { QuakeDetector, type QuakeDetection } from './quake-detector';
import type { MagnitudeEstimate } from './quake-magnitude';
import { arrivalOrder } from './detector-replay';
import type { MiniSeedDataRecord } from './miniseed';

/** Deterministic noise, so a flaky threshold can't hide behind randomness. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RATE = 100;

interface SignalSpec {
  seconds: number;
  seed: number;
  /** A big DC offset is normal for raw counts, and is the first-sample trap. */
  dc?: number;
  /** Ocean microseism: large, slow, and not an earthquake. */
  microseismAmplitude?: number;
  noise?: number;
  /** Onset times (s from the start) of a 5 Hz burst. */
  onsets?: { atS: number; amplitude: number }[];
}

function signal(spec: SignalSpec): Int32Array {
  const random = rng(spec.seed);
  const n = spec.seconds * RATE;
  const out = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    let x = (spec.dc ?? 20_000) + (spec.microseismAmplitude ?? 2_000) * Math.sin(2 * Math.PI * 0.2 * t);
    x += (spec.noise ?? 20) * (random() + random() + random() - 1.5) * 2;
    for (const onset of spec.onsets ?? []) {
      if (t >= onset.atS) {
        const age = t - onset.atS;
        x += onset.amplitude * Math.exp(-age / 6) * Math.sin(2 * Math.PI * 5 * age);
      }
    }
    out[i] = Math.round(x);
  }
  return out;
}

/** Cuts a signal into records of `size` samples, as a station would ship it. */
function records(channelId: string, startMs: number, samples: Int32Array, size = 100): MiniSeedDataRecord[] {
  const out: MiniSeedDataRecord[] = [];
  const [network = '', station = ''] = channelId.split('_');
  for (let i = 0; i < samples.length; i += size) {
    out.push({
      kind: 'data',
      channel: { network, station, location: '', channel: 'HHZ' },
      channelId,
      quality: 'D',
      encoding: 11,
      startTimeMs: startMs + (i / RATE) * 1000,
      sampleRateHz: RATE,
      samples: samples.subarray(i, i + size),
    });
  }
  return out;
}

function pushAll(picker: StationPicker, recs: MiniSeedDataRecord[]): Pick[] {
  return recs.flatMap((r) => picker.push(r.startTimeMs, r.sampleRateHz, r.samples));
}

const T0 = Date.parse('2026-10-01T12:00:00Z');

describe('StationPicker', () => {
  it('stays quiet through microseism, noise and a large DC offset', () => {
    const picker = new StationPicker('XX_A__HHZ');
    const picks = pushAll(picker, records('XX_A__HHZ', T0, signal({ seconds: 120, seed: 1 })));
    expect(picks).toEqual([]);
  });

  it('picks a burst within a fraction of a second of its onset', () => {
    const picker = new StationPicker('XX_A__HHZ');
    const picks = pushAll(
      picker,
      records('XX_A__HHZ', T0, signal({ seconds: 60, seed: 2, onsets: [{ atS: 40, amplitude: 1_000 }] })),
    );
    expect(picks).toHaveLength(1);
    const delayS = (picks[0]!.timeMs - (T0 + 40_000)) / 1000;
    expect(delayS).toBeGreaterThanOrEqual(0);
    expect(delayS).toBeLessThan(0.3);
  });

  it('fires once for sustained shaking, not again on the S wave', () => {
    // The S wave lands 3 s after the P here, while the station is still
    // shaking. With the LTA frozen during a trigger it cannot climb toward
    // the earthquake's own energy and release mid-event.
    const picker = new StationPicker('XX_A__HHZ');
    const picks = pushAll(
      picker,
      records(
        'XX_A__HHZ',
        T0,
        signal({
          seconds: 60,
          seed: 3,
          onsets: [
            { atS: 30, amplitude: 500 },
            { atS: 33, amplitude: 3_000 },
          ],
        }),
      ),
    );
    expect(picks).toHaveLength(1);
  });

  it('releases a trigger held too long, so a second quake in the coda can still pick', () => {
    // A big first quake whose coda keeps the ratio above release for minutes
    // against the frozen pre-quake LTA, then a second one 25 s later. Measured
    // on real data: near stations stayed triggered 80-100 s after any M4.
    const samples = signal({
      seconds: 80,
      seed: 7,
      onsets: [
        { atS: 30, amplitude: 5_000 },
        { atS: 55, amplitude: 3_000 },
      ],
    });
    const stuck = new StationPicker('XX_A__HHZ', { ...DEFAULT_PICKER_PARAMS, maxTriggerS: Number.POSITIVE_INFINITY });
    expect(pushAll(stuck, records('XX_A__HHZ', T0, samples))).toHaveLength(1);

    const released = new StationPicker('XX_A__HHZ');
    const picks = pushAll(released, records('XX_A__HHZ', T0, samples));
    expect(picks).toHaveLength(2);
    expect((picks[1]!.timeMs - T0) / 1000).toBeCloseTo(55, 0);
  });

  it('cannot pick, and is not ready, until the LTA has warmed up', () => {
    const picker = new StationPicker('XX_A__HHZ');
    // A burst 5 s in, inside the 20 s warm-up.
    const recs = records('XX_A__HHZ', T0, signal({ seconds: 15, seed: 4, onsets: [{ atS: 5, amplitude: 2_000 }] }));
    expect(pushAll(picker, recs)).toEqual([]);
    expect(picker.readyThroughMs).toBeNull();
  });

  it('resets across a gap instead of reading the jump as an onset', () => {
    const picker = new StationPicker('XX_A__HHZ');
    pushAll(picker, records('XX_A__HHZ', T0, signal({ seconds: 40, seed: 5 })));
    expect(picker.readyThroughMs).not.toBeNull();
    // Back after a 60 s outage with a very different offset. Carrying the old
    // filter state across would turn the offset change into a huge step.
    const after = records('XX_A__HHZ', T0 + 100_000, signal({ seconds: 10, seed: 6, dc: -50_000 }));
    expect(pushAll(picker, after)).toEqual([]);
    expect(picker.readyThroughMs).toBeNull();
  });
});

/** A 5 x 5 grid of stations at ~20 km spacing around (34, -118). */
function gridStations(): AssociatorStation[] {
  const stations: AssociatorStation[] = [];
  for (let i = 0; i < 5; i += 1) {
    for (let j = 0; j < 5; j += 1) {
      stations.push({
        channelId: `XX_S${String(i)}${String(j)}__HHZ`,
        latitude: 33.64 + i * 0.18,
        longitude: -118.44 + j * 0.22,
      });
    }
  }
  return stations;
}

const P = DEFAULT_ASSOCIATOR_PARAMS;

function travelS(station: AssociatorStation, source: { latitude: number; longitude: number }, v = P.pVelocityKmS): number {
  return Math.hypot(haversineKm(station, source), P.depthKm) / v;
}

const SOURCE = { latitude: 34.05, longitude: -117.95 };

/** Stations sorted nearest-first from the source. */
function byDistance(stations: AssociatorStation[]): AssociatorStation[] {
  return [...stations].sort((a, b) => haversineKm(a, SOURCE) - haversineKm(b, SOURCE));
}

describe('QuakeAssociator', () => {
  it('declares on the fourth agreeing station and locates the source', () => {
    const stations = gridStations();
    const associator = new QuakeAssociator(stations);
    const nearest = byDistance(stations);
    const allReady = () => T0 + 10_000; // only stations past the arrival can "miss"

    const results = nearest.slice(0, 4).map((station) =>
      associator.addPick({ channelId: station.channelId, timeMs: T0 + travelS(station, SOURCE) * 1000, ratio: 8 }, T0 + 20_000, () =>
        allReady(),
      ),
    );
    expect(results.slice(0, 3)).toEqual([null, null, null]);
    const event = results[3];
    expect(event).not.toBeNull();
    expect(haversineKm(event!, SOURCE)).toBeLessThan(5);
    expect(Math.abs(event!.originMs - T0)).toBeLessThan(500);
    expect(event!.picks).toHaveLength(4);
  });

  it('never declares on three stations, however well they agree', () => {
    const stations = gridStations();
    const associator = new QuakeAssociator(stations);
    for (const station of byDistance(stations).slice(0, 3)) {
      expect(
        associator.addPick({ channelId: station.channelId, timeMs: T0 + travelS(station, SOURCE) * 1000, ratio: 8 }, T0 + 20_000, () => null),
      ).toBeNull();
    }
  });

  it('does not declare on picks that no single source explains', () => {
    const stations = gridStations();
    const associator = new QuakeAssociator(stations);
    const random = rng(11);
    let declared = 0;
    // Forty random single-station triggers across ten minutes — trucks, doors.
    for (let k = 0; k < 40; k += 1) {
      const station = stations[Math.floor(random() * stations.length)]!;
      const timeMs = T0 + k * 15_000 + random() * 5_000;
      if (associator.addPick({ channelId: station.channelId, timeMs, ratio: 6 }, timeMs + 3_000, () => null)) declared += 1;
    }
    expect(declared).toBe(0);
  });

  it('rejects a cluster when the stations nearest it heard nothing', () => {
    // Four far stations that happen to fit a source, while the nearer ones —
    // with data well past their predicted arrivals — stayed silent.
    const stations = gridStations();
    const associator = new QuakeAssociator(stations);
    const sorted = byDistance(stations);
    const far = sorted.slice(10, 14);
    let event = null;
    for (const station of far) {
      event = associator.addPick(
        { channelId: station.channelId, timeMs: T0 + travelS(station, SOURCE) * 1000, ratio: 6 },
        T0 + 30_000,
        () => T0 + 60_000,
      );
    }
    expect(event).toBeNull();
  });

  it('rejects a distant great quake’s P wave sweeping across a network edge-on', () => {
    // A teleseismic P wave arrives steeply, so it crosses the network as a
    // near-plane wave far faster than any crustal wave: ~20 km/s apparent
    // against 6.2. Picks are offered in time order, as live, each a few
    // seconds after its moment, with every station's data that far along.
    //
    // This failed twice before passing. First, a source placed far *outside*
    // the network sees every station at nearly one distance, so the sweep fit
    // it and nothing nearer contradicted it (`maxNearestStationKm`). Then, at
    // ±1 s, fake sources *inside* the network fitted rings of similar-distance
    // stations, with a station at the ring's centre that had fired at the
    // wrong time (`toleranceS` 0.5, and the nearest ready station must be a
    // member). Checked by switching each off: **the nearest-member rule is the
    // one this test pins** — it rejects this case on its own, so the other two
    // pass here either way. The distance rule has its own test below.
    //
    // **Not covered, and deliberately not bent into passing:** the same sweep
    // arriving diagonally hits a tight corner of four stations first, and four
    // picks there are locally indistinguishable from a quake among them — it
    // declared once in 25 stations at 135°. Later stations would expose it,
    // but too late. Whether real distant quakes do this is for the replay to
    // measure: their P waves carry little energy above the 1 Hz high-pass.
    const stations = gridStations();
    const associator = new QuakeAssociator(stations);
    const random = rng(12);
    const az = 0; // travelling north, so whole rows pick together
    const picks = stations
      .map((station) => {
        // Position along the wave's travel direction, km.
        const x = (station.longitude + 118) * 92.2 * Math.sin(az) + (station.latitude - 34) * 111.2 * Math.cos(az);
        return { channelId: station.channelId, timeMs: T0 + (x / 20) * 1000 + (random() - 0.5) * 600, ratio: 6 };
      })
      .sort((a, b) => a.timeMs - b.timeMs);

    let declared = 0;
    for (const pick of picks) {
      const nowMs = pick.timeMs + 3_000;
      if (associator.addPick(pick, nowMs, () => nowMs - 2_000)) declared += 1;
    }
    expect(declared).toBe(0);
  });

  it('declares a real quake beyond the network’s reach once, pulled in to the edge in the right direction', () => {
    // 90 km beyond the grid's southern edge, past the search's reach. The
    // search cannot place it out there, so it lands at the edge — measured
    // ~40 km off with the origin ~6 s late. The two errors partly cancel for
    // anyone inside the network: the wavefront it predicts there is about
    // right. Declared slightly misplaced beats not declared at all, which is
    // what this did before the search was confined to the network's reach.
    const stations = gridStations();
    const associator = new QuakeAssociator(stations);
    const offshore = { latitude: 32.83, longitude: -118 };
    const picks = stations
      .map((station) => ({ channelId: station.channelId, timeMs: T0 + travelS(station, offshore) * 1000, ratio: 8 }))
      .sort((a, b) => a.timeMs - b.timeMs);
    const declared = [];
    for (const pick of picks) {
      const nowMs = pick.timeMs + 3_000;
      const event = associator.addPick(pick, nowMs, () => nowMs - 2_000);
      if (event) declared.push(event);
    }
    expect(declared).toHaveLength(1);
    expect(haversineKm(declared[0]!, offshore)).toBeLessThan(60);
    // South of the southern row: the right side of the network.
    expect(declared[0]!.latitude).toBeLessThan(33.64);
  });

  it('absorbs S-wave and coda retriggers instead of declaring a second quake', () => {
    const stations = gridStations();
    const associator = new QuakeAssociator(stations);
    // P and S picks from every station, offered in time order as live. (Offered
    // in station order instead, the first four were one straight row — which
    // cannot tell a source from its mirror image across the row, and located
    // one 90 km away. Live picks come nearest-first, so that is not this
    // test's subject; it is a real ambiguity for collinear first stations.)
    const picks = stations
      .flatMap((station) => [
        { channelId: station.channelId, timeMs: T0 + travelS(station, SOURCE) * 1000, ratio: 8 },
        { channelId: station.channelId, timeMs: T0 + travelS(station, SOURCE, P.sVelocityKmS) * 1000, ratio: 8 },
      ])
      .sort((a, b) => a.timeMs - b.timeMs);
    const declared = [];
    for (const pick of picks) {
      const nowMs = pick.timeMs + 3_000;
      const e = associator.addPick(pick, nowMs, () => nowMs - 2_000);
      if (e) declared.push(e);
    }
    expect(declared).toHaveLength(1);
    // Later P picks that fit were attached to it.
    expect(declared[0]!.picks.length).toBeGreaterThan(4);
  });

  describe('a second quake inside the first one’s coda', () => {
    /** Every station's P and S for a quake at SOURCE at T0, in time order. */
    function firstQuake(associator: QuakeAssociator, stations: AssociatorStation[]): number {
      let declared = 0;
      const picks = stations
        .flatMap((station) => [
          { channelId: station.channelId, timeMs: T0 + travelS(station, SOURCE) * 1000, ratio: 8 },
          { channelId: station.channelId, timeMs: T0 + travelS(station, SOURCE, P.sVelocityKmS) * 1000, ratio: 8 },
        ])
        .sort((a, b) => a.timeMs - b.timeMs);
      for (const pick of picks) if (associator.addPick(pick, pick.timeMs + 3_000, () => pick.timeMs + 1_000)) declared += 1;
      return declared;
    }

    /** P picks from the `count` stations nearest `source`, for a quake at `originMs`. */
    function pPicks(stations: AssociatorStation[], source: typeof SOURCE, originMs: number, count: number) {
      return [...stations]
        .sort((a, b) => haversineKm(a, source) - haversineKm(b, source))
        .slice(0, count)
        .map((station) => ({ channelId: station.channelId, timeMs: originMs + travelS(station, source) * 1000, ratio: 9 }))
        .sort((a, b) => a.timeMs - b.timeMs);
    }

    function offer(associator: QuakeAssociator, picks: { channelId: string; timeMs: number; ratio: number }[]) {
      let event = null;
      // Every station is busy with the first quake's coda, so none is "ready"
      // to count as silent — the same as stations still triggered.
      for (const pick of picks) event = associator.addPick(pick, pick.timeMs + 3_000, () => null) ?? event;
      return event;
    }

    it('declares it when it lies in the same sequence', () => {
      const stations = gridStations();
      const associator = new QuakeAssociator(stations);
      expect(firstQuake(associator, stations)).toBe(1);
      const nearby = { latitude: SOURCE.latitude + 0.08, longitude: SOURCE.longitude + 0.05 };
      const second = offer(associator, pPicks(stations, nearby, T0 + 25_000, 6));
      expect(second).not.toBeNull();
      expect(haversineKm(second!, nearby)).toBeLessThan(5);
      expect(Math.abs(second!.originMs - (T0 + 25_000))).toBeLessThan(500);

      // The rule this replaced: every pick in a coda window was the first
      // quake's, so the second never had a chance.
      const old = new QuakeAssociator(stations, { ...P, retriggersMayDeclare: false });
      firstQuake(old, stations);
      expect(offer(old, pPicks(stations, nearby, T0 + 25_000, 6))).toBeNull();
    });

    it('absorbs picks that fit the first quake’s S wave, however well they fit a new source', () => {
      // Found by this file's own first draft: with S picks left in the pool, a
      // row of them along one grid column plus one stray fitted a fake source
      // 26 km from the quake and 8 s after it — inside both sequence guards.
      // An S pick is the first quake's, full stop.
      const stations = gridStations();
      const far = { latitude: 33.7, longitude: -118.4 };
      const unabsorbed = new QuakeAssociator(stations, { ...P, sToleranceS: 0 });
      firstQuake(unabsorbed, stations);
      expect(offer(unabsorbed, pPicks(stations, far, T0 + 20_000, 4))).not.toBeNull();
    });

    it('refuses a coda cluster far from the quake it is in — the S waves’ own coincidences', () => {
      // On real data these sat 40-300 km from the real quake with tight fits;
      // a genuine second quake mid-coda is part of the same sequence.
      const stations = gridStations();
      const far = { latitude: 33.7, longitude: -118.4 };
      expect(haversineKm(far, SOURCE)).toBeGreaterThan(P.sequenceRadiusKm);

      const associator = new QuakeAssociator(stations);
      firstQuake(associator, stations);
      expect(offer(associator, pPicks(stations, far, T0 + 20_000, 4))).toBeNull();
      expect(associator.lastVerdict.kind).toBe('not-in-sequence');

      // Control: the same four picks with no quake in progress are declared,
      // so it is the sequence rule refusing them and nothing else.
      expect(offer(new QuakeAssociator(stations), pPicks(stations, far, T0 + 20_000, 4))).not.toBeNull();
    });

    it('refuses re-locating the first quake from its own coda picks', () => {
      // Coda picks that fit a source on top of the first quake, 4.5 s later —
      // on real data, every remaining false alarm was this: one quake, two
      // alerts. (4.5 s keeps these picks clear of the first quake's S arrivals,
      // which are absorbed by a rule of their own.)
      const stations = gridStations();
      const associator = new QuakeAssociator(stations);
      firstQuake(associator, stations);
      expect(offer(associator, pPicks(stations, SOURCE, T0 + 4_500, 4))).toBeNull();
      expect(associator.lastVerdict.kind).toBe('duplicate');

      // And the guard is what refused it.
      const unguarded = new QuakeAssociator(stations, { ...P, minSequenceGapS: 0 });
      firstQuake(unguarded, stations);
      expect(offer(unguarded, pPicks(stations, SOURCE, T0 + 4_500, 4))).not.toBeNull();
    });
  });
});

describe('QuakeDetector end to end on synthetic waveforms', () => {
  it('detects a synthetic quake from records in arrival order, and declares only after the data could have arrived', () => {
    const stations = gridStations();
    const detector = new QuakeDetector(stations);
    const startMs = T0 - 60_000;
    const all = stations.flatMap((station, k) =>
      records(
        station.channelId,
        startMs,
        signal({ seconds: 120, seed: 100 + k, onsets: [{ atS: 60 + travelS(station, SOURCE), amplitude: 800 }] }),
      ),
    );

    const detections = arrivalOrder(all).flatMap(({ record, arrivedAtMs }) => detector.push(record, arrivedAtMs));
    expect(detections).toHaveLength(1);
    const d = detections[0]!;
    expect(haversineKm(d, SOURCE)).toBeLessThan(10);
    expect(Math.abs(d.originMs - T0)).toBeLessThan(1_000);

    // Fourth P arrival, plus at most one 1 s record to fill, plus 2 s transit.
    const fourthArrivalMs = T0 + travelS(byDistance(stations)[3]!, SOURCE) * 1000;
    expect(d.declaredAtMs).toBeGreaterThan(fourthArrivalMs + 2_000);
    expect(d.declaredAtMs).toBeLessThan(fourthArrivalMs + 3_500);
  });

  it('estimates a magnitude at declaration and keeps it current as P windows fill', () => {
    const stations = gridStations();
    const run = (gain: number | null) => {
      const detector = new QuakeDetector(stations.map((s) => ({ ...s, velocityGain: gain })));
      const all = stations.flatMap((station, k) =>
        records(
          station.channelId,
          T0 - 60_000,
          signal({ seconds: 120, seed: 100 + k, onsets: [{ atS: 60 + travelS(station, SOURCE), amplitude: 800 }] }),
        ),
      );
      const detections: QuakeDetection[] = [];
      let latest: MagnitudeEstimate | null = null;
      for (const { record, arrivedAtMs } of arrivalOrder(all)) {
        detections.push(...detector.push(record, arrivedAtMs));
        if (detections[0]) latest = detector.magnitudeOf(detections[0].id) ?? latest;
      }
      return { declared: detections[0]!, latest };
    };

    const withGains = run(6e8);
    expect(withGains.declared.magnitude).not.toBeNull();
    expect(Number.isFinite(withGains.declared.magnitude!.magnitude)).toBe(true);
    // Stations that triggered after declaration join the estimate, and every
    // window has filled by the end of the data.
    expect(withGains.latest!.stations.length).toBeGreaterThan(withGains.declared.magnitude!.stations.length);
    expect(withGains.latest!.complete).toBe(true);

    // Without gains the quake is still detected; it just has no magnitude.
    const withoutGains = run(null);
    expect(withoutGains.declared).toBeDefined();
    expect(withoutGains.declared.magnitude).toBeNull();
    expect(withoutGains.latest).toBeNull();
  });
});
