import raw from '../data/igrf-coefficients.json';

/**
 * The vendored IGRF-14 model, typed once.
 *
 * Same purpose as `fault-data.ts` — the *declared* contract lives in one place
 * next to the script that writes the file — but deliberately **not** the same
 * mechanism. That module has to launder the import through `unknown` because at
 * 3.16 MB with heterogeneous shapes TypeScript's inferred literal type stops
 * resolving. This file is 20 KB and homogeneous, so inference works: the
 * annotation below is checked against the real shape rather than asserted over
 * it, which is strictly better. Lint enforces the difference — an `as unknown
 * as` here is reported as unnecessary, which is the tell that the file is still
 * small enough not to need it.
 *
 * It lives in `layers/` rather than beside the JSON because `data/` is
 * gitignored; everything in there is script-derived.
 *
 * Row layout is `[n, m, ...one value per epoch]`, all-numeric, in the upstream
 * file's own order: n ascending, then m ascending.
 */
export interface IgrfModel {
  generation: number;
  nMax: number;
  source: string;
  /** Decimal years, ascending. 1900 to 2030 in five-year steps. */
  epochs: number[];
  g: number[][];
  h: number[][];
}

export const IGRF_MODEL: IgrfModel = raw;
