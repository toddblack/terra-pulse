/**
 * Derives the app's subduction-zone dataset from USGS Slab2.
 *
 * Source: https://github.com/usgs/slab2 —
 *   `slab2code/library/forplotting/trenches_usgs_2017.csv` (159 KB)
 * Citation: Hayes et al. (2018), "Slab2, a comprehensive subduction zone
 *   geometry model", Science 362(6410), 58-61.
 * Licence: CC0 1.0 public domain dedication. No attribution condition and no
 *   share-alike; the citation below is scientific courtesy, not a licence term.
 *
 * ## Why this source and not Bird's PB2002
 *
 * Sawteeth encode *polarity* — which plate dives beneath the other. Bird's
 * steps file cannot supply it: its VELOCITYAZ is the velocity of the left
 * plate w.r.t. the right, and "left/right" come from digitisation order, so
 * for converging plates the vector points to the right-hand side by
 * construction (measured: 1,129 of 1,129 subduction steps, 100%). It carries
 * convergence rate and nothing about direction of dip.
 *
 * Slab2's trench file does carry it. See dipAzimuth() in
 * `layers/subduction-encoding.ts` for the derivation and its verification.
 *
 * Run:  node scripts/vendor-slab2-trenches.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TRENCH_URL =
  'https://raw.githubusercontent.com/usgs/slab2/master/slab2code/library/forplotting/trenches_usgs_2017.csv';

const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../apps/desktop/src/renderer/src/data',
);

/**
 * Points are spaced ~13 km apart, far denser than a tooth every 150 km. A gap
 * larger than this means the file has moved to a different arc, not that the
 * trench really jumps — so it starts a new run rather than drawing a stray
 * line across an ocean.
 */
const RUN_BREAK_KM = 150;

/**
 * Tooth spacing. Yields ~390 teeth over 58,935 km of trench — the same order
 * as the earthquake layer's mark count, which renders comfortably.
 */
const TOOTH_SPACING_KM = 150;

const EARTH_RADIUS_KM = 6371;
const round = (n, dp = 3) => Number(n.toFixed(dp));

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/** Slab2 `az` is the trench strike; the slab dips 90 degrees clockwise of it. */
function dipAzimuth(strikeAzimuth) {
  return ((((strikeAzimuth + 90) % 360) + 360) % 360);
}

function parseRows(csv) {
  const [header, ...lines] = csv.trim().split('\n');
  const expected = 'lon,lat,az,bound,slab';
  if (header.trim() !== expected) {
    // The column order is load-bearing — a silent upstream reshuffle would
    // put strike where longitude should be and draw nonsense.
    throw new Error(`unexpected header: "${header.trim()}" (expected "${expected}")`);
  }
  return lines.map((line) => {
    const [lon, lat, az, bound, slab] = line.split(',');
    return { lon: +lon, lat: +lat, az: +az, bound, slab };
  });
}

async function main() {
  process.stdout.write('fetching Slab2 trenches… ');
  const response = await fetch(TRENCH_URL);
  if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
  const rows = parseRows(await response.text());
  console.log(`${rows.length} points`);

  // --- split into contiguous runs -----------------------------------------
  const runs = [];
  let current = null;

  for (const [index, row] of rows.entries()) {
    const previous = rows[index - 1];
    const breaks =
      !previous ||
      previous.slab !== row.slab ||
      haversineKm(previous.lat, previous.lon, row.lat, row.lon) > RUN_BREAK_KM;

    if (breaks) {
      current = { s: row.slab, b: row.bound, p: [], rows: [] };
      runs.push(current);
    }
    current.p.push(round(row.lon), round(row.lat));
    current.rows.push(row);
  }

  // --- place teeth at even spacing along each run --------------------------
  const teeth = [];
  let totalKm = 0;

  for (const run of runs) {
    // Half a spacing in, so a run doesn't open with a tooth sitting exactly on
    // its endpoint where it reads as detached from the line.
    let sinceTooth = TOOTH_SPACING_KM / 2;

    for (const [index, row] of run.rows.entries()) {
      const previous = run.rows[index - 1];
      if (previous) {
        const step = haversineKm(previous.lat, previous.lon, row.lat, row.lon);
        sinceTooth += step;
        totalKm += step;
      }
      if (sinceTooth < TOOTH_SPACING_KM) continue;
      sinceTooth = 0;

      teeth.push({
        lon: round(row.lon),
        lat: round(row.lat),
        // Dip azimuth, degrees clockwise from north — the direction the slab
        // descends, which is where the tooth points.
        d: Math.round(dipAzimuth(row.az)),
      });
    }
  }

  // A run of one point can't be a polyline. Two exist — an isolated point in
  // the Sumatra file and one in the Solomon file, each stranded from its
  // neighbours by more than RUN_BREAK_KM. They carry no teeth either (a tooth
  // needs a preceding point to accumulate distance from), so dropping them
  // loses nothing but a would-be zero-length line.
  const drawable = runs.filter((run) => run.p.length >= 4);
  const dropped = runs.length - drawable.length;

  const out = {
    t: drawable.map((run) => ({ s: run.s, b: run.b, p: run.p })),
    k: teeth,
  };
  const path = join(OUT_DIR, 'subduction-trenches.json');
  writeFileSync(path, JSON.stringify(out));

  console.log(
    `runs   : ${out.t.length} across ${new Set(rows.map((r) => r.slab)).size} slab regions` +
      (dropped > 0 ? ` (${dropped} single-point runs dropped)` : ''),
  );
  console.log(`trench : ${Math.round(totalKm).toLocaleString()} km`);
  console.log(`teeth  : ${teeth.length} at ${TOOTH_SPACING_KM} km spacing`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
