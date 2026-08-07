/**
 * Associating earthquakes with the plate boundary they occurred on.
 *
 * Pure geometry over the vendored Bird (2003) PB2002 dataset, Cesium-free so it
 * can be tested without a WebGL context — the same split `fault-association.ts`
 * uses, and it shares that module's point-to-segment maths.
 *
 * ## Why this reports rather than filters
 *
 * The obvious use of boundary data is to *restrict* a regional query to one
 * boundary — "recurrence along the Japan Trench". Measured, that destroys the
 * sample. Of the 17 M7.5+ events within 500 km of Tokyo since 1900, only **3**
 * lie within 100 km of the boundary nearest the city (`OK-PS`); the rest belong
 * to four other plate pairs, ten of them to the Japan Trench (`PA\OK`). Tokyo
 * sits on a triple junction, so the closest boundary is not the seismogenic one.
 * Wellington is starker: its nearest boundary is 9 km away and **none** of its
 * events are within 100 km of it.
 *
 * Filtering to "any boundary" fails the opposite way — in a subduction zone
 * nearly everything is near a boundary (16 of Tokyo's 17), so it removes almost
 * nothing and buys nothing.
 *
 * So the boundary is presented as **context**: which boundaries this region's
 * earthquakes actually sit on, ranked. That answers "what tectonic setting is
 * this?" without cutting 17 events down to 3.
 */
import plateData from '../data/plate-boundaries.json';

/** One PB2002 boundary segment, as vendored. */
export interface PlateBoundarySegment {
  /** Plate pair, e.g. `PA\OK`. Separator encodes subduction polarity. */
  b: string;
  /** Class: SUB, OTF, OSR, OCB, CTF, CRB, CCB. */
  c: string;
  /** Kinematic group used by the layer's colouring. */
  g: string;
  /** Flat [lon, lat, lon, lat, …]. */
  p: number[];
}

// Asserted once, for the reason documented in `fault-data.ts`: a large JSON
// module's inferred type stops resolving and every property read becomes an
// unsafe-member-access error under type-aware lint.
export const PLATE_BOUNDARIES = plateData as unknown as PlateBoundarySegment[];

/**
 * Bird's two-letter plate codes.
 *
 * All 52 in the dataset. An unknown code falls back to the code itself rather
 * than to "Unknown", so a future PB2002 revision degrades to something a reader
 * can still look up.
 */
const PLATE_NAMES: Readonly<Record<string, string>> = {
  AF: 'Africa', AM: 'Amur', AN: 'Antarctica', AP: 'Altiplano', AR: 'Arabia',
  AS: 'Aegean Sea', AT: 'Anatolia', AU: 'Australia', BH: "Bird's Head",
  BR: 'Balmoral Reef', BS: 'Banda Sea', BU: 'Burma', CA: 'Caribbean',
  CL: 'Caroline', CO: 'Cocos', CR: 'Conway Reef', EA: 'Easter',
  EU: 'Eurasia', FT: 'Futuna', GP: 'Galapagos', IN: 'India',
  JF: 'Juan de Fuca', JZ: 'Juan Fernandez', KE: 'Kermadec', MA: 'Mariana',
  MN: 'Manus', MO: 'Maoke', MS: 'Molucca Sea', NA: 'North America',
  NB: 'North Bismarck', ND: 'North Andes', NH: 'New Hebrides',
  NI: "Niuafo'ou", NZ: 'Nazca', OK: 'Okhotsk', ON: 'Okinawa', PA: 'Pacific',
  PM: 'Panama', PS: 'Philippine Sea', RI: 'Rivera', SA: 'South America',
  SB: 'South Bismarck', SC: 'Scotia', SL: 'Shetland', SO: 'Somalia',
  SS: 'Solomon Sea', SU: 'Sunda', SW: 'Sandwich', TI: 'Timor', TO: 'Tonga',
  WL: 'Woodlark', YA: 'Yangtze',
};

/** PB2002 boundary classes, spelled out. */
const CLASS_NAMES: Readonly<Record<string, string>> = {
  SUB: 'subduction zone',
  OSR: 'spreading ridge',
  OTF: 'oceanic transform',
  OCB: 'oceanic convergent',
  CTF: 'continental transform',
  CRB: 'continental rift',
  CCB: 'continental convergent',
};

/**
 * A plate pair as a readable label: `PA\OK` becomes "Pacific–Okhotsk".
 *
 * The separator is **not** decoded. In PB2002 `/` and `\` mark which plate
 * subducts, but getting the polarity backwards would be a confident false
 * statement about the tectonics, and the `c` class already says whether it is a
 * subduction zone. The pair is rendered with an en-dash and left at that.
 */
export function plateBoundaryLabel(pair: string): string {
  const match = /^([A-Z]{2})[\\/-]([A-Z]{2})$/.exec(pair);
  if (!match) return pair;
  const [, left, right] = match;
  return `${PLATE_NAMES[left ?? ''] ?? left}–${PLATE_NAMES[right ?? ''] ?? right}`;
}

export function plateClassLabel(boundaryClass: string): string {
  return CLASS_NAMES[boundaryClass] ?? boundaryClass;
}

const KM_PER_DEGREE = 111.32;

function deltaLon(a: number, b: number): number {
  let delta = a - b;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

function segmentDistanceSqKm(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return ax * ax + ay * ay;
  let t = -(ax * dx + ay * dy) / lengthSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return cx * cx + cy * cy;
}

export interface PlateBoundaryMatch {
  segment: PlateBoundarySegment;
  distanceKm: number;
}

/**
 * The plate boundary segment nearest a point.
 *
 * Brute force over 7,507 vertices — a twentieth of the fault dataset, which
 * already runs at 1.1 ms, so this is well under a millisecond and needs no
 * index. Longitude differences are normalised so the Kuril, Aleutian and Tongan
 * arcs don't match a boundary on the far side of the planet.
 */
export function nearestPlateBoundary(
  point: { latitude: number; longitude: number },
  boundaries: readonly PlateBoundarySegment[] = PLATE_BOUNDARIES,
): PlateBoundaryMatch | null {
  const cosLat = Math.cos((point.latitude * Math.PI) / 180);

  let best: PlateBoundarySegment | null = null;
  let bestSq = Number.POSITIVE_INFINITY;

  for (const segment of boundaries) {
    const coords = segment.p;
    if (coords.length < 2) continue;

    let previousX = deltaLon(coords[0] as number, point.longitude) * KM_PER_DEGREE * cosLat;
    let previousY = ((coords[1] as number) - point.latitude) * KM_PER_DEGREE;

    if (coords.length === 2) {
      const sq = previousX * previousX + previousY * previousY;
      if (sq < bestSq) {
        bestSq = sq;
        best = segment;
      }
      continue;
    }

    for (let i = 2; i < coords.length; i += 2) {
      const x = deltaLon(coords[i] as number, point.longitude) * KM_PER_DEGREE * cosLat;
      const y = ((coords[i + 1] as number) - point.latitude) * KM_PER_DEGREE;
      const sq = segmentDistanceSqKm(previousX, previousY, x, y);
      if (sq < bestSq) {
        bestSq = sq;
        best = segment;
      }
      previousX = x;
      previousY = y;
    }
  }

  return best === null ? null : { segment: best, distanceKm: Math.sqrt(bestSq) };
}

export interface BoundaryShare {
  /** Raw plate pair, e.g. `PA\OK` — the stable identity. */
  pair: string;
  label: string;
  classLabel: string;
  count: number;
}

/**
 * Which plate boundaries a set of earthquakes sits on, most common first.
 *
 * Ties break on the pair code so the order is stable between renders — without
 * that, two boundaries with equal counts could swap places on every poll.
 */
export function boundaryBreakdown(
  events: readonly { latitude: number; longitude: number }[],
  boundaries: readonly PlateBoundarySegment[] = PLATE_BOUNDARIES,
): BoundaryShare[] {
  const counts = new Map<string, { segment: PlateBoundarySegment; count: number }>();

  for (const event of events) {
    const match = nearestPlateBoundary(event, boundaries);
    if (match === null) continue;
    const existing = counts.get(match.segment.b);
    if (existing) existing.count += 1;
    else counts.set(match.segment.b, { segment: match.segment, count: 1 });
  }

  return [...counts.entries()]
    .map(([pair, { segment, count }]) => ({
      pair,
      label: plateBoundaryLabel(pair),
      classLabel: plateClassLabel(segment.c),
      count,
    }))
    .sort((a, b) => b.count - a.count || a.pair.localeCompare(b.pair));
}
