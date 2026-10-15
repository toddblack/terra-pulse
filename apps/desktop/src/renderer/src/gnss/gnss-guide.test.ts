import { describe, expect, it } from 'vitest';
import { guideFor } from '../panels/layer-guides';
import { trackGuideFor } from '../panels/track-guides';
import { waveformGuideFor } from '../waveforms/waveform-limits';
import { shakeMapGuideFor } from '../layers/shakemap-guide';
import { GNSS_GUIDE, GNSS_GUIDE_ID, gnssGuideFor } from './gnss-guide';

/**
 * "Every layer explains itself", for a window that is not a layer. Nothing
 * else holds this guide to existing, so this pins the `?` resolving and the
 * limits still saying what the graph cannot show.
 */
describe('the GPS window guide', () => {
  it('resolves by its id and by nothing else', () => {
    expect(gnssGuideFor(GNSS_GUIDE_ID)).toBe(GNSS_GUIDE);
    expect(gnssGuideFor('tec')).toBeUndefined();
  });

  it('does not collide with any other guide namespace', () => {
    expect(guideFor(GNSS_GUIDE_ID)).toBeUndefined();
    expect(trackGuideFor(GNSS_GUIDE_ID)).toBeUndefined();
    expect(waveformGuideFor(GNSS_GUIDE_ID)).toBeUndefined();
    expect(shakeMapGuideFor(GNSS_GUIDE_ID)).toBeUndefined();
  });

  it('fills all four sections', () => {
    expect(GNSS_GUIDE.shows.length).toBeGreaterThan(0);
    expect(GNSS_GUIDE.reading.length).toBeGreaterThan(0);
    expect(GNSS_GUIDE.limits.length).toBeGreaterThan(0);
    expect(GNSS_GUIDE.source.length).toBeGreaterThan(0);
  });

  it('says one quake cannot show a precursor, and where that question belongs', () => {
    const limits = GNSS_GUIDE.limits.join(' ');
    expect(limits).toMatch(/one station/i);
    expect(limits).toMatch(/Analyze/);
    expect(limits).toMatch(/usual answer/i);
  });

  it('carries the citation the lab asks for', () => {
    expect(GNSS_GUIDE.source).toContain('Blewitt');
    expect(GNSS_GUIDE.source).toMatch(/DOI/);
    expect(GNSS_GUIDE.source).toMatch(/nothing is saved/i);
  });
});
