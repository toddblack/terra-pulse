import { describe, expect, it } from 'vitest';
import {
  TOOTH_PIXEL_HEIGHT,
  TOOTH_PIXEL_WIDTH,
  azimuthUnitVectorEnu,
  dipAzimuth,
  toothImageDataUri,
} from './subduction-encoding';
import trenchData from '../data/subduction-trenches.json';

interface Tooth {
  lon: number;
  lat: number;
  d: number;
}

/** Smallest absolute angle between two compass bearings, 0-180. */
function angularDifference(a: number, b: number): number {
  const raw = Math.abs((((a - b) % 360) + 360) % 360);
  return raw > 180 ? 360 - raw : raw;
}

describe('dipAzimuth', () => {
  it('turns strike 90 degrees clockwise', () => {
    expect(dipAzimuth(0)).toBe(90);
    expect(dipAzimuth(180)).toBe(270);
  });

  it('wraps past north', () => {
    expect(dipAzimuth(300)).toBe(30);
    expect(dipAzimuth(359)).toBe(89);
  });

  it('normalises negative and out-of-range input', () => {
    expect(dipAzimuth(-90)).toBe(0);
    expect(dipAzimuth(450)).toBe(180);
  });
});

/**
 * The correctness oracle for this whole layer.
 *
 * Every entry is a subduction zone whose polarity is textbook. If the vendor
 * script, the upstream column order, or the `strike + 90` convention ever
 * changes, these fail — and the opposed pairs below fail first.
 *
 * Two of them carry most of the weight:
 *
 *   Vanuatu dips EAST while Tonga, its neighbour, dips WEST.
 *   Manila dips EAST while the Philippine trench, alongside it, dips WEST.
 *
 * A method that merely assumed some fixed relationship to the trench line
 * would get one of each pair wrong. Getting both right is what distinguishes
 * real polarity from an artefact — and is exactly what the deleted
 * relative-motion arrows could not do.
 */
const KNOWN_POLARITY: ReadonlyArray<{
  name: string;
  lon: number;
  lat: number;
  expectedDip: number;
}> = [
  { name: 'Peru-Chile: Nazca dives east', lon: -71.0, lat: -22.0, expectedDip: 90 },
  { name: 'Japan trench: Pacific dives west', lon: 143.5, lat: 38.0, expectedDip: 270 },
  { name: 'Cascadia: Juan de Fuca dives east', lon: -125.5, lat: 45.0, expectedDip: 90 },
  { name: 'Tonga: Pacific dives west', lon: -173.5, lat: -20.0, expectedDip: 270 },
  { name: 'Vanuatu: dives EAST, opposite Tonga', lon: 166.0, lat: -16.0, expectedDip: 90 },
  { name: 'Sumatra: Indo-Australia dives north-east', lon: 100.0, lat: -3.0, expectedDip: 45 },
  { name: 'Aleutians: Pacific dives north', lon: -175.0, lat: 51.5, expectedDip: 0 },
  { name: 'Marianas: Pacific dives west', lon: 147.5, lat: 17.0, expectedDip: 270 },
  { name: 'Philippine trench: dives west', lon: 127.0, lat: 8.0, expectedDip: 270 },
  { name: 'Manila: dives EAST, opposite Philippine', lon: 119.5, lat: 18.0, expectedDip: 90 },
  { name: 'Ryukyu: Philippine Sea dives north-west', lon: 128.5, lat: 26.0, expectedDip: 315 },
  { name: 'Hellenic: Africa dives north', lon: 24.0, lat: 34.5, expectedDip: 0 },
  { name: 'Central America: Cocos dives north-east', lon: -92.0, lat: 14.0, expectedDip: 45 },
  { name: 'Kuril: Pacific dives north-west', lon: 153.0, lat: 45.0, expectedDip: 315 },
  { name: 'Puysegur: dives east-south-east', lon: 166.0, lat: -46.5, expectedDip: 110 },
];

/** Nearest shipped tooth to a point, tolerating the antimeridian. */
function nearestTooth(lon: number, lat: number): Tooth {
  let best: Tooth | null = null;
  let bestDistance = Infinity;

  for (const tooth of trenchData.k as Tooth[]) {
    let deltaLon = Math.abs(tooth.lon - lon);
    if (deltaLon > 180) deltaLon = 360 - deltaLon;
    const distance = Math.hypot(deltaLon, tooth.lat - lat);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = tooth;
    }
  }

  if (best === null) throw new Error('no teeth in dataset');
  return best;
}

describe('shipped teeth point down-dip at known subduction zones', () => {
  // 45 degrees: generous enough that picking the nearest tooth to a
  // hand-entered coordinate on a curved arc doesn't cause noise, tight enough
  // that a flipped convention (180 degrees off) can never pass.
  const TOLERANCE_DEGREES = 45;

  it.each(KNOWN_POLARITY)('$name', ({ lon, lat, expectedDip }) => {
    const tooth = nearestTooth(lon, lat);
    expect(angularDifference(tooth.d, expectedDip)).toBeLessThan(TOLERANCE_DEGREES);
  });

  it('places the opposed pairs on genuinely opposite sides', () => {
    // The sharpest statement of the whole finding: neighbouring arcs that dip
    // against each other must come out more than 90 degrees apart.
    const tonga = nearestTooth(-173.5, -20.0);
    const vanuatu = nearestTooth(166.0, -16.0);
    expect(angularDifference(tonga.d, vanuatu.d)).toBeGreaterThan(90);

    const philippine = nearestTooth(127.0, 8.0);
    const manila = nearestTooth(119.5, 18.0);
    expect(angularDifference(philippine.d, manila.d)).toBeGreaterThan(90);
  });
});

describe('vendored trench data', () => {
  it('ships trench runs and teeth', () => {
    expect(trenchData.t.length).toBeGreaterThan(0);
    expect(trenchData.k.length).toBeGreaterThan(0);
  });

  it('gives every run at least two points, as a polyline requires', () => {
    for (const run of trenchData.t) {
      expect(run.p.length).toBeGreaterThanOrEqual(4); // 2 points x lon,lat
      expect(run.p.length % 2).toBe(0);
    }
  });

  it('keeps every coordinate in valid geographic range', () => {
    for (const run of trenchData.t) {
      for (let i = 0; i < run.p.length; i += 2) {
        expect(Math.abs(run.p[i]!)).toBeLessThanOrEqual(180);
        expect(Math.abs(run.p[i + 1]!)).toBeLessThanOrEqual(90);
      }
    }
    for (const tooth of trenchData.k as Tooth[]) {
      expect(Math.abs(tooth.lon)).toBeLessThanOrEqual(180);
      expect(Math.abs(tooth.lat)).toBeLessThanOrEqual(90);
    }
  });

  it('keeps every dip azimuth on the compass', () => {
    for (const tooth of trenchData.k as Tooth[]) {
      expect(tooth.d).toBeGreaterThanOrEqual(0);
      expect(tooth.d).toBeLessThan(360);
    }
  });

  it('uses dip directions spread around the compass', () => {
    // Subduction zones face every direction. If the vendor script ever emitted
    // a constant — the failure mode of the deleted arrow layer, where the
    // value was fixed by digitisation order — this catches it.
    const quadrants = new Set((trenchData.k as Tooth[]).map((t) => Math.floor(t.d / 90)));
    expect(quadrants.size).toBe(4);
  });
});

describe('azimuthUnitVectorEnu', () => {
  it('points north for azimuth 0', () => {
    const v = azimuthUnitVectorEnu(0);
    expect(v.north).toBeCloseTo(1);
    expect(v.east).toBeCloseTo(0);
    expect(v.up).toBe(0);
  });

  it('points east for azimuth 90', () => {
    const v = azimuthUnitVectorEnu(90);
    expect(v.east).toBeCloseTo(1);
    expect(v.north).toBeCloseTo(0);
  });

  it('points south-west for azimuth 225', () => {
    const v = azimuthUnitVectorEnu(225);
    expect(v.east).toBeLessThan(0);
    expect(v.north).toBeLessThan(0);
  });

  it('always returns a unit vector', () => {
    for (const azimuth of [0, 37, 90, 180, 271, 359, -45, 450]) {
      const v = azimuthUnitVectorEnu(azimuth);
      expect(Math.hypot(v.east, v.north, v.up)).toBeCloseTo(1);
    }
  });
});

describe('toothImageDataUri', () => {
  it('produces an inline SVG data URI', () => {
    expect(toothImageDataUri('#eb6834', '#0b0b0b')).toMatch(/^data:image\/svg\+xml,/);
  });

  it('carries the requested colour through', () => {
    expect(decodeURIComponent(toothImageDataUri('#eb6834', '#0b0b0b'))).toContain('#eb6834');
  });

  it('draws a casing so the tooth stays visible over blue water', () => {
    // Convergent orange alone measures 1.49:1 against GEBCO's seafloor. The
    // stroke is what gives the tooth an edge independent of the backdrop.
    const svg = decodeURIComponent(toothImageDataUri('#eb6834', '#0b0b0b'));
    expect(svg).toContain('stroke="#0b0b0b"');
    expect(svg).toMatch(/stroke-width="[1-9]/);
  });

  it('puts the triangle in the upper half so its base lands on the trench', () => {
    // The billboard is centred on a trench point, so the image centre (10, 20)
    // must be the middle of the tooth's base, not the middle of the triangle.
    // Geometry is inset by half the stroke width to keep the casing in frame.
    const svg = decodeURIComponent(toothImageDataUri('#eb6834', '#0b0b0b'));
    expect(svg).toContain('viewBox="0 0 20 40"');
    expect(svg).toContain('M10 1 L19 20 L1 20 Z');
  });

  it('needs no DOM, so it works under the node test environment', () => {
    expect(typeof toothImageDataUri('#000000', '#ffffff')).toBe('string');
  });
});

describe('tooth sizing', () => {
  it('is taller than it is wide, so direction reads at a glance', () => {
    expect(TOOTH_PIXEL_HEIGHT).toBeGreaterThan(TOOTH_PIXEL_WIDTH);
  });

  it('stays in the same size range as the earthquake marks', () => {
    expect(TOOTH_PIXEL_WIDTH).toBeGreaterThanOrEqual(4);
    expect(TOOTH_PIXEL_HEIGHT).toBeLessThanOrEqual(24);
  });
});
