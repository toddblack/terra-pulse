/**
 * Derives the app's active-fault dataset from the GEM Global Active Faults
 * Database.
 *
 * Source: https://github.com/GEMScienceTools/gem-global-active-faults —
 *   `geojson/gem_active_faults_harmonized.geojson` (10.1 MB, 13,696 faults)
 * Citation: Styron, R. & Pagani, M. (2020), "The GEM Global Active Faults
 *   Database", Earthquake Spectra 36(1_suppl), 160-180.
 *
 * ## Licence — read this before changing what the script emits
 *
 * **CC-BY-SA 4.0.** Two obligations, and one common misreading:
 *
 *   - Attribution is required. It appears in the app's legend.
 *   - Share-alike applies to *Adapted Material* — derivatives of the dataset.
 *     The file this script writes IS such a derivative, so it carries
 *     CC-BY-SA. The application source code is not: software that reads a
 *     dataset is not an adaptation of it, the same way shipping OpenStreetMap
 *     data doesn't relicense an app.
 *   - **CC-BY-SA does not forbid commercial use.** That's CC-BY-NC, which this
 *     is not.
 *
 * The one genuinely unsettled point: CC-BY-SA 4.0 has no explicit "Produced
 * Work" carve-out of the sort ODbL provides, so a rendered map image
 * containing these faults is arguably Adapted Material too. If this project
 * ever exports imagery commercially, that's the question to get answered —
 * GEM offers custom licensing for uses that don't fit the default terms.
 *
 * Run:  node scripts/vendor-gem-faults.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FAULTS_URL =
  'https://raw.githubusercontent.com/GEMScienceTools/gem-global-active-faults/master/geojson/gem_active_faults_harmonized.geojson';

const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../apps/desktop/src/renderer/src/data',
);

/**
 * Length thresholds, km, splitting faults into three zoom tiers.
 *
 * Measured distribution: median 30.9 km, p90 98 km, max 5,477 km. So these
 * cuts put roughly 10% of faults in the always-visible tier and half in the
 * closest one — which is what keeps the full-globe view from turning into a
 * hairball of 13,696 lines.
 */
const TIER_LONG_KM = 100;
const TIER_MEDIUM_KM = 30;

/**
 * Longest chord we'll draw between two vertices, km.
 *
 * The renderer uses Cesium's `PolylineCollection`, which draws straight lines
 * in 3D and has no `ArcType.GEODESIC` — the setting `plate-boundaries.ts`
 * relies on for exactly this. A straight chord cuts *through* the ellipsoid,
 * so a long one sinks below the surface and clips at grazing view angles.
 *
 * GEM's mapping is detailed (median segment 1.1 km) but a few are very long:
 * p99 is 61 km and the longest is 346 km, which would sag 2.4 km underground.
 * Splitting at 50 km caps the sag at 49 m — invisible at any zoom — and costs
 * 2,554 extra vertices, +1.6%. Densifying here rather than at render time
 * keeps the runtime free of trigonometry.
 */
const MAX_CHORD_KM = 50;

const EARTH_RADIUS_KM = 6371;
const round = (n) => Number(n.toFixed(3));

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

function lengthKm(coordinates) {
  let total = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    total += haversineKm(
      coordinates[i - 1][1],
      coordinates[i - 1][0],
      coordinates[i][1],
      coordinates[i][0],
    );
  }
  return total;
}

/**
 * Great-circle interpolation between two points (spherical slerp).
 *
 * Interpolating lat/lon linearly would put the inserted vertices slightly off
 * the great circle, which defeats the point — they'd reduce the sag but not to
 * the value MAX_CHORD_KM was chosen for.
 */
function interpolate(lon1, lat1, lon2, lat2, fraction) {
  const toRad = Math.PI / 180;
  const [p1, t1, p2, t2] = [lon1 * toRad, lat1 * toRad, lon2 * toRad, lat2 * toRad];
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((t2 - t1) / 2) ** 2 +
          Math.cos(t1) * Math.cos(t2) * Math.sin((p2 - p1) / 2) ** 2,
      ),
    );
  if (d === 0) return [lon1, lat1];

  const a = Math.sin((1 - fraction) * d) / Math.sin(d);
  const b = Math.sin(fraction * d) / Math.sin(d);
  const x = a * Math.cos(t1) * Math.cos(p1) + b * Math.cos(t2) * Math.cos(p2);
  const y = a * Math.cos(t1) * Math.sin(p1) + b * Math.cos(t2) * Math.sin(p2);
  const z = a * Math.sin(t1) + b * Math.sin(t2);
  return [
    Math.atan2(y, x) / toRad,
    Math.atan2(z, Math.sqrt(x * x + y * y)) / toRad,
  ];
}

/** Splits any chord longer than MAX_CHORD_KM into equal great-circle steps. */
function densify(coordinates) {
  const out = [coordinates[0]];

  for (let i = 1; i < coordinates.length; i += 1) {
    const [lon1, lat1] = coordinates[i - 1];
    const [lon2, lat2] = coordinates[i];
    const steps = Math.ceil(haversineKm(lat1, lon1, lat2, lon2) / MAX_CHORD_KM);

    for (let s = 1; s < steps; s += 1) {
      out.push(interpolate(lon1, lat1, lon2, lat2, s / steps));
    }
    out.push(coordinates[i]);
  }

  return out;
}

/** 0 = long (always drawn), 1 = medium, 2 = short (closest zoom only). */
function zoomTier(km) {
  if (km >= TIER_LONG_KM) return 0;
  if (km >= TIER_MEDIUM_KM) return 1;
  return 2;
}

async function main() {
  process.stdout.write('fetching GEM active faults (10 MB)… ');
  const response = await fetch(FAULTS_URL);
  if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
  const { features } = await response.json();
  console.log(`${features.length} faults`);

  const faults = [];
  const tierCounts = [0, 0, 0];
  let longestSegmentKm = 0;
  let skipped = 0;

  for (const feature of features) {
    if (feature.geometry?.type !== 'LineString') {
      // Every feature is a LineString today. If that ever changes, say so
      // rather than silently dropping part of the world's faults.
      skipped += 1;
      continue;
    }
    const coordinates = feature.geometry.coordinates;
    if (coordinates.length < 2) {
      skipped += 1;
      continue;
    }

    // Tier from the true length, before densification adds vertices.
    const tier = zoomTier(lengthKm(coordinates));
    tierCounts[tier] += 1;

    const dense = densify(coordinates);
    for (let i = 1; i < dense.length; i += 1) {
      const segment = haversineKm(dense[i - 1][1], dense[i - 1][0], dense[i][1], dense[i][0]);
      if (segment > longestSegmentKm) longestSegmentKm = segment;
    }

    faults.push({
      z: tier,
      p: dense.flatMap((c) => [round(c[0]), round(c[1])]),
    });
  }

  // Only geometry and a zoom tier. The 20-odd attribute columns (slip_type,
  // slip rates, dip, names) are deliberately dropped: the layer renders every
  // fault in one muted colour, so none of them affect a pixel, and carrying
  // them would quadruple the file for nothing. Re-add a field here if a
  // future layer actually reads it.
  const path = join(OUT_DIR, 'active-faults.json');
  writeFileSync(path, JSON.stringify(faults));

  const bytes = JSON.stringify(faults).length;
  if (skipped > 0) console.log(`skipped: ${skipped} non-LineString or degenerate features`);
  console.log(`faults : ${faults.length.toLocaleString()}`);
  console.log(
    `tiers  : ${tierCounts[0]} long (>=${TIER_LONG_KM}km) · ` +
      `${tierCounts[1]} medium · ${tierCounts[2]} short (<${TIER_MEDIUM_KM}km)`,
  );
  // Guards the densifier: if this ever exceeds the cap, chords are sagging
  // below the globe again and the fix silently stopped working.
  console.log(
    `longest chord after densify: ${longestSegmentKm.toFixed(1)} km (cap ${MAX_CHORD_KM})`,
  );
  if (longestSegmentKm > MAX_CHORD_KM * 1.01) {
    throw new Error(`densify failed: ${longestSegmentKm.toFixed(1)} km chord exceeds cap`);
  }
  console.log(`size   : ${(bytes / 1048576).toFixed(2)} MB`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
