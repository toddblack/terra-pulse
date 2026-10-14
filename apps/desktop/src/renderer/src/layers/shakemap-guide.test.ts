import { describe, expect, it } from 'vitest';
import { guideFor } from '../panels/layer-guides';
import { trackGuideFor } from '../panels/track-guides';
import { waveformGuideFor } from '../waveforms/waveform-limits';
import { SHAKEMAP_GUIDE, SHAKEMAP_GUIDE_ID, shakeMapGuideFor } from './shakemap-guide';

/**
 * "Every layer explains itself", for the one drawn thing that is not a layer.
 *
 * The layer and track guides are held to their registries by their own tests.
 * This has no registry behind it, so the test pins the two things that would
 * otherwise break silently: that the `?` resolves to something, and that the
 * explanation still says what the lines are not.
 */
describe('the shaking-lines guide', () => {
  it('resolves by its id and by nothing else', () => {
    expect(shakeMapGuideFor(SHAKEMAP_GUIDE_ID)).toBe(SHAKEMAP_GUIDE);
    expect(shakeMapGuideFor('tec')).toBeUndefined();
  });

  it('does not collide with a layer, a track row or the waveform guides', () => {
    // The modal tries each namespace in turn and takes the first that answers.
    expect(guideFor(SHAKEMAP_GUIDE_ID)).toBeUndefined();
    expect(trackGuideFor(SHAKEMAP_GUIDE_ID)).toBeUndefined();
    expect(waveformGuideFor(SHAKEMAP_GUIDE_ID)).toBeUndefined();
  });

  it('fills all four sections', () => {
    expect(SHAKEMAP_GUIDE.shows.length).toBeGreaterThan(0);
    expect(SHAKEMAP_GUIDE.reading.length).toBeGreaterThan(0);
    expect(SHAKEMAP_GUIDE.limits.length).toBeGreaterThan(0);
    expect(SHAKEMAP_GUIDE.source.length).toBeGreaterThan(0);
  });

  it('says the lines are an estimate, and that a missing map is not a quiet one', () => {
    const limits = SHAKEMAP_GUIDE.limits.join(' ');
    expect(limits).toMatch(/estimate/i);
    expect(limits).toMatch(/model/i);
    expect(limits).toMatch(/did not make one/i);
  });

  it('credits USGS, where the reader of a rendered map will see it', () => {
    expect(SHAKEMAP_GUIDE.source).toContain('USGS');
  });
});
