import type { LayerGuide } from '../panels/layer-guides';

/**
 * What this mode can and cannot tell you.
 *
 * Reuses `LayerGuide`'s four sections — what it shows, how to read it, what it
 * can't tell you, where it came from — because a mode owes a reader exactly
 * what a layer does. The third section is the reason the shape exists: a
 * scrolling seismogram is the most naturally over-read display in this app.
 * Almost everything moving on it is the ocean, and nothing on it is a warning.
 *
 * Every number here was measured against the live ring on 2026-09-10/11, not
 * quoted from documentation.
 */
/**
 * The id this guide is opened under, in the same namespace `LayerGuideModal`
 * resolves layer and track ids from. It cannot live in `LAYER_GUIDES`: that
 * registry is checked against the globe layer registry in both directions, so
 * an entry with no layer behind it would fail `layer-guides.test.ts`.
 */
export const WAVEFORM_GUIDE_ID = 'waveforms';

export function waveformGuideFor(id: string): LayerGuide | undefined {
  return id === WAVEFORM_GUIDE_ID ? WAVEFORM_GUIDE : undefined;
}

export const WAVEFORM_GUIDE: LayerGuide = {
  title: 'Live waveforms',
  shows:
    'Ground motion as it is recorded, streamed from public seismic stations. Each row is one station\'s vertical component over the last two minutes, scrolling right to left. This is the only part of the app showing the ground actually moving rather than marks for events already catalogued. Pick a preset region, or click anywhere on the globe — or on an earthquake — to stream up to ten stations surrounding that spot.',
  reading: [
    'The stations being streamed are marked on the globe as cyan triangles, labelled with the code each row carries. A picked spot is marked with a white bracket.',
    'A picked spot is surrounded rather than just neighboured: the nearest station in each of eight compass directions within 150 km, then the nearest of the rest. Each row says how far that station is from where you clicked and in which direction, nearest first. A wave arriving from a side with no station reaches every row late, so the note above the rows gives the widest direction left uncovered — on a coast that is usually the sea.',
    'No two picked stations are within 25 km of each other, so each row is a different place rather than one site counted twice. Clicking an earthquake centres the pick on its epicentre, not on the pixel you clicked.',
    'Each trace is the envelope of the recorded samples: the vertical extent of a column is the range the ground covered in that slice of time, so a brief sharp arrival stays visible rather than being skipped over.',
    'The centre line is that station\'s own average over the window, removed — a seismometer sits on an arbitrary offset of tens of thousands of counts, which would otherwise push every trace off its row.',
    'The vertical scale is per station and steps in a 1-2-5 sequence, so it changes visibly rather than drifting. The number beside each row is what full height currently means.',
    'A break in a trace is a break in the data. Nothing is drawn across it.',
    'All rows share one clock, so the same horizontal position is the same instant on every station — which is what lets you watch a wave arrive across a network. That shared edge sits a few seconds behind live, far enough back that every station has data there; the footer says how far, and the figure at each row\'s right is how old that station\'s own newest sample is.',
  ],
  limits: [
    'It is not real time, and cannot be. A station ships a record only once it is full, which takes about 2 to 7 seconds at 100 Hz and 5 to 25 seconds on the slower global stations, plus about 2 seconds in transit. The newest sample on screen is therefore seconds old — and a quiet station lags more than a busy one, because quiet ground compresses better and so takes longer to fill a record. Because the rows share one clock, the slowest station on screen sets how far behind live the whole view sits.',
    'This is not an earthquake warning and cannot become one. It reports motion that has already happened, at stations that may be thousands of kilometres from you. See the project notes on why early warning is out of scope.',
    'Almost anything moving on a trace is not an earthquake. Ocean microseism is always present and is usually the largest thing on a quiet record; wind, traffic and the instrument itself account for most of the rest. There is no detector here, deliberately — a single station cannot tell a quarry blast from an earthquake.',
    'The vertical axis has no units. These are raw instrument counts with no response removed, so amplitudes cannot be compared between rows: a sensitive broadband sensor and a short-period one differ by roughly fifty times for the same ground motion.',
    'Only vertical motion is shown. Horizontal shaking, which is what damages buildings, is not.',
    'Nothing is kept. Two minutes are held in memory while this mode is open, and discarded when you leave it. There is no history to scroll back through.',
    'A blank row does not mean still ground — it means no packets arrived. The status beside each station separates never-connected from stopped-delivering, but nothing here can tell a dead station from a dead network path.',
    'These are whichever stations happen to be on a public ring, not a designed network. Coverage is wildly uneven: about 3,200 stations, more than half of them in the contiguous United States, while Northern California publishes none here at all. So the nearest station to a pick is often far away — 74 km from Tokyo, over 2,000 km from the middle of the Pacific — and the distance on each row is the honest measure of how much it says about the spot you clicked.',
    'A picked set can mix instruments: 100 Hz broadband, slower 20-40 Hz broadband, and short-period sensors, chosen per station in that order of preference. A slow station on screen pushes the whole view further behind live, and a short-period trace looks different from a broadband one for reasons that have nothing to do with the ground.',
    'A station near an earthquake you clicked shows what is arriving now, not what that earthquake did. By the time an event is catalogued, its waves have usually passed every nearby station, and nothing here goes back to fetch them.',
    'Timing is each station\'s own clock. A station with a bad clock draws its trace in the wrong place, and nothing here can detect that from a single channel.',
  ],
  source:
    'EarthScope/IRIS SeedLink (rtserve.iris.washington.edu), with station coordinates and names from the FDSN station service (service.earthscope.org). Data were accessed from the NSF NGF data archive operated by EarthScope Consortium. Each network — the code before each station name, such as CI (Caltech/USGS), UW (Pacific Northwest Seismic Network), NN (Nevada Seismic Network) or IU (Global Seismographic Network) — is separately operated, and declares its own licence and citation in its FDSN registration at fdsn.org/networks.',
};
