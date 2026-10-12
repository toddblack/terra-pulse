import { describe, expect, it } from 'vitest';
import { bearingDeg, haversineKm } from '@terra-pulse/schema';
import {
  ANTIPODE_FLY_MS,
  ANTIPODE_TURN_DEG,
  CHORD_DURATION_MS,
  RING_SPREAD_MS,
  antipodeMoment,
  antipodeViewpoint,
  chordExtentInRadii,
  frameGlobe,
  ringRadiusKm,
} from './antipode-sequence';

const KM_PER_DEGREE = (2 * Math.PI * 6371) / 360;

describe('antipodeViewpoint', () => {
  it('is the turn angle away from the event, whatever the latitude', () => {
    for (const latitude of [0, -18.5, 30, 40, 41, 60, -75]) {
      const event = { latitude, longitude: -100 };
      const view = antipodeViewpoint(event);
      expect(haversineKm(event, view) / KM_PER_DEGREE, String(latitude)).toBeCloseTo(ANTIPODE_TURN_DEG, 1);
    }
  });

  it('puts the event due west of the camera, so the chord is level with north up', () => {
    // The whole reason for the crest construction. Heading due east from the
    // event instead leaves it 13° off west for a quake at 18°S.
    for (const latitude of [0, -18.5, 30, 40, -40]) {
      const event = { latitude, longitude: -100 };
      expect(bearingDeg(antipodeViewpoint(event), event), String(latitude)).toBeCloseTo(270, 1);
    }
  });

  it('still finds a viewpoint where no level one exists', () => {
    // Above 40° the crest formula runs toward the pole and past it. These fall
    // back to heading east, and the camera rolls instead.
    for (const latitude of [41, 60, 89, -75]) {
      const view = antipodeViewpoint({ latitude, longitude: 10 });
      expect(Number.isFinite(view.latitude) && Number.isFinite(view.longitude), String(latitude)).toBe(true);
      expect(Math.abs(view.latitude)).toBeLessThanOrEqual(90);
    }
  });

  it('keeps the longitude in range across the date line', () => {
    const view = antipodeViewpoint({ latitude: -18.5, longitude: 175 });
    expect(view.longitude).toBeGreaterThanOrEqual(-180);
    expect(view.longitude).toBeLessThan(180);
  });
});

describe('chordExtentInRadii', () => {
  it('reaches further on the near side than the far side', () => {
    // The measured failure: framed as symmetric, the event's end touched the
    // inspector while the antipode's side stood empty.
    const extent = chordExtentInRadii(4.5, 0);
    expect(extent.left).toBeCloseTo(0.82, 2);
    expect(extent.right).toBeCloseTo(0.6, 2);
  });

  it('tends to sin(turn) on both sides from far away', () => {
    const extent = chordExtentInRadii(10_000, 0);
    expect(extent.left).toBeCloseTo(Math.SQRT1_2, 3);
    expect(extent.right).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('adds the widest ring to the far side only', () => {
    const bare = chordExtentInRadii(4.5, 0);
    const ringed = chordExtentInRadii(4.5, 1000);
    expect(ringed.left).toBe(bare.left);
    expect(ringed.right).toBeGreaterThan(bare.right);
  });
});

describe('frameGlobe', () => {
  const viewport = { width: 1584, height: 935 };
  const fov = Math.PI / 3;
  const focal = 792 / Math.tan(fov / 2);
  // The real window with the inspector open and the timeline showing.
  const clear = { left: 667, top: 60, right: 1331, bottom: 537 };

  /** Where the disc lands on screen, recovered from the framing. */
  function disc(framing: ReturnType<typeof frameGlobe>) {
    const x = viewport.width / 2 + framing.tanRight * focal;
    const y = viewport.height / 2 - framing.tanUp * focal;
    const reach = Math.hypot(focal, x - viewport.width / 2, viewport.height / 2 - y);
    const distanceInRadii = framing.heightM / 6_371_000 + 1;
    return { x, y, radius: reach * Math.tan(Math.asin(1 / distanceInRadii)), distanceInRadii };
  }

  it('keeps the whole chord and its rings inside the clear width', () => {
    const framed = disc(frameGlobe(viewport, clear, fov, 1000));
    const extent = chordExtentInRadii(framed.distanceInRadii, 1000);
    expect(framed.x - extent.left * framed.radius).toBeGreaterThan(clear.left);
    expect(framed.x + extent.right * framed.radius).toBeLessThan(clear.right);
  });

  it('centres the chord, not the disc, in the clear width', () => {
    const framed = disc(frameGlobe(viewport, clear, fov, 1000));
    const extent = chordExtentInRadii(framed.distanceInRadii, 1000);
    const leftSlack = framed.x - extent.left * framed.radius - clear.left;
    const rightSlack = clear.right - (framed.x + extent.right * framed.radius);
    expect(leftSlack).toBeCloseTo(rightSlack, 0);
  });

  it('keeps the top of the disc in view and lets its foot go under the dock', () => {
    const framed = disc(frameGlobe(viewport, clear, fov, 1000));
    expect(framed.y - framed.radius).toBeGreaterThanOrEqual(clear.top - 0.5);
    // The chord's band stays above the dock; the disc does not have to.
    expect(framed.y).toBeLessThan(clear.bottom);
    expect(framed.y + framed.radius).toBeGreaterThan(clear.bottom);
  });

  it('draws the globe larger when the dock is minimised', () => {
    const open = disc(frameGlobe(viewport, clear, fov, 1000));
    const minimised = disc(frameGlobe(viewport, { ...clear, bottom: 850 }, fov, 1000));
    expect(minimised.radius).toBeGreaterThan(open.radius);
  });

  it('falls back to the window when the clear area has collapsed', () => {
    const framing = frameGlobe(viewport, { left: 900, top: 100, right: 910, bottom: 500 }, fov, 1000);
    expect(Number.isFinite(framing.heightM)).toBe(true);
    expect(framing.heightM).toBeGreaterThan(1_000_000);
  });
});

describe('antipodeMoment', () => {
  it('waits for the camera before drawing anything', () => {
    expect(antipodeMoment(0, 1000)).toEqual({ phase: 'flying', chord: 0, ringFrontKm: null });
    expect(antipodeMoment(ANTIPODE_FLY_MS - 1, 1000).phase).toBe('flying');
  });

  it('draws the chord, then spreads the rings, in that order', () => {
    const drawing = antipodeMoment(ANTIPODE_FLY_MS + CHORD_DURATION_MS / 2, 1000);
    expect(drawing.phase).toBe('drawing');
    expect(drawing.chord).toBeGreaterThan(0);
    expect(drawing.chord).toBeLessThan(1);
    // Nothing at the far end before the line lands: it would give away the ending.
    expect(drawing.ringFrontKm).toBeNull();

    const spreading = antipodeMoment(ANTIPODE_FLY_MS + CHORD_DURATION_MS + RING_SPREAD_MS / 2, 1000);
    expect(spreading.phase).toBe('spreading');
    expect(spreading.chord).toBe(1);
    expect(spreading.ringFrontKm).toBeGreaterThan(0);
    expect(spreading.ringFrontKm).toBeLessThan(1000);
  });

  it('settles with the front at the widest ring, however long it is left', () => {
    // A paused tab hands back a very large elapsed time.
    expect(antipodeMoment(9_999_999, 1000)).toEqual({ phase: 'settled', chord: 1, ringFrontKm: 1000 });
  });

  it('starts at once when there is no camera move to wait for', () => {
    expect(antipodeMoment(1, 1000, 0).phase).toBe('drawing');
  });
});

describe('ringRadiusKm', () => {
  it('grows with the front, then stays at its own size', () => {
    expect(ringRadiusKm(500, null)).toBeNull();
    expect(ringRadiusKm(500, 0)).toBeNull();
    expect(ringRadiusKm(500, 120)).toBe(120);
    expect(ringRadiusKm(500, 800)).toBe(500);
  });
});
