/**
 * Replays archived waveforms through the early-warning detector and grades it
 * against the USGS catalogue.
 *
 *   pnpm replay:detector --set reference        Ridgecrest M6.4 and M7.1
 *   pnpm replay:detector --set tuning           half of every M4+ near Burbank, 2020-2025
 *   pnpm replay:detector --set tele             distant great quakes (should NOT alert)
 *   pnpm replay:detector --set random           random hours (false-alarm rate)
 *   pnpm replay:detector --set heldout --final  the other half — run once, after tuning
 *   pnpm replay:detector --set tele-heldout --final   likewise for the distant quakes
 *
 * `--param picker.highPassHz=3` (repeatable) overrides one detector setting,
 * for sweeps. `--quiet` prints only the summary line.
 *
 * **Why there is a held-out set and why it is locked.** Every threshold in the
 * detector is an engineering choice that could be nudged until the replay looks
 * good. Nudged against the same quakes it is then graded on, the result would
 * describe the tuning, not the detector. So the M4+ list is split by date into
 * alternating halves: tune on one, and run the other only when the settings are
 * final. `--final` is the deliberate step that says so.
 *
 * Both the station list and the case list are drawn once and frozen under
 * `.cache/replay/`. A station joining or leaving the ring, or USGS revising a
 * magnitude across 4.0, must not quietly change what "the tuning set" means
 * between runs. Delete the files to redraw on purpose.
 *
 * Timing is the point: each record is released to the detector at its last
 * sample plus measured transit (`arrivalOrder`), so "declared N s after the
 * quake began" is what a live system would have achieved, not a flattered
 * version of it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { channelIdOf, haversineKm, type WaveformStation } from '../packages/schema/src/index';
import {
  DEFAULT_DETECTOR_PARAMS,
  QuakeDetector,
  arrivalOrder,
  asLiveRecords,
  buildStationCatalogue,
  fetchDataselect,
  fetchRecentEarthquakes,
  fetchRingInventory,
  fetchStationListing,
  gradeDetections,
  parseMiniSeedRecord,
  splitMiniSeedRecords,
  type CatalogueQuake,
  type DetectorParams,
  type MiniSeedDataRecord,
  type QuakeDetection,
} from '../packages/ingest/src/index';

const HOME = { latitude: 34.1808, longitude: -118.309, label: 'Burbank, CA' };
/** Stations the detector listens to: what can hear a quake that matters at home. */
const STATION_RADIUS_KM = 300;
/** Quakes whose catalogue entries can explain a detection. Wider than the stations, plus the search margin. */
const CATALOGUE_RADIUS_KM = 450;
const LOCAL_CASE_RADIUS_KM = 250;
const CACHE = join(import.meta.dirname, '..', '.cache', 'replay');
/** Requests are split so no single POST asks for the whole network at once. */
const STATIONS_PER_REQUEST = 25;
const S_VELOCITY_KM_S = 3.6;
const DEPTH_KM = 8;

type SetName = 'reference' | 'tuning' | 'heldout' | 'tele' | 'tele-heldout' | 'random';

interface Case {
  id: string;
  set: SetName;
  label: string;
  startMs: number;
  endMs: number;
  /** The quake the case is about, when there is one. */
  target: CatalogueQuake | null;
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 1));
}

// ---------------------------------------------------------------------------
// Stations — frozen on first draw
// ---------------------------------------------------------------------------

async function stations(): Promise<WaveformStation[]> {
  const path = join(CACHE, 'stations.json');
  const cached = readJson<{ drawnUtc: string; stations: WaveformStation[] }>(path);
  if (cached) return cached.stations;

  const [listing, ring] = await Promise.all([fetchStationListing(), fetchRingInventory()]);
  if (listing === null || ring === null) throw new Error('station list or ring inventory unavailable');
  const all = buildStationCatalogue(listing.channelRows, listing.stationRows, ring);
  // 100 Hz only: slower channels pack 2.5-5 s per record even in strong shaking,
  // which is too slow to be among the first stations an alert waits on.
  const chosen = all.filter((s) => s.sampleRateHz >= 100 && haversineKm(s, HOME) <= STATION_RADIUS_KM);
  writeJson(path, { drawnUtc: new Date().toISOString(), stations: chosen });
  return chosen;
}

// ---------------------------------------------------------------------------
// Cases — drawn by rule, frozen on first draw
// ---------------------------------------------------------------------------

function toCatalogueQuake(e: { id: string; timeUtc: string; latitude: number; longitude: number; magnitude: number }): CatalogueQuake {
  return { id: e.id, originMs: Date.parse(e.timeUtc), latitude: e.latitude, longitude: e.longitude, magnitude: e.magnitude };
}

/**
 * Approximate P travel time for a surface source, seconds, by distance in
 * degrees (IASP91, rounded). Only used to aim a 7-minute replay window at a
 * distant quake's P arrival; an error of 20 s here costs nothing.
 */
function teleseismicPSeconds(deltaDeg: number): number {
  const table: [number, number][] = [
    [20, 277], [30, 372], [40, 461], [50, 537], [60, 601], [70, 660], [80, 714], [90, 766], [100, 818],
  ];
  for (let i = 1; i < table.length; i += 1) {
    const [d1, t1] = table[i] as [number, number];
    const [d0, t0] = table[i - 1] as [number, number];
    if (deltaDeg <= d1) return t0 + ((deltaDeg - d0) / (d1 - d0)) * (t1 - t0);
  }
  return 818;
}

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function cases(): Promise<Case[]> {
  const path = join(CACHE, 'cases.json');
  const cached = readJson<{ drawnUtc: string; rule: string; cases: Case[] }>(path);
  if (cached) return cached.cases;

  const out: Case[] = [];
  const localWindow = (q: CatalogueQuake, set: SetName, label: string): Case => ({
    id: `${set}-${q.id}`,
    set,
    label,
    startMs: q.originMs - 60_000,
    endMs: q.originMs + 120_000,
    target: q,
  });

  // Reference: Ridgecrest, named rather than drawn, and kept out of both
  // halves — it is the case everyone will look at first, so it must not be
  // the one the settings were fitted to.
  for (const id of ['ci38443183', 'ci38457511']) {
    const res = await fetch(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&eventid=${id}`);
    const f = (await res.json()) as { id: string; properties: { time: number; mag: number; place: string }; geometry: { coordinates: [number, number] } };
    const q: CatalogueQuake = { id: f.id, originMs: f.properties.time, latitude: f.geometry.coordinates[1], longitude: f.geometry.coordinates[0], magnitude: f.properties.mag };
    out.push(localWindow(q, 'reference', `M${q.magnitude.toFixed(1)} ${f.properties.place}`));
  }

  // Every M4+ within 250 km, 2020-2025, alternating by date into two halves.
  const local = await fetchRecentEarthquakes({
    startUtc: new Date('2020-01-01T00:00:00Z'),
    endUtc: new Date('2026-01-01T00:00:00Z'),
    minMagnitude: 4,
    within: { ...HOME, radiusKm: LOCAL_CASE_RADIUS_KM },
  });
  local
    .sort((a, b) => Date.parse(a.timeUtc) - Date.parse(b.timeUtc))
    .forEach((e, index) => {
      const set: SetName = index % 2 === 0 ? 'tuning' : 'heldout';
      out.push(localWindow(toCatalogueQuake(e), set, `M${e.magnitude.toFixed(1)} ${e.place}`));
    });

  // Distant great quakes, 25-100 degrees away: their P waves sweep the whole
  // network at once, the false-alarm path the associator tests worried about.
  const great = await fetchRecentEarthquakes({
    startUtc: new Date('2020-01-01T00:00:00Z'),
    endUtc: new Date('2026-01-01T00:00:00Z'),
    minMagnitude: 7.5,
  });
  for (const e of great) {
    const deltaDeg = haversineKm(e, HOME) / 111.195;
    if (deltaDeg < 25 || deltaDeg > 100) continue;
    const pMs = Date.parse(e.timeUtc) + teleseismicPSeconds(deltaDeg) * 1000;
    out.push({
      id: `tele-${e.id}`,
      set: 'tele',
      label: `M${e.magnitude.toFixed(1)} ${e.place} (${deltaDeg.toFixed(0)}°)`,
      startMs: pMs - 120_000,
      endMs: pMs + 300_000,
      target: toCatalogueQuake(e),
    });
  }

  // Random hours, for the false-alarm rate. Seeded so the draw is reproducible.
  const random = seeded(20261001);
  const span0 = Date.parse('2020-01-01T00:00:00Z');
  const span1 = Date.parse('2026-01-01T00:00:00Z');
  for (let k = 0; k < 6; k += 1) {
    const startMs = span0 + Math.floor((random() * (span1 - span0 - 3_600_000)) / 3_600_000) * 3_600_000;
    out.push({ id: `random-${String(k)}`, set: 'random', label: new Date(startMs).toISOString().slice(0, 16), startMs, endMs: startMs + 3_600_000, target: null });
  }

  writeJson(path, {
    drawnUtc: new Date().toISOString(),
    rule: 'reference: Ridgecrest M6.4/M7.1; tuning/heldout: all M4+ within 250 km of Burbank 2020-2025, alternating by date; tele: M7.5+ 2020-2025 at 25-100 deg; random: 6 seeded hours 2020-2025',
    cases: out,
  });
  return out;
}

// ---------------------------------------------------------------------------
// Running one case
// ---------------------------------------------------------------------------

async function waveforms(c: Case, list: WaveformStation[]): Promise<Uint8Array[]> {
  const dir = join(CACHE, 'mseed');
  mkdirSync(dir, { recursive: true });
  const parts: Uint8Array[] = [];
  for (let i = 0; i < list.length; i += STATIONS_PER_REQUEST) {
    const path = join(dir, `${c.id}-${String(i / STATIONS_PER_REQUEST)}.mseed`);
    if (existsSync(path)) {
      parts.push(new Uint8Array(readFileSync(path)));
      continue;
    }
    const bytes = await fetchDataselect(list.slice(i, i + STATIONS_PER_REQUEST), c.startMs, c.endMs);
    writeFileSync(path, bytes);
    parts.push(bytes);
  }
  return parts;
}

interface CaseResult {
  c: Case;
  stationsWithData: number;
  badRecords: number;
  detections: QuakeDetection[];
  grade: ReturnType<typeof gradeDetections>;
  /** The target quake's match, if it was detected. */
  targetMatch: ReturnType<typeof gradeDetections>['matched'][number] | null;
}

async function runCase(c: Case, list: WaveformStation[]): Promise<CaseResult> {
  const records: MiniSeedDataRecord[] = [];
  let badRecords = 0;
  for (const bytes of await waveforms(c, list)) {
    for (const raw of splitMiniSeedRecords(bytes)) {
      try {
        const r = parseMiniSeedRecord(raw);
        // Archive packaging is not always live packaging; see asLiveRecords.
        if (r.kind === 'data') records.push(...asLiveRecords(r, raw.byteLength));
      } catch {
        badRecords += 1;
      }
    }
  }

  const detector = new QuakeDetector(
    list.map((s) => ({ channelId: channelIdOf(s), latitude: s.latitude, longitude: s.longitude })),
    detectorParams(),
  );
  // --trace: every pick near the target, in the order the detector saw them,
  // with what the associator made of it. The way to see *why* a declaration
  // came late, rather than guessing at thresholds.
  if (process.argv.includes('--trace') && c.target !== null) {
    const target = c.target;
    const byId = new Map(list.map((s) => [channelIdOf(s), s]));
    detector.onPick = (pick, arrivedAtMs, verdict) => {
      const afterS = (pick.timeMs - target.originMs) / 1000;
      if (afterS < -5 || afterS > 45) return;
      const station = byId.get(pick.channelId);
      const km = station ? haversineKm(station, target) : Number.NaN;
      const detail = Object.entries(verdict)
        .filter(([k]) => k !== 'kind')
        .map(([k, v]) => `${k}=${typeof v === 'number' ? fmt(v, 0) : String(v)}`)
        .join(' ');
      console.log(
        `    pick ${pick.channelId.padEnd(16)} ${fmt(km, 0).padStart(4)} km  onset +${fmt(afterS)} s  ` +
          `arrived +${fmt((arrivedAtMs - target.originMs) / 1000)} s  ratio ${fmt(pick.ratio, 0).padStart(3)}  ${verdict.kind} ${detail}`,
      );
    };
  }
  const detections = arrivalOrder(records).flatMap(({ record, arrivedAtMs }) => detector.push(record, arrivedAtMs));

  // Cached per case: the window is in the past, and a sweep re-grades the same
  // case many times.
  const cataloguePath = join(CACHE, 'catalogue', `${c.id}.json`);
  let catalogue = readJson<CatalogueQuake[]>(cataloguePath);
  if (catalogue === null) {
    catalogue = (
      await fetchRecentEarthquakes({
        startUtc: new Date(c.startMs - 120_000),
        endUtc: new Date(c.endMs),
        within: { ...HOME, radiusKm: CATALOGUE_RADIUS_KM },
      })
    ).map(toCatalogueQuake);
    mkdirSync(join(CACHE, 'catalogue'), { recursive: true });
    writeJson(cataloguePath, catalogue);
  }
  const grade = gradeDetections(detections, catalogue);
  const targetMatch = c.target === null ? null : (grade.matched.find((m) => m.quake.id === c.target?.id) ?? null);
  return { c, stationsWithData: new Set(records.map((r) => r.channelId)).size, badRecords, detections, grade, targetMatch };
}

/** Seconds between the alert and strong (S-wave) shaking reaching home. */
function warningAtHomeS(m: NonNullable<CaseResult['targetMatch']>): number {
  const sArrivalS = Math.hypot(haversineKm(m.quake, HOME), DEPTH_KM) / S_VELOCITY_KM_S;
  return sArrivalS - m.declaredAfterOriginS;
}

/** The defaults, with any `--param section.key=value` overrides applied. */
function detectorParams(): DetectorParams {
  const params: DetectorParams = {
    picker: { ...DEFAULT_DETECTOR_PARAMS.picker },
    associator: { ...DEFAULT_DETECTOR_PARAMS.associator },
  };
  process.argv.forEach((token, i) => {
    if (token !== '--param') return;
    const [path = '', value = ''] = (process.argv[i + 1] ?? '').split('=');
    const [section, key] = path.split('.') as [keyof DetectorParams, string];
    const target = params[section] as unknown as Record<string, number> | undefined;
    if (target === undefined || !(key in target) || !Number.isFinite(Number(value))) {
      throw new Error(`unknown or non-numeric --param ${path}=${value}`);
    }
    target[key] = Number(value);
  });
  return params;
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

async function main(): Promise<void> {
  const set = (arg('set') ?? 'reference') as SetName;
  if ((set === 'heldout' || set === 'tele-heldout') && !process.argv.includes('--final')) {
    console.error('The held-out set is graded once, after tuning is finished. Re-run with --final to confirm.');
    process.exit(2);
  }
  const limit = Number(arg('limit') ?? Number.POSITIVE_INFINITY);
  const quiet = process.argv.includes('--quiet');
  mkdirSync(CACHE, { recursive: true });

  const list = await stations();
  const all = await cases();
  const chosen = all.filter((c) => c.set === set).slice(0, limit);
  console.log(`${String(list.length)} stations within ${String(STATION_RADIUS_KM)} km of ${HOME.label}; ${String(chosen.length)} '${set}' cases\n`);

  const results: CaseResult[] = [];
  for (const c of chosen) {
    const t = performance.now();
    const r = await runCase(c, list);
    results.push(r);
    const secs = fmt((performance.now() - t) / 1000);
    const head = `${c.label.padEnd(52).slice(0, 52)} ${String(r.stationsWithData).padStart(3)} stns`;
    let verdict: string;
    if (c.set === 'tele' || c.set === 'tele-heldout' || c.set === 'random') {
      verdict = r.grade.spurious.length === 0 ? 'no false alarm' : `${String(r.grade.spurious.length)} FALSE ALARM(S)`;
      verdict += `, ${String(r.grade.matched.length)} small local quakes detected`;
    } else if (r.targetMatch) {
      const m = r.targetMatch;
      verdict =
        `declared +${fmt(m.declaredAfterOriginS)} s, ${fmt(m.locationErrorKm, 0)} km off, ` +
        `${String(m.detection.picks.length)} stns; warning at home ${fmt(warningAtHomeS(m))} s` +
        (r.grade.spurious.length > 0 ? `; ${String(r.grade.spurious.length)} false` : '');
    } else {
      verdict = `MISSED${r.grade.spurious.length > 0 ? `; ${String(r.grade.spurious.length)} false` : ''}`;
    }
    if (quiet) continue;
    console.log(`${head}  ${verdict}  [${secs}s]`);
    for (const s of r.grade.spurious) {
      console.log(
        `    false: ${new Date(s.originMs).toISOString().slice(11, 21)} at ${fmt(s.latitude, 2)},${fmt(s.longitude, 2)} ` +
          `${String(s.picks.length)} picks rms ${fmt(s.rmsS, 2)} s, ${String(s.missedStations.length)} silent`,
      );
    }
  }

  const hours = results.reduce((h, r) => h + (r.c.endMs - r.c.startMs) / 3_600_000, 0);
  const falseAlarms = results.reduce((n, r) => n + r.grade.spurious.length, 0);
  const targets = results.filter((r) => r.c.target !== null && !r.c.set.startsWith('tele'));
  const hits = targets.filter((r) => r.targetMatch !== null);
  const latencies = hits.map((r) => (r.targetMatch as NonNullable<CaseResult['targetMatch']>).declaredAfterOriginS).sort((a, b) => a - b);
  console.log(`\n${String(falseAlarms)} false alarm(s) over ${fmt(hours)} h of replayed data`);
  if (targets.length > 0) {
    console.log(
      `${String(hits.length)}/${String(targets.length)} target quakes detected; median declared +${fmt(latencies[Math.floor(latencies.length / 2)] ?? Number.NaN)} s after origin`,
    );
  }
  writeJson(join(CACHE, `results-${set}.json`), results.map((r) => ({ ...r, detections: r.detections.length })));
}

await main();
