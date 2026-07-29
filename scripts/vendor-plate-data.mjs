/**
 * Derives the app's plate datasets from Bird (2003) PB2002.
 *
 * Source: https://github.com/fraxen/tectonicplates — `GeoJSON/PB2002_steps.json`
 * Licence: ODC-BY 1.0. Modification is permitted with attribution; this script
 * exists so the transform is reproducible rather than a mystery blob.
 *
 * The upstream steps file is 10 MB of 5,824 two-point segments. That's far more
 * than the renderer needs, so this produces one compact output:
 *
 *   plate-boundaries.json  merged polylines carrying a kinematic class
 *
 * We do NOT emit motion vectors. See the note on VELOCITYAZ below.
 *
 * Run:  node scripts/vendor-plate-data.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const STEPS_URL =
  'https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_steps.json';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../apps/desktop/src/renderer/src/data');

/**
 * Bird's seven step classes collapsed to the three kinematic behaviours.
 *
 * Three rather than seven because the palette validator passes three
 * categorical colours on the all-pairs test and cannot pass seven — a
 * seven-colour key would be indistinguishable in practice. The oceanic /
 * continental distinction is dropped from the render, not from the source.
 */
const KINEMATIC_GROUP = {
  SUB: 'convergent', // subduction zone
  OCB: 'convergent', // oceanic convergent boundary
  CCB: 'convergent', // continental convergent boundary
  OSR: 'divergent', // oceanic spreading ridge
  CRB: 'divergent', // continental rift boundary
  OTF: 'transform', // oceanic transform fault
  CTF: 'transform', // continental transform fault
};

/**
 * A warning, so nobody rebuilds the motion layer we deleted.
 *
 * VELOCITYAZ is "azimuth of the velocity of the LEFT plate with respect to the
 * RIGHT plate", where left/right are defined by the order Bird digitised each
 * segment. For two converging plates that vector points toward the right-hand
 * side *by construction* — measured, it does so for 1129 of 1129 subduction
 * steps, 100%. So it says the plates converge and how fast, and nothing about
 * which plate dives beneath the other.
 *
 * Rendering it as an arrow therefore draws digitisation order, not tectonics:
 * spot-checked against five known trenches it matched three and pointed 180°
 * wrong on Tonga and Sumatra — a coin flip, which is what a signal-free method
 * scores. Cartographic sawteeth need true polarity, which lives in slab
 * geometry (USGS Slab2), not in this file.
 */

const round = (n, dp = 3) => Number(n.toFixed(dp));

async function main() {
  process.stdout.write('fetching PB2002 steps (10 MB)… ');
  const response = await fetch(STEPS_URL);
  if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
  const { features } = await response.json();
  console.log(`${features.length} steps`);

  // --- boundaries: merge contiguous runs sharing boundary + class ----------
  const boundaries = [];
  let current = null;

  for (const feature of features) {
    const p = feature.properties;
    const group = KINEMATIC_GROUP[p.STEPCLASS];
    if (!group) throw new Error(`unmapped STEPCLASS: ${p.STEPCLASS}`);

    const joinsPrevious =
      current !== null &&
      current.boundary === p.PLATEBOUND &&
      current.stepClass === p.STEPCLASS &&
      Math.abs(current.lastLon - p.STARTLONG) < 1e-6 &&
      Math.abs(current.lastLat - p.STARTLAT) < 1e-6;

    if (!joinsPrevious) {
      current = {
        boundary: p.PLATEBOUND,
        stepClass: p.STEPCLASS,
        group,
        points: [round(p.STARTLONG), round(p.STARTLAT)],
        lastLon: 0,
        lastLat: 0,
      };
      boundaries.push(current);
    }

    current.points.push(round(p.FINALLONG), round(p.FINALLAT));
    current.lastLon = p.FINALLONG;
    current.lastLat = p.FINALLAT;
  }

  // Flat coordinate arrays keep the file small and map straight onto Cesium's
  // Cartesian3.fromDegreesArray.
  const boundaryOut = boundaries.map((b) => ({
    b: b.boundary,
    c: b.stepClass,
    g: b.group,
    p: b.points,
  }));

  writeFileSync(join(OUT_DIR, 'plate-boundaries.json'), JSON.stringify(boundaryOut));

  const groups = {};
  for (const b of boundaryOut) groups[b.g] = (groups[b.g] || 0) + 1;

  console.log(`boundaries : ${boundaryOut.length} polylines`, groups);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
