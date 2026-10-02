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
 *   pnpm replay:detector --set sequence         M3s that follow another quake within 3 min
 *   pnpm replay:detector --set m3-control       isolated M3s: the ceiling for the above
 *   pnpm replay:detector --set fresh --final    2026, drawn before any sequence tuning
 *
 * `--param picker.highPassHz=3` (repeatable) overrides one detector setting,
 * for sweeps. `--min-intensity 3` sets the alert threshold (predicted MMI at
 * home). `--only <text>` keeps the cases whose id or label contains it.
 * `--quiet` prints only the summary line.
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
  DEFAULT_ALERT_RULE,
  DEFAULT_DETECTOR_PARAMS,
  HomeAlerter,
  QuakeDetector,
  arrivalOrder,
  asLiveRecords,
  buildStationCatalogue,
  fetchChannelEpochs,
  fetchDataselect,
  fetchRecentEarthquakes,
  fetchRingInventory,
  fetchStationListing,
  gradeDetections,
  parseMiniSeedRecord,
  splitMiniSeedRecords,
  velocityGainAt,
  type CatalogueQuake,
  type DetectorParams,
  type FdsnTextRow,
  type HomeAlert,
  type MagnitudeEstimate,
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
/** Burbank's residential ZIP codes, for what people there reported feeling. */
const HOME_ZIPS = new Set(['91501', '91502', '91504', '91505', '91506']);

type SetName =
  | 'reference'
  | 'tuning'
  | 'heldout'
  | 'tele'
  | 'tele-heldout'
  | 'random'
  | 'sequence'
  | 'm3-control'
  | 'fresh';

/** Sets graded once, after tuning; `--final` is the deliberate step. */
const LOCKED_SETS: ReadonlySet<SetName> = new Set(['heldout', 'tele-heldout', 'fresh']);

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

/**
 * Every channel epoch for the frozen stations across the whole case span,
 * frozen too. Gains change when sensors are swapped (158 epochs over 74
 * stations, 2019-2026), so each case looks up the epoch in force on its day.
 */
async function gainEpochs(list: WaveformStation[]): Promise<FdsnTextRow[]> {
  const path = join(CACHE, 'gains.json');
  const cached = readJson<{ fetchedUtc: string; rows: FdsnTextRow[] }>(path);
  if (cached) return cached.rows;
  const rows = await fetchChannelEpochs(list, Date.parse('2019-01-01T00:00:00Z'), Date.parse('2027-01-01T00:00:00Z'));
  if (rows === null) throw new Error('station service unavailable for channel epochs');
  writeJson(path, { fetchedUtc: new Date().toISOString(), rows });
  return rows;
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
// Sequence cases — a second draw, frozen separately
// ---------------------------------------------------------------------------

/**
 * Quakes that follow another one closely, which the first draw never tests:
 * each of its cases is the first quake in its window. Measured 2026-10-02, a
 * station near any M4+ is still triggered 60-90 s later, so a second quake in
 * that span is the detector's blind spot — the held-out Lamont M4.6 miss.
 *
 * **Drawn so the held-out sets stay unseen.** Their rule covers M4+ only, so
 * M3.0-3.9 targets from 2020-2025 are data neither half has touched; a window
 * that overlaps a held-out case is dropped anyway, since it would replay that
 * quake. `fresh` is all of 2026 to the draw date, which no tuning has seen.
 *
 * - `sequence`: an M3.0-3.9 target with an M3+ within 60 km, 15-180 s earlier.
 *   The window opens 60 s before that earlier quake.
 * - `m3-control`: M3.0-3.9 with no M3+ within 60 km in the 3 minutes before —
 *   how often an M3 is found at all, so `sequence` has a ceiling to read
 *   against. 20, seeded.
 * - `fresh`: every M3.5+ in 2026 within 250 km, plus 2026's sequence pairs.
 */
async function sequenceCases(first: readonly Case[]): Promise<Case[]> {
  const path = join(CACHE, 'cases-sequence.json');
  const cached = readJson<{ drawnUtc: string; rule: string; cases: Case[] }>(path);
  if (cached) return cached.cases;

  const locked = first.filter((c) => LOCKED_SETS.has(c.set));
  const overlapsLocked = (startMs: number, endMs: number): boolean =>
    locked.some((c) => startMs < c.endMs && endMs > c.startMs);

  const draw = async (startUtc: string, endUtc: string): Promise<CatalogueQuake[]> =>
    (
      await fetchRecentEarthquakes({
        startUtc: new Date(startUtc),
        endUtc: new Date(endUtc),
        minMagnitude: 3,
        within: { ...HOME, radiusKm: LOCAL_CASE_RADIUS_KM },
      })
    )
      .map(toCatalogueQuake)
      .sort((a, b) => a.originMs - b.originMs);
  const precededBy = (all: readonly CatalogueQuake[], q: CatalogueQuake): CatalogueQuake | null => {
    const prior = all.filter(
      (p) => p !== q && q.originMs - p.originMs >= 15_000 && q.originMs - p.originMs <= 180_000 && haversineKm(p, q) <= 60,
    );
    return prior.sort((a, b) => b.magnitude - a.magnitude)[0] ?? null;
  };
  const label = (q: CatalogueQuake, prior: CatalogueQuake | null): string =>
    `M${q.magnitude.toFixed(1)} ${new Date(q.originMs).toISOString().slice(0, 16)}` +
    (prior === null ? '' : ` after M${prior.magnitude.toFixed(1)} ${((q.originMs - prior.originMs) / 1000).toFixed(0)} s earlier`);
  const pairCase = (set: SetName, q: CatalogueQuake, prior: CatalogueQuake): Case => ({
    id: `${set}-${q.id}`,
    set,
    label: label(q, prior),
    startMs: prior.originMs - 60_000,
    endMs: q.originMs + 120_000,
    target: q,
  });

  const out: Case[] = [];
  const past = await draw('2020-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  const isolated: CatalogueQuake[] = [];
  for (const q of past) {
    if (q.magnitude >= 4) continue;
    const prior = precededBy(past, q);
    if (prior !== null) {
      const c = pairCase('sequence', q, prior);
      if (!overlapsLocked(c.startMs, c.endMs)) out.push(c);
    } else if (!past.some((p) => p !== q && Math.abs(p.originMs - q.originMs) <= 180_000 && haversineKm(p, q) <= 60)) {
      isolated.push(q);
    }
  }
  const random = seeded(20261002);
  for (let k = 0; k < 20 && isolated.length > 0; k += 1) {
    const q = isolated.splice(Math.floor(random() * isolated.length), 1)[0] as CatalogueQuake;
    out.push({ id: `m3-control-${q.id}`, set: 'm3-control', label: label(q, null), startMs: q.originMs - 60_000, endMs: q.originMs + 120_000, target: q });
  }

  const drawnUtc = new Date().toISOString();
  const recent = await draw('2026-01-01T00:00:00Z', drawnUtc);
  for (const q of recent) {
    const prior = precededBy(recent, q);
    if (prior !== null) out.push(pairCase('fresh', q, prior));
    else if (q.magnitude >= 3.5) {
      out.push({ id: `fresh-${q.id}`, set: 'fresh', label: label(q, null), startMs: q.originMs - 60_000, endMs: q.originMs + 120_000, target: q });
    }
  }

  writeJson(path, {
    drawnUtc,
    rule:
      'sequence: M3.0-3.9 2020-2025 within 250 km with an M3+ within 60 km 15-180 s earlier, windows overlapping locked cases dropped; ' +
      'm3-control: 20 seeded M3.0-3.9 2020-2025 with no M3+ within 60 km and 180 s; fresh: 2026 M3.5+ plus 2026 sequence pairs',
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
  /** The target's magnitude estimate as it climbed, one entry per change. */
  magnitudeSeries: MagnitudeStep[];
  /** Every alert raised in the case, for any detection — a false one included. */
  alerts: HomeAlert[];
  /** The target's alert, if it raised one. */
  targetAlert: HomeAlert | null;
  /** What people at home reported (DYFI), for local targets. */
  feltAtHome: FeltReport | null;
}

interface FeltReport {
  /** Response-weighted community intensity across the home ZIPs; null if none reported. */
  intensity: number | null;
  reports: number;
}

interface MagnitudeStep {
  /** Seconds after the true origin. */
  afterOriginS: number;
  magnitude: number;
  stations: number;
  complete: boolean;
}

async function runCase(c: Case, list: WaveformStation[], gains: readonly FdsnTextRow[]): Promise<CaseResult> {
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
    list.map((s) => ({
      channelId: channelIdOf(s),
      latitude: s.latitude,
      longitude: s.longitude,
      velocityGain: velocityGainAt(gains, channelIdOf(s), c.startMs),
    })),
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
  // Every detection's estimate, recorded each time it changes, so the grade
  // can say what was known at declaration and how far it climbed after.
  const detections: QuakeDetection[] = [];
  const estimates = new Map<number, { atMs: number; estimate: MagnitudeEstimate }[]>();
  const alerter = new HomeAlerter(HOME, { minIntensity: minIntensity() }, { depthKm: DEPTH_KM, sVelocityKmS: S_VELOCITY_KM_S });
  const alerts: HomeAlert[] = [];
  for (const { record, arrivedAtMs } of arrivalOrder(records)) {
    detections.push(...detector.push(record, arrivedAtMs));
    for (const d of detections) {
      const estimate = detector.magnitudeOf(d.id);
      const alert = alerter.evaluate(d, estimate, arrivedAtMs);
      if (alert !== null) alerts.push(alert);
      if (estimate === null) continue;
      const steps = estimates.get(d.id) ?? [];
      const last = steps[steps.length - 1];
      if (last?.estimate.magnitude !== estimate.magnitude || last.estimate.complete !== estimate.complete) {
        steps.push({ atMs: arrivedAtMs, estimate });
      }
      estimates.set(d.id, steps);
    }
  }

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
  const magnitudeSeries: MagnitudeStep[] =
    targetMatch === null
      ? []
      : (estimates.get(targetMatch.detection.id) ?? []).map(({ atMs, estimate }) => ({
          afterOriginS: (atMs - targetMatch.quake.originMs) / 1000,
          magnitude: estimate.magnitude,
          stations: estimate.stations.length,
          complete: estimate.complete,
        }));
  const targetAlert = targetMatch === null ? null : alerter.alertFor(targetMatch.detection.id);
  const feltAtHome = c.target !== null && !c.set.startsWith('tele') ? await feltReport(c.target.id) : null;
  return {
    c,
    stationsWithData: new Set(records.map((r) => r.channelId)).size,
    badRecords,
    detections,
    grade,
    targetMatch,
    magnitudeSeries,
    alerts,
    targetAlert,
    feltAtHome,
  };
}

/**
 * What people at home reported feeling, from the event's DYFI ZIP-code table,
 * cached per event. The grade for the alert: an alert is right when home felt
 * it at that level. DYFI skews high where only a handful wrote in — people who
 * felt nothing rarely report — so the count is always shown beside it.
 */
async function feltReport(eventId: string): Promise<FeltReport> {
  const path = join(CACHE, 'dyfi', `${eventId}.json`);
  const cached = readJson<FeltReport>(path);
  if (cached) return cached;
  const res = await fetch(`https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=${eventId}&format=geojson`);
  const event = (await res.json()) as { properties: { products?: { dyfi?: { contents: Record<string, { url: string }> }[] } } };
  const url = event.properties.products?.dyfi?.[0]?.contents['cdi_zip.txt']?.url;
  let weighted = 0;
  let reports = 0;
  if (url !== undefined) {
    for (const line of (await (await fetch(url)).text()).split('\n')) {
      if (line.startsWith('#')) continue;
      // ZIP, CDI, number of responses, ... — the ZIP is quoted.
      const [zip = '', cdi = '', count = ''] = line.split(',').map((f) => f.trim().replace(/^"|"$/g, ''));
      if (!HOME_ZIPS.has(zip)) continue;
      weighted += Number(cdi) * Number(count);
      reports += Number(count);
    }
  }
  const report: FeltReport = { intensity: reports > 0 ? weighted / reports : null, reports };
  mkdirSync(join(CACHE, 'dyfi'), { recursive: true });
  writeJson(path, report);
  return report;
}

function minIntensity(): number {
  const value = Number(arg('min-intensity') ?? DEFAULT_ALERT_RULE.minIntensity);
  if (!Number.isFinite(value)) throw new Error('--min-intensity must be a number');
  return value;
}

/** Warning before strong shaking at home, by the true origin and location. */
function alertWarningS(r: CaseResult): number | null {
  if (r.targetAlert === null || r.c.target === null) return null;
  const sArrivalS = Math.hypot(haversineKm(r.c.target, HOME), DEPTH_KM) / S_VELOCITY_KM_S;
  return sArrivalS - (r.targetAlert.alertedAtMs - r.c.target.originMs) / 1000;
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
    magnitude: { ...DEFAULT_DETECTOR_PARAMS.magnitude },
  };
  process.argv.forEach((token, i) => {
    if (token !== '--param') return;
    const [path = '', value = ''] = (process.argv[i + 1] ?? '').split('=');
    const [section, key] = path.split('.') as [keyof DetectorParams, string];
    const target = params[section] as unknown as Record<string, number | boolean> | undefined;
    if (target === undefined || !(key in target)) throw new Error(`unknown --param ${path}`);
    if (typeof target[key] === 'boolean') {
      if (value !== 'true' && value !== 'false') throw new Error(`--param ${path} takes true or false`);
      target[key] = value === 'true';
      return;
    }
    if (!Number.isFinite(Number(value))) throw new Error(`non-numeric --param ${path}=${value}`);
    target[key] = Number(value);
  });
  return params;
}

/** "home MMI 3.4, ALERT 12.0 s before S; Burbank reported 3.8 (404)". */
function alertSummary(r: CaseResult): string {
  const last = r.magnitudeSeries[r.magnitudeSeries.length - 1];
  const predicted = last === undefined || r.targetMatch === null ? null : predictedAtHome(r.targetMatch.detection, last.magnitude);
  const head = `home MMI ${predicted === null ? '-' : fmt(predicted)}`;
  const warning = alertWarningS(r);
  const alert = warning === null ? 'no alert' : `ALERT ${fmt(warning)} s before S`;
  const felt = r.feltAtHome;
  const reported = felt === null || felt.intensity === null ? 'none reported' : `reported ${fmt(felt.intensity)} (${String(felt.reports)})`;
  return `${head}, ${alert}; home ${reported}`;
}

function predictedAtHome(at: { latitude: number; longitude: number }, magnitude: number): number {
  return new HomeAlerter(HOME, { minIntensity: Number.POSITIVE_INFINITY }, { depthKm: DEPTH_KM, sVelocityKmS: S_VELOCITY_KM_S }).intensityAtHome(at, magnitude);
}

/** The target's estimate N seconds after declaration (the last change at or before then). */
function stepAt(r: CaseResult, afterDeclarationS: number): MagnitudeStep | null {
  if (r.targetMatch === null) return null;
  const at = r.targetMatch.declaredAfterOriginS + afterDeclarationS;
  let found: MagnitudeStep | null = null;
  for (const step of r.magnitudeSeries) if (step.afterOriginS <= at + 1e-9) found = step;
  return found;
}

/** "4.1 -> 4.3 -> 4.4": at declaration, 5 s later, final. */
function magnitudeTrail(r: CaseResult): string {
  const final = r.magnitudeSeries[r.magnitudeSeries.length - 1] ?? null;
  return [stepAt(r, 0), stepAt(r, 5), final].map((s) => (s === null ? '-' : fmt(s.magnitude))).join(' -> ');
}

/** Catalogue minus estimate: mean, sd, and the count it was taken over. */
function residualSummary(residuals: number[]): string {
  if (residuals.length === 0) return 'no estimates';
  const mean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
  const sd = Math.sqrt(residuals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, residuals.length - 1));
  return `residual (catalogue - estimate) mean ${fmt(mean, 2)}, sd ${fmt(sd, 2)}, n=${String(residuals.length)}`;
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

async function main(): Promise<void> {
  const set = (arg('set') ?? 'reference') as SetName;
  if (LOCKED_SETS.has(set) && !process.argv.includes('--final')) {
    console.error('The held-out set is graded once, after tuning is finished. Re-run with --final to confirm.');
    process.exit(2);
  }
  const limit = Number(arg('limit') ?? Number.POSITIVE_INFINITY);
  const quiet = process.argv.includes('--quiet');
  mkdirSync(CACHE, { recursive: true });

  const list = await stations();
  const gains = await gainEpochs(list);
  const first = await cases();
  const all = [...first, ...(await sequenceCases(first))];
  // --only <text>: just the cases whose id or label contains it, for --trace.
  const only = arg('only');
  const chosen = all
    .filter((c) => c.set === set && (only === null || c.id.includes(only) || c.label.includes(only)))
    .slice(0, limit);
  console.log(`${String(list.length)} stations within ${String(STATION_RADIUS_KM)} km of ${HOME.label}; ${String(chosen.length)} '${set}' cases\n`);

  const results: CaseResult[] = [];
  for (const c of chosen) {
    const t = performance.now();
    const r = await runCase(c, list, gains);
    results.push(r);
    const secs = fmt((performance.now() - t) / 1000);
    const head = `${c.label.padEnd(52).slice(0, 52)} ${String(r.stationsWithData).padStart(3)} stns`;
    let verdict: string;
    if (c.set === 'tele' || c.set === 'tele-heldout' || c.set === 'random') {
      verdict = r.grade.spurious.length === 0 ? 'no false alarm' : `${String(r.grade.spurious.length)} FALSE ALARM(S)`;
      verdict += `, ${String(r.grade.matched.length)} small local quakes detected`;
      if (r.alerts.length > 0) verdict += `; ${String(r.alerts.length)} HOME ALERT(S)`;
    } else if (r.targetMatch) {
      const m = r.targetMatch;
      verdict =
        `declared +${fmt(m.declaredAfterOriginS)} s, ${fmt(m.locationErrorKm, 0)} km off, ` +
        `${String(m.detection.picks.length)} stns; warning at home ${fmt(warningAtHomeS(m))} s; ` +
        `M ${magnitudeTrail(r)} (cat ${fmt(m.quake.magnitude)}); ${alertSummary(r)}` +
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
    const moments: [string, (r: CaseResult) => MagnitudeStep | null][] = [
      ['at declaration', (r) => stepAt(r, 0)],
      ['5 s after', (r) => stepAt(r, 5)],
      ['final', (r) => r.magnitudeSeries[r.magnitudeSeries.length - 1] ?? null],
    ];
    for (const [label, pickStep] of moments) {
      const residuals = hits.flatMap((r) => {
        const step = pickStep(r);
        return step === null || r.targetMatch === null ? [] : [r.targetMatch.quake.magnitude - step.magnitude];
      });
      console.log(`magnitude ${label.padEnd(15)} ${residualSummary(residuals)}`);
    }

    // The alert against what home felt. "Felt" means reported at or above the
    // threshold; a quake with no reports from home counts as not felt there.
    const threshold = minIntensity();
    const felt = (r: CaseResult): boolean => (r.feltAtHome?.intensity ?? 0) >= threshold;
    const alerted = targets.filter((r) => r.targetAlert !== null);
    const warnings = alerted.map((r) => alertWarningS(r) as number).sort((a, b) => a - b);
    console.log(
      `\nalert at predicted MMI >= ${fmt(threshold)} at home: ${String(alerted.length)} alerted; ` +
        `felt at that level and alerted ${String(alerted.filter(felt).length)}, ` +
        `felt but not alerted ${String(targets.filter((r) => felt(r) && r.targetAlert === null).length)}, ` +
        `alerted but not felt ${String(alerted.filter((r) => !felt(r)).length)}`,
    );
    if (warnings.length > 0) console.log(`warning before S at home, alerted quakes: ${warnings.map((w) => fmt(w)).join(', ')} s`);
  }
  // Only detections the catalogue cannot account for: a real earlier quake in a
  // sequence window alerting is right, not false.
  const falseAlerts = results.reduce((n, r) => {
    const spurious = new Set(r.grade.spurious.map((d) => d.id));
    return n + r.alerts.filter((a) => spurious.has(a.eventId)).length;
  }, 0);
  console.log(`${String(falseAlerts)} home alert(s) from false detections`);
  writeJson(join(CACHE, `results-${set}.json`), results.map((r) => ({ ...r, detections: r.detections.length })));
}

await main();
