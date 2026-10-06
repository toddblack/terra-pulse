import { describe, expect, it } from 'vitest';
import { HOME_LOCATION, replayEligibility } from './quake-replay';

describe('replayEligibility', () => {
  it('offers M4.5+ within 250 km of home as a local replay', () => {
    const ridgecrest = { latitude: 35.77, longitude: -117.6, magnitude: 7.1 };
    expect(replayEligibility(ridgecrest)).toMatchObject({ eligible: true, kind: 'local' });
    // Lamont M5.2, 2024.
    expect(replayEligibility({ latitude: 35.12, longitude: -118.75, magnitude: 5.2 })).toMatchObject({ eligible: true, kind: 'local' });
  });

  it("holds back a local quake below M4.5 — the user's floor", () => {
    // Highland Park M4.4, which Burbank felt at 3.8. The floor is a preference,
    // not a claim it was unfelt.
    expect(replayEligibility({ latitude: 34.1, longitude: -118.18, magnitude: 4.4 }).eligible).toBe(false);
    expect(replayEligibility({ latitude: 34.1, longitude: -118.18, magnitude: 4.5 }).eligible).toBe(true);
  });

  it('offers only great quakes beyond 250 km, as "what your home network heard"', () => {
    const tohoku = { latitude: 38.3, longitude: 142.37, magnitude: 9.1 };
    expect(replayEligibility(tohoku)).toMatchObject({ eligible: true, kind: 'distant' });
    expect(replayEligibility({ ...tohoku, magnitude: 6.9 }).eligible).toBe(false);
    expect(replayEligibility({ ...tohoku, magnitude: 7 }).eligible).toBe(true);
  });

  it('switches at 250 km, not at a magnitude', () => {
    // An M6 just inside the radius is local; the same quake just outside is not
    // offered at all, because M6 is below the distant floor.
    const at = (km: number) => ({ latitude: HOME_LOCATION.latitude + km / 111.19, longitude: HOME_LOCATION.longitude, magnitude: 6 });
    expect(replayEligibility(at(249))).toMatchObject({ eligible: true, kind: 'local' });
    expect(replayEligibility(at(251)).eligible).toBe(false);
  });
});
