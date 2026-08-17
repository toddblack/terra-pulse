import { describe, expect, it } from 'vitest';
import {
  allLayerIds,
  GUIDES_STILL_NEEDED,
  guideFor,
  LAYER_GUIDES,
} from './layer-guides';

describe('layer guides', () => {
  it('accounts for every registered layer', () => {
    // The rule this enforces: **a new layer cannot ship unexplained.** Adding one
    // to the registry fails this test until someone either writes its guide or
    // deliberately puts it on the still-needed list. A convention in a document
    // gets forgotten; a red suite does not.
    const unaccounted = allLayerIds().filter(
      (id) => !guideFor(id) && !GUIDES_STILL_NEEDED.includes(id),
    );
    expect(unaccounted).toEqual([]);
  });

  it('does not list a layer as both written and outstanding', () => {
    // Otherwise the backlog stops meaning anything and never visibly shrinks.
    const both = Object.keys(LAYER_GUIDES).filter((id) => GUIDES_STILL_NEEDED.includes(id));
    expect(both).toEqual([]);
  });

  it('has no entry for a layer that no longer exists', () => {
    // A guide for a deleted layer is unreachable text that reads as current.
    const known = new Set(allLayerIds());
    expect(Object.keys(LAYER_GUIDES).filter((id) => !known.has(id))).toEqual([]);
    expect(GUIDES_STILL_NEEDED.filter((id) => !known.has(id))).toEqual([]);
  });

  it('fills every section of every guide it does have', () => {
    // A guide with an empty `limits` is worse than no guide: it implies someone
    // looked for caveats and found none.
    for (const [id, guide] of Object.entries(LAYER_GUIDES)) {
      expect(guide.title.length, `${id} title`).toBeGreaterThan(0);
      expect(guide.shows.length, `${id} shows`).toBeGreaterThan(40);
      expect(guide.reading.length, `${id} reading`).toBeGreaterThan(0);
      expect(guide.limits.length, `${id} limits`).toBeGreaterThan(0);
      expect(guide.source.length, `${id} source`).toBeGreaterThan(0);
    }
  });

  it('names a source for each, since attribution has to be reachable in the app', () => {
    // `SOURCES.md` records what is owed; this is one of the places it is paid.
    // A licence condition is not satisfied by a file in the repository that
    // nobody reading a rendered map ever opens.
    for (const [id, guide] of Object.entries(LAYER_GUIDES)) {
      expect(guide.source, `${id} source`).toMatch(/[A-Z]/);
    }
  });

  it('states the trap on the layers that have one', () => {
    // These three are the reason the feature exists at all, so the specific
    // misreadings are pinned rather than left to survive editing.
    expect(LAYER_GUIDES.tec?.limits.join(' ')).toMatch(/artefact|artifact/i);
    expect(LAYER_GUIDES.tec?.limits.join(' ')).toMatch(/68%/);
    // The field's caveat is that it cannot show a storm — the single most
    // common misreading in the app.
    expect(LAYER_GUIDES['geomagnetic-field']?.limits.join(' ')).toMatch(/storm/i);
    // And the magnetopause has to say it is a model.
    expect(LAYER_GUIDES.magnetopause?.limits.join(' ')).toMatch(/model/i);
  });
});
