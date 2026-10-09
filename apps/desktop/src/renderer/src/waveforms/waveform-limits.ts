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
 * A replay is a persuasive display — it shows a detector finding a quake — so
 * its limits have to be as visible as the detection. The detector shown is the
 * graded one; what is *not* the graded situation is the region, today's
 * network, the archive's packaging and a clean path.
 */
export const WAVEFORM_REPLAY_GUIDE: LayerGuide = {
  title: 'Quake replay',
  shows:
    'A past earthquake unfolding at the public stations nearest it. The app fetches what those stations recorded from the permanent archive, then plays it back with each record appearing at the moment it could have reached us live. Where there are enough stations close to the quake, the early-warning detector listens too — the same code the replay grading runs — and you can watch it count stations and declare. Any M5 or larger, anywhere, can be replayed.',
  reading: [
    'The rows are the ten nearest public stations that recorded anything, nearest first, each with its distance and direction from the epicentre — so the P wave visibly sweeps down the panel. The dashed line is when the quake began, by the USGS catalogue.',
    'The detector listens only to stations within 300 km of the epicentre. Amber ticks are where it triggered on a row; a row farther out is only watched, and the footer says how many are.',
    'It declares once four stations agree on one source. The line under the controls says when, how far from USGS it placed the quake, and the magnitude as it stood at that moment. The magnitude climbs as more of the P wave arrives — it starts low by design and is final about ten seconds later.',
    'If the detector could not have caught this quake at all, the line says so and why: too few stations nearby, or none close enough to locate from. That is the common case away from dense networks, and the rows are still there to watch.',
    'On the globe, the expanding rings are the P wave (fast, first) and the S wave (slower, the strong shaking), drawn from the catalogue epicentre with standard travel times (the IASP91 Earth model). The stations on the rows are marked, so you can watch a ring reach one as its row starts to move.',
    'The scrub bar marks the origin and the declaration. Real time is the default because the waiting is the point; 2×, 5× and 10× are for re-watching and for replays whose far stations stretch the window past ten minutes.',
  ],
  limits: [
    'The detector was tuned and graded in Southern California, on dense 100 Hz stations. Elsewhere the stations are fewer and often slower (20-50 Hz, whose records take longer to fill), and nothing here measures how well it does there. A replay in Japan or Alaska shows what it did, once — not how good it is.',
    'Most of the world\'s earthquakes have few public stations near them. Measured over every M5+ from 2024 to 2026, only about one in eight had four within 300 km, and half had none within 400 km. So most replays show the quake arriving at distant stations rather than a detection.',
    'It uses today\'s stations, not the network that existed then. Stations come and go, so an older quake was heard by fewer of them — the footer says how many had data.',
    'A very recent quake may not be in the archive yet. Data takes minutes to hours to arrive there; rows with nothing in them for a quake from the last few hours usually mean "not yet", not "no station".',
    'Timing is modelled, not recorded. The archive keeps every sample but not when it reached anyone, so each record is released at its last sample plus 2 seconds of transit, as measured live. A link outage or a station clock fault on the day would not show here.',
    'Some networks archive larger records than they send live; those are cut back to live size, which keeps the average delay right but not the exact moment each record would have arrived.',
    'The rings assume a shallow source and a layered, uniform Earth, so they are circles. Real wavefronts are shaped by the ground they cross, and a deep quake\'s waves reach the surface later and differently than drawn.',
    'The detector itself assumes one P-wave speed and a fixed 8 km depth, which is why it places quakes a few kilometres off.',
    'A replay is not evidence that live would do the same. It is one quake, replayed once, on a clean path.',
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
    '“Watch this spot” turns the picked spot into the live watch: up to 100 stations within 300 km of it are streamed, out of sight, through an earthquake detector for as long as the app is open, and you are alerted when a quake of M4.5 or more is predicted to be felt there. There is one watch at a time. It is separate from the rows above, so picking somewhere else afterwards leaves the watch where it is; the chip on the dock strip shows it and its × stops it. The button says when a spot cannot be watched — no public stations within reach.',
  ],
  limits: [
    'It is not real time, and cannot be. A station ships a record only once it is full, which takes about 2 to 7 seconds at 100 Hz and 5 to 25 seconds on the slower global stations, plus about 2 seconds in transit. The newest sample on screen is therefore seconds old — and a quiet station lags more than a busy one, because quiet ground compresses better and so takes longer to fill a record. Because the rows share one clock, the slowest station on screen sets how far behind live the whole view sits.',
    'The traces are not an earthquake warning. They show motion that has already happened, at stations that may be thousands of kilometres from you. Only the watch warns, and only for its one spot.',
    'Almost anything moving on a trace is not an earthquake. Ocean microseism is always present and is usually the largest thing on a quiet record; wind, traffic and the instrument itself account for most of the rest. Nothing runs a detector on these rows, deliberately — a single station cannot tell a quarry blast from an earthquake. The watch\'s detector needs four stations to agree before it declares anything.',
    'The watch\'s detector was graded in Southern California on 100 Hz stations: about 14 seconds after a quake starts, it is declared, which is no warning at all for shaking close by and tens of seconds for shaking far away. Elsewhere it runs on slower stations it was never graded on, and where the nearest station is more than 50 km from the spot it can catch only quakes near the stations. Treat it as a curiosity beside MyShake or your phone\'s emergency alerts, never as a replacement.',
    'The vertical axis has no units. These are raw instrument counts with no response removed, so amplitudes cannot be compared between rows: a sensitive broadband sensor and a short-period one differ by roughly fifty times for the same ground motion.',
    'Only vertical motion is shown. Horizontal shaking, which is what damages buildings, is not.',
    'Nothing is kept. Two minutes are held in memory from the first time you open this tab — they keep filling while it is minimised — and are discarded when you switch to Analyze or quit. There is no history to scroll back through.',
    'A blank row does not mean still ground — it means no packets arrived. The status beside each station separates never-connected from stopped-delivering, but nothing here can tell a dead station from a dead network path.',
    'These are whichever stations happen to be on three public servers, not a designed network: EarthScope\'s, about 3,200 stations and more than half of them in the contiguous United States; GeoNet New Zealand\'s, about 210 more; and GEOFON\'s, about 180 more across Europe, the eastern Mediterranean and northern Chile. Coverage is wildly uneven. Northern California publishes none here at all, Greece\'s and Turkey\'s national networks are not on an open server, and no open real-time source covers Indonesia or Japan\'s dense networks. So the nearest station to a pick is often far away — 74 km from Tokyo, over 2,000 km from the middle of the Pacific — and the distance on each row is the honest measure of how much it says about the spot you clicked. Replays use EarthScope\'s stations only, since its archive is the one they read.',
    'A picked set can mix instruments: 100 Hz broadband, slower 20-40 Hz broadband, and short-period sensors, chosen per station in that order of preference. A slow station on screen pushes the whole view further behind live, and a short-period trace looks different from a broadband one for reasons that have nothing to do with the ground.',
    'A station near an earthquake you chose Stations for shows what is arriving now, not what that earthquake did. By the time an event is catalogued, its waves have usually passed every nearby station, and nothing here goes back to fetch them.',
    'Timing is each station\'s own clock. A station with a bad clock draws its trace in the wrong place, and nothing here can detect that from a single channel.',
  ],
  source:
    'EarthScope/IRIS SeedLink (rtserve.iris.washington.edu), with station coordinates and names from the FDSN station service (service.earthscope.org). Data were accessed from the NSF NGF data archive operated by EarthScope Consortium. New Zealand stations (network NZ) stream from GeoNet\'s own server (link.geonet.org.nz), with metadata from service.geonet.org.nz, under CC BY 3.0 NZ: we acknowledge the New Zealand GeoNet programme and its sponsors NHC, Earth Sciences NZ, LINZ, NEMA and MBIE for providing data used here. Stations streamed from GEOFON (geofon.gfz.de), with metadata from IRIS\'s federated catalogue: seismic data were obtained from the GEOFON data centre of the GFZ Helmholtz Centre for Geosciences; GEOFON Data Centre (1993), GEOFON Seismic Network, doi:10.14470/TR560404. Each network — the code before each station name, such as CI (Caltech/USGS), UW (Pacific Northwest Seismic Network), NN (Nevada Seismic Network) or IU (Global Seismographic Network) — is separately operated, and declares its own licence and citation in its FDSN registration at fdsn.org/networks.',
};
