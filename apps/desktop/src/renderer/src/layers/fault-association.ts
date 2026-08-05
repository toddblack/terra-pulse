/**
 * Associating a point on the globe with the nearest mapped active fault.
 *
 * Pure geometry over the vendored GEM dataset, with no Cesium in sight, so it
 * can be tested and benchmarked without a WebGL context — the same split
 * `earthquake-encoding.ts` uses.
 *
 * ## What this can and cannot tell you
 *
 * It answers "which mapped fault trace is closest, and how far". It does **not**
 * establish that an earthquake occurred *on* that fault. Epicentres carry real
 * location error, GEM maps surface traces while earthquakes happen at depth, and
 * a dipping fault's trace can sit tens of km from the rupture directly beneath
 * it. The distance is reported rather than thresholded away for exactly that
 * reason: the reader is entitled to see 3 km and 40 km differently.
 */

/**
 * One fault as vendored. Every attribute is optional and most are genuinely
 * absent — measured across the dataset, **44.6% carry a name** and 74.1% a slip
 * rate, so code written against the well-populated examples will look broken in
 * the field.
 */
export interface FaultRecord {
  /** Zoom tier, 0 = long. */
  z: number;
  /** Flat [lon, lat, lon, lat, …], densified to a 50 km maximum chord. */
  p: number[];
  /** Fault name, from GEM's `name` or `fs_name`. */
  n?: string;
  /** Net slip rate, mm/yr — GEM's preferred value. */
  s?: number;
  /** Slip rate lower bound, mm/yr. */
  sl?: number;
  /** Slip rate upper bound, mm/yr. */
  sh?: number;
  /** Kinematics: Dextral, Reverse, Subduction_Thrust, Spreading_Ridge, … */
  t?: string;
  /** Source catalogue the record came from, e.g. UCERF3. */
  c?: string;
}

export interface FaultMatch {
  fault: FaultRecord;
  /** Great-circle distance from the query point to the trace, km. */
  distanceKm: number;
}

const KM_PER_DEGREE = 111.32;

/**
 * Signed longitude difference, normalised to [-180, 180].
 *
 * Without this a point at 179.9°E and a fault at 179.9°W compute as 359.8°
 * apart — roughly 40,000 km — so the Kuril, Aleutian and Tongan trenches would
 * every one of them report some fault on the far side of the planet as nearest.
 */
function deltaLon(a: number, b: number): number {
  let delta = a - b;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

/**
 * Squared distance from the origin to a segment, in a local flat frame.
 *
 * The frame is an equirectangular projection centred on the query point, with
 * longitudes scaled by cos(latitude). Over the distances that matter here — the
 * nearest fault is tens of km away, not thousands — the error against a true
 * great-circle solve is well under a percent, and this runs ~144,000 times per
 * query, which a spherical cross-track formula would not survive.
 *
 * Returns squared km to keep the square root out of the inner loop.
 */
function segmentDistanceSqKm(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;

  // A degenerate segment is a point. GEM has none after densification, but a
  // zero-length segment would divide by zero and poison the whole query.
  if (lengthSq === 0) return ax * ax + ay * ay;

  // Projection of the origin onto the segment, clamped to its ends so the
  // result is distance to the *segment* rather than to its infinite line.
  let t = -(ax * dx + ay * dy) / lengthSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;

  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return cx * cx + cy * cy;
}

/**
 * The mapped fault nearest to `point`, or null if the dataset is empty.
 *
 * Brute force over every vertex, deliberately. Measured against the real 13,696
 * faults / 157,548 vertices it runs in a few milliseconds, which is well inside
 * a click — and a spatial index would be a second structure to keep in step with
 * the data for no gain a user could perceive. Revisit if this ever moves to
 * hover.
 */
export function nearestFault(
  point: { latitude: number; longitude: number },
  faults: readonly FaultRecord[],
): FaultMatch | null {
  const cosLat = Math.cos((point.latitude * Math.PI) / 180);

  let best: FaultRecord | null = null;
  let bestSq = Number.POSITIVE_INFINITY;

  for (const fault of faults) {
    const coords = fault.p;

    // Project this fault's vertices into the local frame once, walking
    // segments as we go.
    let previousX = deltaLon(coords[0] as number, point.longitude) * KM_PER_DEGREE * cosLat;
    let previousY = ((coords[1] as number) - point.latitude) * KM_PER_DEGREE;

    // A single-vertex trace has no segment; compare the point itself.
    if (coords.length === 2) {
      const sq = previousX * previousX + previousY * previousY;
      if (sq < bestSq) {
        bestSq = sq;
        best = fault;
      }
      continue;
    }

    for (let i = 2; i < coords.length; i += 2) {
      const x = deltaLon(coords[i] as number, point.longitude) * KM_PER_DEGREE * cosLat;
      const y = ((coords[i + 1] as number) - point.latitude) * KM_PER_DEGREE;

      const sq = segmentDistanceSqKm(previousX, previousY, x, y);
      if (sq < bestSq) {
        bestSq = sq;
        best = fault;
      }

      previousX = x;
      previousY = y;
    }
  }

  return best === null ? null : { fault: best, distanceKm: Math.sqrt(bestSq) };
}

/** GEM's slip-type codes are machine-shaped; this is the human reading. */
export function formatSlipType(slipType: string | undefined): string | null {
  if (!slipType) return null;
  return slipType.replace(/_/g, ' ').toLowerCase();
}

/**
 * The slip rate as a phrase, with its bounds when GEM supplies them.
 *
 * The bounds are shown wherever they exist because they are frequently wide —
 * the San Andreas at Parkfield is 30.54 mm/yr against a 23.16–43.26 range — and
 * a bare preferred value implies a precision the source does not claim.
 */
export function formatSlipRate(fault: FaultRecord): string | null {
  if (fault.s === undefined) return null;
  const preferred = `${fault.s} mm/yr`;
  if (fault.sl === undefined || fault.sh === undefined) return preferred;
  return `${preferred} (${fault.sl}–${fault.sh})`;
}
