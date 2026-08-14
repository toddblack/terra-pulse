/**
 * Derives the app's geomagnetic field model from IGRF-14.
 *
 * Source: https://www.ngdc.noaa.gov/IAGA/vmod/coeffs/igrf14coeffs.txt
 * Produced by IAGA Working Group V-MOD; in the public domain, and the
 * definitive reference for Earth's main magnetic field.
 *
 * The upstream file is a 42 KB fixed-width table: 195 Schmidt semi-normalised
 * Gauss coefficients (degree n = 1..13) at 26 five-year epochs from 1900.0 to
 * 2025.0, plus a final column of secular variation in nT/year for 2025-2030.
 *
 * This emits one output:
 *
 *   igrf-coefficients.json   the same coefficients, all-numeric, with the
 *                            2030 epoch materialised
 *
 * ## Why 2030 is materialised here rather than handled at runtime
 *
 * The last column is a *rate*, not a value, so every consumer would otherwise
 * need a special case: interpolate between epochs below 2025, extrapolate by
 * secular variation above it. Turning it into an ordinary epoch at write time
 * means the runtime does plain linear interpolation across 27 epochs and has no
 * branch to get wrong.
 *
 * This is not an invention. IAGA publishes the same model in SHC format with
 * 2030 already present, and it is exactly `2025 + 5 x SV` — verified
 * coefficient-for-coefficient against `SHC_files/IGRF14.SHC` from IAGA's own
 * pyIGRF14 distribution, worst discrepancy 2.8e-14 nT (floating-point noise).
 * The text file is fetched instead of the SHC because it is a plain stable URL
 * rather than a member of a zip archive.
 *
 * ## What this deliberately does not do
 *
 * No truncation. All 13 degrees are kept: the whole reason this layer is
 * interesting rather than a textbook dipole is the regional structure — the
 * South Atlantic Anomaly above all — and that lives in the higher degrees.
 * At 5,265 numbers the entire model is smaller than a single basemap tile.
 *
 * Run:  node scripts/vendor-igrf.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const COEFFS_URL = 'https://www.ngdc.noaa.gov/IAGA/vmod/coeffs/igrf14coeffs.txt';

const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../apps/desktop/src/renderer/src/data',
);

/** IGRF-14 is a degree-13 model. n(n+2) = 195 coefficients. */
const N_MAX = 13;
const EXPECTED_COEFFICIENTS = N_MAX * (N_MAX + 2);

/** The spacing of the published epochs, and therefore the SV extrapolation. */
const EPOCH_STEP_YEARS = 5;

async function main() {
  console.log(`Fetching ${COEFFS_URL}`);
  const response = await fetch(COEFFS_URL);
  if (!response.ok) {
    throw new Error(`IGRF coefficients: HTTP ${response.status} ${response.statusText}`);
  }
  const text = await response.text();

  const lines = text.split('\n');

  // The epoch header is the row starting "g/h n m", after two comment lines.
  // Matched by content rather than line number so a change to the preamble
  // fails loudly here instead of silently shifting every column by one.
  const headerLine = lines.find((line) => line.startsWith('g/h'));
  if (!headerLine) throw new Error('No "g/h n m ..." header row found — file format changed');

  const headerFields = headerLine.trim().split(/\s+/).slice(3);
  const svLabel = headerFields.at(-1);
  if (!svLabel || !svLabel.includes('-')) {
    throw new Error(`Expected a secular-variation column last, found "${svLabel}"`);
  }

  const publishedEpochs = headerFields.slice(0, -1).map(Number);
  if (publishedEpochs.some(Number.isNaN)) throw new Error('Unparseable epoch in header');

  const lastEpoch = publishedEpochs.at(-1);
  const svEpoch = lastEpoch + EPOCH_STEP_YEARS;
  const epochs = [...publishedEpochs, svEpoch];

  // Data rows are the ones beginning with a bare "g" or "h" field. The header
  // also starts with "g", hence the split-and-check rather than startsWith.
  const rows = [];
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== 'g' && fields[0] !== 'h') continue;
    if (fields.length !== headerFields.length + 3) continue;

    const kind = fields[0];
    const n = Number(fields[1]);
    const m = Number(fields[2]);
    const values = fields.slice(3).map(Number);
    if (values.some(Number.isNaN)) throw new Error(`Unparseable value in row: ${line}`);

    const sv = values.at(-1);
    const atLastEpoch = values.at(-2);
    // The materialised epoch, as described at the top of this file.
    const extrapolated = atLastEpoch + EPOCH_STEP_YEARS * sv;

    rows.push({ kind, n, m, values: [...values.slice(0, -1), extrapolated] });
  }

  if (rows.length !== EXPECTED_COEFFICIENTS) {
    throw new Error(`Expected ${EXPECTED_COEFFICIENTS} coefficients, parsed ${rows.length}`);
  }
  const degreeMax = Math.max(...rows.map((r) => r.n));
  if (degreeMax !== N_MAX) throw new Error(`Expected degree ${N_MAX}, found ${degreeMax}`);

  // Every row must carry a value at every epoch, or interpolation would read
  // undefined and produce NaN across a whole hemisphere with no error.
  for (const row of rows) {
    if (row.values.length !== epochs.length) {
      throw new Error(`${row.kind}(${row.n},${row.m}) has ${row.values.length} values, expected ${epochs.length}`);
    }
  }

  const model = {
    generation: 14,
    nMax: N_MAX,
    source: COEFFS_URL,
    epochs,
    // Flat and all-numeric: [n, m, ...one value per epoch]. Kept in the file's
    // own order, which is n ascending then m ascending, g before h.
    g: rows.filter((r) => r.kind === 'g').map((r) => [r.n, r.m, ...r.values]),
    h: rows.filter((r) => r.kind === 'h').map((r) => [r.n, r.m, ...r.values]),
  };

  const path = join(OUT_DIR, 'igrf-coefficients.json');
  writeFileSync(path, JSON.stringify(model));

  console.log(`Wrote ${path}`);
  console.log(`  degree ${model.nMax}, ${rows.length} coefficients`);
  console.log(`  ${epochs.length} epochs, ${epochs[0]} -> ${epochs.at(-1)}`);
  console.log(`  (${svEpoch} derived from the ${svLabel} secular variation column)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
