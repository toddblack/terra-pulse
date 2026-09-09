import { describe, expect, it } from 'vitest';
import { TRACK_GUIDES, trackGuideFor } from './track-guides';
import { TRACK_ROWS, trackGuideIdFor } from './track-rows';

const TRACK_ROW_IDS = TRACK_ROWS.map((row) => trackGuideIdFor(row.id));

describe('track guides', () => {
  it('covers every row on the multi-track timeline', () => {
    // Read from the row registry, exactly as layer-guides.test.ts reads the
    // layer registry. This list used to be hardcoded here, which meant adding
    // a row could not fail this test — the check passed while describing a
    // timeline that no longer existed.
    for (const id of TRACK_ROW_IDS) {
      expect(trackGuideFor(id), id).toBeDefined();
    }
  });

  it('has no guide for a row that is not registered', () => {
    // The other half of the same discipline: a guide left behind for a row
    // someone deleted.
    for (const id of Object.keys(TRACK_GUIDES)) {
      expect(TRACK_ROW_IDS, id).toContain(id);
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

  it('says the tidal row’s sign is unresolved while its shape is not', () => {
    // The one claim that stops this row being read as "the tide is currently
    // encouraging slip here" — a statement it cannot make, because strike
    // comes from a trace's arbitrary digitisation order. See
    // tidal-stress-track.ts and TidalShear.tsx, which both carry the long form.
    const limits = TRACK_GUIDES['track-tidal-stress']?.limits.join(' ') ?? '';
    expect(limits).toMatch(/sign is not resolved/i);
    expect(limits).toMatch(/shape/i);
  });

  it('keeps the tidal row apart from H6, and reports H6’s actual result', () => {
    // The row draws the same physics a registered hypothesis test uses, which
    // is exactly the situation non-negotiable #1 exists for. Naming the null
    // rather than staying silent is the honest version — H6 ran and found
    // nothing, and a reader watching a quake land on a tidal peak deserves
    // that fact in the same place.
    const limits = TRACK_GUIDES['track-tidal-stress']?.limits.join(' ') ?? '';
    expect(limits).toMatch(/not H6/i);
    expect(limits).toMatch(/clean null/i);
  });

  it('says the tidal row needs a dip and rake most faults do not have', () => {
    expect(TRACK_GUIDES['track-tidal-stress']?.limits.join(' ')).toMatch(/21\.7%/);
  });
});
