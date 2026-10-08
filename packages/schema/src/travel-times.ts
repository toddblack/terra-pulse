/**
 * When a quake's P and S waves reach a given distance — the clock a replay's
 * rings and rows are drawn on.
 *
 * **IASP91 first arrivals for a 10 km source, computed with TauP (ObsPy 1.5.1)
 * on 2026-10-07**, not recalled: at each distance the earliest of p/P/Pn/Pg and
 * of s/S/Sn/Sg. Up to about 1.5° that is the direct crustal wave; past it, the
 * faster path under the crust (Pn, then P through the mantle) wins, which is
 * why a single crustal speed is fine for the detector's few nearby stations and
 * wrong for a row 2,000 km out — the reason this table exists. A crustal 6.2
 * km/s puts the P wave at 2,000 km about 50 s late.
 *
 * Fixed depth, on purpose: the catalogue depth would move a deep quake's
 * arrivals by tens of seconds, but a replay's rings are drawn from one depth
 * for every quake. What the table gets wrong for a deep quake, the replay
 * guide says.
 *
 * Linear between rows. The rows are close enough that the interpolation error
 * (well under a second below 30°) is far below what a ring a pixel wide can
 * show.
 */

type Row = readonly [degrees: number, pSeconds: number, sSeconds: number];

const IASP91_10KM: readonly Row[] = [
  [0, 1.7, 3.0], [0.1, 2.6, 4.4], [0.25, 5.1, 8.8], [0.5, 9.7, 16.8], [0.75, 14.5, 25.0],
  [1, 19.2, 33.2], [1.5, 27.0, 47.4], [2, 33.8, 59.8], [2.5, 40.7, 72.1], [3, 47.6, 84.5],
  [4, 61.3, 109.2], [5, 75.1, 133.9], [6, 88.8, 158.6], [7, 102.5, 183.3], [8, 116.3, 207.9],
  [10, 143.7, 257.1], [12, 171.1, 306.1], [14, 198.4, 355.0], [16, 225.1, 403.6], [18, 250.3, 452.0],
  [20, 272.7, 498.5], [22, 294.3, 538.1], [24, 314.8, 572.8], [26, 333.0, 604.7], [28, 351.0, 636.2],
  [30, 368.7, 667.6], [35, 412.4, 745.3], [40, 454.7, 821.1], [45, 495.4, 894.7], [50, 534.3, 965.8],
  [60, 606.7, 1100.0], [70, 671.8, 1223.0], [80, 729.6, 1334.2], [90, 779.7, 1432.9],
];

const KM_PER_DEGREE = 111.19;

/** How far the table reaches. Past it, P begins to run into the core's shadow. */
export const TRAVEL_TIME_MAX_KM = 90 * KM_PER_DEGREE;

export type SeismicPhase = 'P' | 'S';

const column = (phase: SeismicPhase): 1 | 2 => (phase === 'P' ? 1 : 2);
const row = (i: number): Row => IASP91_10KM[i] as Row;

/** Seconds from the origin for `phase` to reach `distanceKm`. Clamped to the table's ends. */
export function travelSeconds(phase: SeismicPhase, distanceKm: number): number {
  const c = column(phase);
  const deg = Math.max(0, distanceKm) / KM_PER_DEGREE;
  for (let i = 1; i < IASP91_10KM.length; i += 1) {
    const hi = row(i);
    if (deg <= hi[0]) {
      const lo = row(i - 1);
      return lo[c] + ((deg - lo[0]) / (hi[0] - lo[0])) * (hi[c] - lo[c]);
    }
  }
  return row(IASP91_10KM.length - 1)[c];
}

/**
 * How far along the surface `phase` has reached `elapsedS` after the origin —
 * the inverse of `travelSeconds`, which is monotonic for first arrivals. Null
 * before the wave reaches the surface at all, and past the table's end.
 */
export function wavefrontKm(phase: SeismicPhase, elapsedS: number): number | null {
  const c = column(phase);
  if (elapsedS < row(0)[c]) return null;
  for (let i = 1; i < IASP91_10KM.length; i += 1) {
    const hi = row(i);
    if (elapsedS <= hi[c]) {
      const lo = row(i - 1);
      return (lo[0] + ((elapsedS - lo[c]) / (hi[c] - lo[c])) * (hi[0] - lo[0])) * KM_PER_DEGREE;
    }
  }
  return null;
}
