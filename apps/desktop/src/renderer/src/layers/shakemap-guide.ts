import type { LayerGuide } from '../panels/layer-guides';

/**
 * The explanation behind the `?` beside the shaking lines.
 *
 * Its own id namespace, resolved by `LayerGuideModal` beside layers, tracks
 * and the waveform tab — and for the waveform guide's reason: `LAYER_GUIDES`
 * is checked against the globe layer registry in both directions, and these
 * lines are not a registry layer.
 *
 * The limits section carries the weight here. A set of crisp nested lines
 * around an epicentre looks like something that was measured, and for a great
 * many earthquakes most of it was not.
 */
export const SHAKEMAP_GUIDE_ID = 'shaking-lines';

export const SHAKEMAP_GUIDE: LayerGuide = {
  title: 'Shaking intensity',
  shows:
    'How strongly the ground shook around the selected earthquake, as lines of equal intensity — isoseismals — from the USGS ShakeMap for that event.',
  reading: [
    'Each line is the edge of an intensity zone on the Modified Mercalli scale, and carries its Roman numeral. Everything inside the line marked V shook at intensity V or more.',
    'Intensity describes what the shaking did at a place — III is felt indoors, V wakes people and moves small objects, VII damages ordinary buildings, IX destroys them. It is not magnitude. A quake has one magnitude and a different intensity everywhere.',
    'The colours are the ShakeMap scale: pale blue and cyan for weak and light shaking, green and yellow for moderate and strong, orange and red for severe and violent.',
    'The lines are rarely circles. They stretch along the fault that broke, and bulge over soft ground such as river basins, which shakes harder than rock at the same distance.',
    '"Peak" under the button is the strongest value anywhere on the map. It sits inside the innermost line, so it can be one class above the highest numeral drawn.',
  ],
  limits: [
    'These are an estimate, not a survey. A ShakeMap is interpolated from seismometer readings and "Did You Feel It?" reports where they exist, with a ground-motion model filling everything between and beyond them.',
    'For an old or remote earthquake the model is doing nearly all the work. Valdivia 1960 has a ShakeMap; no instrument that could feed one was anywhere near it. Lines that look just as crisp can rest on thousands of readings or on almost none, and nothing on the globe tells the two apart.',
    'Not every quake has one. Nearly all M5.5+ since 2013 do; before that about a third, weighted toward the large and the damaging. A missing map means USGS did not make one, not that nothing was felt.',
    'Recent maps change. A large earthquake is revised many times in its first days as readings arrive, so the lines for a quake from this week may move.',
    'The weakest edge drawn is III. Fainter shaking reaches further than any line here.',
    'Small specks are left out. Where a few cells of the map cross a threshold on their own the contour is a tiny island; those are dropped so the main outlines can be read.',
    'A line says nothing about damage at a particular building, and nothing about what a future earthquake would do here.',
  ],
  source:
    'USGS Earthquake Hazards Program — ShakeMap, and the ShakeMap Atlas for past events. US Government work, public domain. Fetched from earthquake.usgs.gov when the lines are switched on; not stored.',
};

export function shakeMapGuideFor(id: string): LayerGuide | undefined {
  return id === SHAKEMAP_GUIDE_ID ? SHAKEMAP_GUIDE : undefined;
}
