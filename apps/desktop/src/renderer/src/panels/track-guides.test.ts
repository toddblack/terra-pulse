import { describe, expect, it } from 'vitest';
import { TRACK_GUIDES, trackGuideFor } from './track-guides';

const TRACK_ROW_IDS = ['track-geomagnetic', 'track-solar-wind', 'track-xray-flux', 'track-earthquakes'];

describe('track guides', () => {
  it('covers every row on the multi-track timeline', () => {
    // Same discipline layer-guides.test.ts enforces via the registry — here
    // there is no registry to check against, so the row ids are just listed,
    // but the failure mode is identical: a row shipped with no explanation.
    for (const id of TRACK_ROW_IDS) {
      expect(trackGuideFor(id), id).toBeDefined();
    }
  });

  it('fills every section of every guide', () => {
    // A guide with an empty `limits` is worse than no guide: it implies
    // someone looked for caveats and found none.
    for (const [id, guide] of Object.entries(TRACK_GUIDES)) {
      expect(guide.title.length, `${id} title`).toBeGreaterThan(0);
      expect(guide.shows.length, `${id} shows`).toBeGreaterThan(40);
      expect(guide.reading.length, `${id} reading`).toBeGreaterThan(0);
      expect(guide.limits.length, `${id} limits`).toBeGreaterThan(0);
      expect(guide.source.length, `${id} source`).toBeGreaterThan(0);
    }
  });

  it('names a source for each', () => {
    for (const [id, guide] of Object.entries(TRACK_GUIDES)) {
      expect(guide.source, `${id} source`).toMatch(/[A-Z]/);
    }
  });

  it('states the trap that prompted this guide in the first place', () => {
    // Found in the field: a reading stepping from C1.0 to B8.3 read as a
    // jump to someone who didn't know the letters were decades that reset
    // their number at each boundary. Pinned so the specific misreading
    // survives editing, the same way tec/geomagnetic-field/magnetopause's
    // traps are pinned in layer-guides.test.ts.
    const flux = TRACK_GUIDES['track-xray-flux']?.reading.join(' ') ?? '';
    expect(flux).toMatch(/decade/i);
    expect(flux).toMatch(/B8\.3/);
    expect(flux).toMatch(/C1\.0/);
  });

  it('says the flux row has no historical archive, unlike the other three', () => {
    expect(TRACK_GUIDES['track-xray-flux']?.limits.join(' ')).toMatch(/live only/i);
  });

  it('says a marker is the slice’s largest event, not a complete count', () => {
    expect(TRACK_GUIDES['track-earthquakes']?.limits.join(' ')).toMatch(/not a complete count/i);
  });

  it('states plainly that a lined-up spike is not evidence — Explore mode, non-negotiable #1', () => {
    expect(TRACK_GUIDES['track-earthquakes']?.limits.join(' ')).toMatch(/no significance claim/i);
  });
});
