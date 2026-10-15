import type { LayerGuide } from '../panels/layer-guides';

/**
 * The explanation behind the `?` in the GPS window.
 *
 * Its own id namespace, resolved by `LayerGuideModal` beside layers, tracks,
 * the waveform tab and the shaking lines, for the same reason as those last
 * two: `LAYER_GUIDES` is checked against the globe layer registry, and this
 * window is not a layer.
 *
 * The limits carry the weight. The window exists because of a question —
 * "does the ground move before big quakes?" — and a graph of the weeks before
 * one quake is the most natural thing in the app to over-read. A wiggle
 * before a quake is not a precursor until the same wiggle has been looked for
 * before every comparable quake, and after none of the quiet stretches.
 */
export const GNSS_GUIDE_ID = 'gnss-window';

export const GNSS_GUIDE: LayerGuide = {
  title: 'Ground position (GPS)',
  shows:
    'Where the ground was, one day at a time, at the GPS stations nearest the earthquake — from up to a year before it to a month after. Each station records its own position to within a few millimetres.',
  reading: [
    'Three rows per station: east, north and up. Each has its own scale; up is noisier than the other two, so its scale is wider.',
    'Zero is where the station was in the last week before the quake. A point above zero is east of, north of, or higher than that.',
    'The scale is fitted to the days before the quake, so the millimetres there can be seen. A large quake moves a nearby station much further than that, so the days after usually run off the edge: the arrow and the number beside it give the change across the quake — the median of the five days after against the five before.',
    '"Remove steady drift" takes off the station\'s normal motion — mostly its tectonic plate carrying it along, a few centimetres a year — using the velocity the lab publishes for that station over its whole record. What is left is departure from what the station usually does. Switch it off to see the raw positions.',
    'The dashed line is the quake. Its own day is drawn but belongs to neither side: a daily position averages the whole day, and the station moved partway through it.',
    'Dotted grey lines are changes the lab knows of that can make a station jump without the ground moving — a new antenna or receiver. Thin orange lines are other quakes the lab lists as close enough to have moved the station: a foreshock, an aftershock, a neighbour. Both are named in words under the graph. A jump just before the quake line is worth checking against them first; at Ridgecrest it is the M6.4 foreshock two days earlier.',
    'Days that run past the top or bottom of the scale are drawn as small arrowheads on that edge.',
    'A missing day is a gap in the line, never bridged.',
  ],
  limits: [
    'This shows what one station did around one quake. It cannot show whether the ground moves before big quakes in general: that needs the same look before every comparable quake and across quiet years with no quake at all, decided in advance — a registered test in Analyze, not a graph in Explore.',
    'Documented cases of slow movement before a large quake exist — weeks of slow slip before Iquique 2014, for one — but they are rare, mostly recognised afterwards, and most large quakes show nothing at all beforehand at the millimetre level these stations measure. A flat line before a quake is the usual answer, not a failure of the window.',
    'Distance matters more than anything else. The window looks out to the distance the lab itself uses for "this quake could have moved this station" — 162 km at M6, 512 km at M7 — but at the far end of that the movement is a millimetre or less, inside a station\'s own day-to-day scatter. Each station\'s distance is printed.',
    'Most large quakes are offshore, where there are no stations. About a third of M7+ since 2010 have one within 100 km. "No station near this quake" is the common answer.',
    'Removing the drift uses a single straight-line velocity. A station that was already speeding up or slowing down — after an earlier quake nearby, or from water being pumped out of the ground — will still show a slope with the drift removed.',
    'Seasonal swings of a few millimetres, mostly in up, come from water, snow and the atmosphere loading the ground, not from faults. On the one-year view they can look like a slow trend.',
    'The lab runs about two weeks behind, so a recent quake may not have its days after yet.',
  ],
  source:
    'Nevada Geodetic Laboratory, University of Nevada, Reno — daily IGS20 positions and MIDAS velocities. Supplied as-is. Cite Blewitt, G., W.C. Hammond and C. Kreemer (2018), Harnessing the GPS data explosion for interdisciplinary science, Eos 99, and the station\'s own data DOI shown in the window. Fetched from geodesy.unr.edu when the window opens and held in memory only; nothing is saved.',
};

export function gnssGuideFor(id: string): LayerGuide | undefined {
  return id === GNSS_GUIDE_ID ? GNSS_GUIDE : undefined;
}
