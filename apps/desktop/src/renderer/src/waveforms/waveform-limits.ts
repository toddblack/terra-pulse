import type { LayerGuide } from '../panels/layer-guides';

/**
 * What the dock's waveform tab can and cannot tell you.
 *
 * Reuses `LayerGuide`'s four sections — what it shows, how to read it, what it
 * can't tell you, where it came from — because a panel this easy to over-read
 * owes a reader exactly what a layer does. The third section is the reason the shape exists: a
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
/** The quake replay's guide, in the same namespace. */
export const WAVEFORM_REPLAY_GUIDE_ID = 'waveform-replay';

export function waveformGuideFor(id: string): LayerGuide | undefined {
  if (id === WAVEFORM_GUIDE_ID) return WAVEFORM_GUIDE;
  if (id === WAVEFORM_REPLAY_GUIDE_ID) return WAVEFORM_REPLAY_GUIDE;
  return undefined;
}

/**
 * A replay is the most persuasive display in the app — it shows a warning
 * arriving before the shaking — so its limits have to be as visible as the
 * warning. The detector shown is the graded one; what is *not* the graded
 * situation is today's network, the archive's packaging and a clean path.
 */
export const WAVEFORM_REPLAY_GUIDE: LayerGuide = {
  title: 'Quake replay',
  shows:
    'What the early-warning detector would have done, had it been running when this quake happened. The app fetches what the stations around home recorded from the permanent archive, then plays it back with each record appearing at the moment it could have reached us live. The detector, its magnitude estimate and the alert are the same code the replay grading runs.',
  reading: [
    'The rows are the first stations to trigger, in the order they did, so the P wave visibly sweeps down the panel. Amber ticks are where each station triggered; the dashed line is when the quake began, by the USGS catalogue.',
    'The detector declares once four stations agree on one source. The line under the controls says when, how far from USGS it placed the quake, and the magnitude as it stood at that moment. The magnitude climbs as more of the P wave arrives — it starts low by design and is final about ten seconds later.',
    'The alert is decided on predicted shaking at home (MMI 2.5 or more, roughly "felt indoors"), not on magnitude. When playback reaches the moment it would have fired, the banner and the alert sound play, and the banner counts down to the strong (S-wave) shaking reaching home.',
    'On the globe, the expanding rings are the P wave (fast, first) and the S wave (slower, the strong shaking), drawn from the catalogue epicentre at the speeds the detector assumes. Home is marked. The gap between the alert and the S ring reaching home is the warning time.',
    'The scrub bar marks the origin, the declaration, the alert, and the P and S waves reaching home. Real time is the default because the waiting is the point; 2× and 5× are for re-watching.',
  ],
  limits: [
    'It runs today\'s stations, not the network that existed then. Stations come and go, so an older quake was heard by fewer of them — the footer says how many had data — and a 2005 replay can look worse than the detector would do now, or better than it did then.',
    'Timing is modelled, not recorded. The archive keeps every sample but not when it reached anyone, so each record is released at its last sample plus 2 seconds of transit, as measured live. A ring outage, a slow link or a station clock fault on the day would not show here.',
    'Some networks archive larger records than they send live; those are cut back to live size, which keeps the average delay right but not the exact moment each record would have arrived.',
    'The detector assumes one P-wave speed and a fixed 8 km depth. That is why it places quakes a few kilometres off, and why the rings are circles — real wavefronts are shaped by the ground they cross.',
    'The predicted shaking at home is an average relation for California, checked against what people in Burbank reported (USGS "Did You Feel It?") but carrying real scatter. Basin and site effects can make the same quake feel quite different a few streets apart.',
    'For a quake within a few tens of kilometres of home, strong shaking can arrive before any alert — the waves are already there while the fourth station is still waiting. In the graded replays the basin quakes (Highland Park, El Monte) alerted one to two seconds after the shaking. A replay shows that honestly; it is physics, not a fault.',
    'A replay is not evidence that live would do the same. It is one quake, replayed once, on a clean path. The detector was graded on dozens of quakes it had not been tuned on; that grading is the measure, and a single replay is an illustration of it.',
    'A distant replay shows what the home network heard. The rings are not drawn for it — crustal wave speeds mean nothing across the mantle — and the expected answer is that the detector stays quiet.',
  ],
  source:
    'Archived waveforms from the EarthScope FDSN dataselect service (service.earthscope.org), station calibrations from its station service, and quake locations from the USGS catalogue. Data were accessed from the NSF NGF data archive operated by EarthScope Consortium. Each network, such as CI (Caltech/USGS), declares its own licence and citation at fdsn.org/networks.',
};

export const WAVEFORM_GUIDE: LayerGuide = {
  title: 'Live waveforms',
  shows:
    'Ground motion as it is recorded, streamed from public seismic stations. Each row is one station\'s vertical component over the last two minutes, scrolling right to left. This is the only part of the app showing the ground actually moving rather than marks for events already catalogued. Pick a preset region, click bare globe while this tab is showing, or open an earthquake and choose Stations, to stream up to ten stations surrounding that spot. Once started, the stream keeps running while the panel is minimised or the timeline is showing.',
  reading: [
    'The stations being streamed are marked on the globe as cyan triangles, labelled with the code each row carries, while this tab is showing. A picked spot is marked with a white bracket.',
    'Clicking an earthquake opens it in the inspector as usual — it does not move the stations. A click on bare globe picks a new spot, and so does a click on a fault or plate boundary, which also opens its panel. If the panel is minimised, a pick reopens it. While the fault probe is on, clicks belong to the probe instead.',
    'A picked spot is surrounded rather than just neighboured: the nearest station in each of eight compass directions within 150 km, then the nearest of the rest. Each row says how far that station is from where you clicked and in which direction, nearest first. A wave arriving from a side with no station reaches every row late, so the note above the rows gives the widest direction left uncovered — on a coast that is usually the sea.',
    'No two picked stations are within 25 km of each other, so each row is a different place rather than one site counted twice. Choosing Stations on an earthquake centres the pick on its epicentre.',
    'Each trace is the envelope of the recorded samples: the vertical extent of a column is the range the ground covered in that slice of time, so a brief sharp arrival stays visible rather than being skipped over.',
    'The centre line is that station\'s own average over the window, removed — a seismometer sits on an arbitrary offset of tens of thousands of counts, which would otherwise push every trace off its row.',
    'The vertical scale is per station and steps in a 1-2-5 sequence, so it changes visibly rather than drifting. The number beside each row is what full height currently means.',
    'A break in a trace is a break in the data. Nothing is drawn across it.',
    'All rows share one clock, so the same horizontal position is the same instant on every station — which is what lets you watch a wave arrive across a network. That shared edge sits a few seconds behind live, far enough back that every station has data there; the footer says how far, and the figure at each row\'s right is how old that station\'s own newest sample is.',
  ],
  limits: [
    'It is not real time, and cannot be. A station ships a record only once it is full, which takes about 2 to 7 seconds at 100 Hz and 5 to 25 seconds on the slower global stations, plus about 2 seconds in transit. The newest sample on screen is therefore seconds old — and a quiet station lags more than a busy one, because quiet ground compresses better and so takes longer to fill a record. Because the rows share one clock, the slowest station on screen sets how far behind live the whole view sits.',
    'This is not an earthquake warning. It reports motion that has already happened, at stations that may be thousands of kilometres from you.',
    'Almost anything moving on a trace is not an earthquake. Ocean microseism is always present and is usually the largest thing on a quiet record; wind, traffic and the instrument itself account for most of the rest. There is no detector here, deliberately — a single station cannot tell a quarry blast from an earthquake.',
    'The vertical axis has no units. These are raw instrument counts with no response removed, so amplitudes cannot be compared between rows: a sensitive broadband sensor and a short-period one differ by roughly fifty times for the same ground motion.',
    'Only vertical motion is shown. Horizontal shaking, which is what damages buildings, is not.',
    'Nothing is kept. Two minutes are held in memory from the first time you open this tab — they keep filling while it is minimised — and are discarded when you switch to Analyze or quit. There is no history to scroll back through.',
    'A blank row does not mean still ground — it means no packets arrived. The status beside each station separates never-connected from stopped-delivering, but nothing here can tell a dead station from a dead network path.',
    'These are whichever stations happen to be on a public ring, not a designed network. Coverage is wildly uneven: about 3,200 stations, more than half of them in the contiguous United States, while Northern California publishes none here at all. So the nearest station to a pick is often far away — 74 km from Tokyo, over 2,000 km from the middle of the Pacific — and the distance on each row is the honest measure of how much it says about the spot you clicked.',
    'A picked set can mix instruments: 100 Hz broadband, slower 20-40 Hz broadband, and short-period sensors, chosen per station in that order of preference. A slow station on screen pushes the whole view further behind live, and a short-period trace looks different from a broadband one for reasons that have nothing to do with the ground.',
    'A station near an earthquake you chose Stations for shows what is arriving now, not what that earthquake did. By the time an event is catalogued, its waves have usually passed every nearby station, and nothing here goes back to fetch them.',
    'Timing is each station\'s own clock. A station with a bad clock draws its trace in the wrong place, and nothing here can detect that from a single channel.',
  ],
  source:
    'EarthScope/IRIS SeedLink (rtserve.iris.washington.edu), with station coordinates and names from the FDSN station service (service.earthscope.org). Data were accessed from the NSF NGF data archive operated by EarthScope Consortium. Each network — the code before each station name, such as CI (Caltech/USGS), UW (Pacific Northwest Seismic Network), NN (Nevada Seismic Network) or IU (Global Seismographic Network) — is separately operated, and declares its own licence and citation in its FDSN registration at fdsn.org/networks.',
};
