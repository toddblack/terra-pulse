import trenchData from '../../renderer/src/data/subduction-trenches.json';

/**
 * Slab2 trench vertices, flattened for H6's subduction-zone subset.
 *
 * ## Why main imports a file out of `renderer/`
 *
 * This is the only place in the codebase that crosses that boundary, so it is
 * worth saying why rather than leaving it looking like an oversight.
 *
 * The dataset has exactly one copy in the repo — and it is **gitignored**, not
 * committed: `scripts/vendor-slab2-trenches.mjs` derives it from USGS Slab2 on
 * demand, which is what standing rule 1 in `SOURCES.md` requires of every
 * third-party dataset here. Two ways to share it were considered:
 *
 * - **Move it into `packages/schema`.** That is where `COVERAGE_TIERS` and the
 *   other definitions read by both processes live, so it looks right. It would
 *   make the *types* package depend on a generated artifact that is absent
 *   from a fresh clone — so `pnpm build` would fail in `packages/schema`,
 *   before anything that plausibly explains why.
 * - **Vendor a second copy for main.** Two copies of one dataset, free to
 *   drift, to avoid one import.
 *
 * Importing it is the smaller cost. If a second main-side consumer of globe
 * data ever appears, that is the point to reconsider.
 *
 * ## The coordinate order is the thing to get right
 *
 * Slab2 runs store `p` as a **flat [lon, lat, lon, lat, …]** array — longitude
 * first, which is the opposite of how every other coordinate pair in this
 * codebase is written. Reading it as lat-first does not throw: it produces a
 * plausible set of points in the wrong hemispheres, which would quietly select
 * a different set of events as "subduction-zone" and change H6's second test
 * with nothing to show for it.
 */

interface TrenchRun {
  /** Slab2 region code, e.g. "sam". */
  s: string;
  /** Plate pair as Slab2 labels it, e.g. "NZ/SA". */
  b: string;
  /** Flat [lon, lat, lon, lat, …]. */
  p: number[];
}

interface TrenchFile {
  t: TrenchRun[];
  k: unknown;
}

export interface TrenchPoints {
  latitude: number[];
  longitude: number[];
}

/**
 * Every trench vertex as parallel lat/lon arrays.
 *
 * Sent to the engine whole rather than reduced here: "within 300 km of a
 * trench" is a registered parameter, and applying it in two places would let
 * the two disagree. Measured at ~7,700 points, which is a few hundred KB of
 * JSON on a request that already carries tens of thousands of events.
 */
export function trenchPoints(): TrenchPoints {
  const latitude: number[] = [];
  const longitude: number[] = [];

  for (const run of (trenchData as TrenchFile).t) {
    for (let index = 0; index + 1 < run.p.length; index += 2) {
      // lon, then lat — see the note above.
      longitude.push(run.p[index]!);
      latitude.push(run.p[index + 1]!);
    }
  }

  return { latitude, longitude };
}
