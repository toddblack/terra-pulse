import { describe, expect, it } from 'vitest';
import { SHAKEMAP_MIN_MAGNITUDE, shakeMapEligible } from './shakemap';

describe('shakeMapEligible', () => {
  it('offers the lines from M5.5 up', () => {
    expect(shakeMapEligible({ magnitude: 5.5, source: 'usgs' })).toBe(true);
    expect(shakeMapEligible({ magnitude: 9.1, source: 'usgs' })).toBe(true);
    expect(shakeMapEligible({ magnitude: 5.4, source: 'usgs' })).toBe(false);
  });

  it('does not offer them for a quake USGS cannot look up', () => {
    // The lookup is by USGS event id; an EMSC-sourced event carries EMSC's.
    expect(shakeMapEligible({ magnitude: 6.8, source: 'emsc' })).toBe(false);
  });

  it('sits on the emphasis ring, so "a big one" is the same quakes in both places', () => {
    // Below this USGS has a map for about one quake in five, and below M5 for
    // one in fifty. Lowering it fills the inspector with a button that mostly
    // comes up empty — measure the coverage again before moving it.
    expect(SHAKEMAP_MIN_MAGNITUDE).toBe(5.5);
  });
});
