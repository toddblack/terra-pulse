import { BASEMAP_REGISTRATIONS, OVERLAY_REGISTRATIONS } from '../layers/registry';

/**
 * What each layer shows, how to read it, and what it cannot tell you.
 *
 * ## Why this exists
 *
 * Nearly every layer in this app carries a caveat that **changes what a reader
 * is allowed to conclude** — the field cannot show a solar storm, the aurora
 * does not follow the scrubber, TEC's equatorial crests overlap most large
 * earthquakes for reasons that have nothing to do with earthquakes. Until this
 * module existed, all of that lived in code comments and `CLAUDE.md`, where no
 * user would ever meet it.
 *
 * The app has always been careful not to *draw* anything untrue. This is the
 * other half: saying out loud what a true drawing does and does not support.
 *
 * ## The shape is fixed on purpose
 *
 * Four sections, same order every time, so they can be skimmed and compared
 * rather than read. `limits` is the one that earns the feature — a reader who
 * only ever reads that section is still better off.
 *
 * ## Completeness is enforced by a test, not by discipline
 *
 * `layer-guides.test.ts` asserts that every registered layer either has a guide
 * or appears in `GUIDES_STILL_NEEDED`. Adding a layer therefore fails the suite
 * until someone makes a deliberate choice about it. The failure mode this
 * guards against is not writing a bad guide — it is shipping a layer with no
 * explanation at all, which is how the app got into this state to begin with.
 */
export interface LayerGuide {
  /** Heading for the dialog. Usually the layer's label without the suffix. */
  title: string;
  /** One sentence: what is on screen. */
  shows: string;
  /** How the encoding works — what colour, size and position mean. */
  reading: readonly string[];
  /**
   * What it cannot tell you.
   *
   * The section that matters. Where a layer invites a wrong conclusion, this is
   * where the app says so.
   */
  limits: readonly string[];
  /** Where the data comes from, and any attribution its licence requires. */
  source: string;
}

export const LAYER_GUIDES: Record<string, LayerGuide> = {
  tec: {
    title: 'Ionosphere',
    shows:
      'Total electron content — how many electrons sit in a column of atmosphere above each point, measured in TECU. This is the charged upper atmosphere, and the only layer here that covers the whole planet rather than just the polar regions.',
    reading: [
      'Brighter magenta means more electrons. The scale is fixed at 0–60 TECU so a colour means the same thing on every map, and it clamps rather than rescaling — a severe storm saturates the top of the ramp.',
      'The two bright bands either side of the magnetic equator are the equatorial ionization anomaly. Plasma is lifted along field lines at the equator and falls back on both sides, which is what builds the twin crests.',
      '"vs expected" switches to the anomaly: TEC minus its quiet-time expectation. Orange is more charge than normal, purple is less, and the neutral band means the ionosphere is doing what it usually does at that place and hour.',
      'Use "vs expected" for almost anything interesting. Raw total content is dominated by whether the Sun is up, so the plain view mostly draws the day/night terminator.',
    ],
    limits: [
      'It is live only. There is no stored history, so scrubbing the timeline will not show you the ionosphere of a past date — the map stays as it is and the legend says so.',
      'The crests sit where most large earthquakes sit, and that overlap is an artefact. 68% of M7+ events fall within 30° of magnetic latitude, which is also where the fountain effect puts the crests. The field’s geometry explains one, plate tectonics explains the other, and neither knows about the other. Any apparent match between high TEC and seismicity has to answer that before it means anything.',
      'The product carries a per-cell quality flag whose meaning is not documented in the data it ships with. This app passes it through without acting on it, so some cells may be more model-dependent than others with nothing on screen distinguishing them.',
      'A map is about half an hour behind real time in normal operation.',
    ],
    source: 'NOAA SWPC GloTEC. Public domain (US Government work).',
  },

  magnetopause: {
    title: 'Magnetopause',
    shows:
      'The outer boundary of the magnetosphere — where the solar wind’s pressure balances the pressure of Earth’s magnetic field. It sits around 10 Earth radii out, roughly 67,000 km, so enabling this layer flies the camera back far enough to see it.',
    reading: [
      'The wireframe teardrop is the boundary: compressed on the sunward side, opening out toward the night side. It is drawn as thin open lines rather than a solid surface deliberately — this is a calculated boundary, not an object with a skin.',
      'The dashed ring is geosynchronous orbit at 6.6 Earth radii. It is the reference that makes the number mean something.',
      'The boundary turns red when it has been pushed inside that ring — which means satellites at geosynchronous altitude are outside the magnetosphere, sitting in raw solar wind. Measured across this app’s own record, that happens in about 0.075% of hours.',
      'Nothing is drawn when the solar wind was not measured for that hour. The geosynchronous ring stays, which is how you can tell the boundary is the part that is missing.',
    ],
    limits: [
      'This is the only layer here that draws model output rather than a measurement. It is an empirical fit (Shue et al. 1998) evaluated on observed solar wind — the inputs are real, the surface is calculated.',
      'The fit was constrained over roughly 0.5–8.5 nPa of dynamic pressure and Bz from −18 to +15 nT. About 3.8% of stored hours fall outside that, and they are disproportionately the large storms — the exact hours you would zoom in on. Beyond the range it is extrapolating, and the legend says so when it is.',
      'Solar wind measurements are missing preferentially during the biggest events, because the spacecraft instrument saturates. The 2003 Halloween storm has no wind data at its peak, so the boundary simply cannot be drawn for the most extreme storm in the record.',
      'The magnetopause has no footprint on the ground. It tells you how hard the wind is pressing, not where anything lands.',
    ],
    source:
      'Shue et al. (1998), J. Geophys. Res. 103(A8), evaluated on NASA OMNI2 and NOAA SWPC solar wind.',
  },

  'geomagnetic-field': {
    title: 'Magnetic field (IGRF)',
    shows:
      'Earth’s main magnetic field — the one generated by the geodynamo in the core. Computed from the IGRF-14 model rather than fetched, so it works offline and covers 1900 to 2030.',
    reading: [
      'Strength uses a viridis ramp, dark for weak and bright for strong. The low patch over the South Atlantic is the South Atlantic Anomaly, a genuine weak spot in the field.',
      'Declination and dip are signed quantities, so they use a diverging ramp with a neutral middle. The neutral band is where the value is zero: for declination that is the agonic line, where a compass points true north; for dip it is the magnetic equator.',
      'It follows the timeline. Scrubbing across decades animates real secular variation — the north dip pole has moved out of Canada, over the pole, and is heading for Siberia.',
    ],
    limits: [
      'It cannot show a solar storm, and this is the most common misreading of the layer. A severe storm perturbs the field by a few hundred nT against a background of about 50,000 — well under 1%, invisible on this ramp. The Carrington event would be a rounding error here. If you want the Sun’s effect, use the aurora, magnetometers or ionosphere layers.',
      'The field moves over decades, not hours. Over the default 72-hour window it changes by about 1 nT, so scrubbing a short window will look like nothing is happening. That is correct physics, not a broken layer.',
      'Outside 1900–2030 the model clamps to the nearest end rather than extrapolating, because running secular variation forward produces confident nonsense.',
      'It is a model of the field, smooth by construction. It has no term for local crustal magnetism and will not show anomalies from geology beneath your feet.',
    ],
    source:
      'IGRF-14, IAGA Working Group V-MOD. Public domain.',
  },

  earthquakes: {
    title: 'Earthquakes',
    shows:
      'Every earthquake in the catalogue that passes the current magnitude floor and falls inside the visible time window. These marks are the app’s subject; most other layers exist to give them context.',
    reading: [
      'Colour is depth: shallow events are pale, deeper ones darker down the ramp. Grey means the catalogue reported no depth at all — that is a handful of pre-1980 events, and it is not the same as zero.',
      'Size is magnitude, and the steps are not linear because the energy is not: each whole step up is roughly thirty times the release.',
      'A ring marks M5.5 and above. It means the same thing in every view — that threshold does not move when you narrow the window.',
      'A red stroke means the event landed within 24 hours of the playhead, not within 24 hours of now.',
    ],
    limits: [
      'The catalogue is not evenly complete through time. Global completeness at M4.5 begins around 1970, and the recorded M4.5+ rate has risen roughly threefold since — that is seismometers being installed, not the Earth becoming more active. Comparisons across decades should use M5.5+, the only floor that has been flat over the record.',
      'Before 1970 only M7.5+ events are held, so playing the timeline across that boundary shows seismicity apparently exploding in 1970. The range controls warn when the window reaches back that far.',
      'A mark is an epicentre — a point above where rupture began. A great earthquake ruptures for hundreds of kilometres, so the dot is not the extent of anything.',
      'What you see is filtered by the magnitude floor and the window. An empty region may be quiet, or may simply be below the floor you have selected.',
    ],
    source: 'USGS FDSN (public domain), with EMSC as a gap-filler.',
  },

  'plate-boundaries': {
    title: 'Plate boundaries',
    shows:
      'The edges of Earth’s tectonic plates, from the PB2002 model. Most earthquakes happen on or near these lines, so they are the first context worth having behind the marks.',
    reading: [
      'Boundaries are grouped by what the plates are doing — pulling apart, sliding past, or converging — and cased so they stay legible over both light and dark basemaps.',
      'Clicking one names the plate pair and its type, and opens the location panel for that point.',
    ],
    limits: [
      'It never says which plate goes under at a subduction zone. The source encodes that, but stating it backwards would be a confident false claim about the tectonics, so labels stay as pairs: “Pacific–Okhotsk”, never “Pacific under Okhotsk”.',
      'A boundary drawn as a line is a simplification. Real deformation spreads across zones that can be hundreds of kilometres wide, which is why earthquakes routinely sit well off the line.',
      'It is a model published in 2002 — an interpretation rather than an observation, and different authors draw some boundaries differently.',
    ],
    source: 'Bird (2003) PB2002. ODC-BY 1.0 — attribution required.',
  },

  'subduction-zones': {
    title: 'Subduction zones',
    shows:
      'Where one plate is descending beneath another, drawn from the Slab2 model with sawteeth pointing down-dip — the direction the slab is going.',
    reading: [
      'The teeth sit on the overriding plate and point the way the slab dips, so you can read which side goes under without a label claiming it.',
      'These zones produce the largest earthquakes on Earth. Every M9 in the record happened on one.',
    ],
    limits: [
      'Slab2 covers the well-instrumented subduction zones, not every convergent margin in the world. A margin with no teeth may simply not be modelled.',
      'The line is only the surface expression. The slab continues hundreds of kilometres down and inland, which is why deep events plot far from the trench.',
      'Slab geometry at depth is inferred largely from where earthquakes have already occurred, so it is best constrained exactly where the seismicity is.',
    ],
    source: 'USGS Slab2 (Hayes et al. 2018). CC0 — public domain dedication.',
  },

  'active-faults': {
    title: 'Active faults',
    shows:
      'Mapped surface traces of faults considered active, from the GEM Global Active Faults database — 13,696 of them, revealed progressively as you zoom in.',
    reading: [
      'Hovering names the fault where a name exists, with its kinematics and slip rate. Clicking opens the location panel.',
      'The inspector reports the nearest mapped trace to a selected earthquake along with the distance, so you can judge the association yourself rather than being told there is one.',
    ],
    limits: [
      '“No useful association” is the normal case, not a failure. The median M6+ event is 42.9 km from any mapped trace, only 20% are within 10 km, and only 21% of nearest traces are even named. Deep events are further still — a median of 78.1 km — because subduction puts the surface trace far inboard of the rupture.',
      'A trace is where a fault meets the surface. Ruptures happen at depth on a plane that dips, so an epicentre is not expected to sit on the line.',
      'Slip rate is shown and recurrence is deliberately not derived from it. Turning millimetres per year into an interval between earthquakes needs an assumed slip per event — model output with assumptions attached, which does not belong beside an observation.',
      'Mapping coverage is uneven between countries. An area with no drawn faults may be unmapped rather than unfaulted.',
    ],
    source:
      'GEM Global Active Faults. CC-BY-SA 4.0 — attribution required, and derivatives of the dataset inherit share-alike.',
  },

  aurora: {
    title: 'Aurora',
    shows:
      'The auroral oval — where charged particles from the solar wind are precipitating into the upper atmosphere and making it glow, forecast for roughly the next hour.',
    reading: [
      'Green is literal rather than decorative: 557.7 nm emission from atomic oxygen is what gives the aurora its colour.',
      'Brighter means a higher chance of visible aurora. The scale tops out at 60% rather than 100%, so an ordinary night still uses most of the ramp and saturation means genuinely exceptional.',
      'Transparency carries meaning here, unlike the other rasters. About 70% of cells are a true zero on a quiet night — those are absences, and tinting them faintly would imply a phenomenon covering the planet.',
    ],
    limits: [
      'It is a forecast of a probability, not an observation of light. It says where aurora is likely, not where anyone saw it.',
      'It is live only and does not follow the scrubber. No archive of past grids exists to fetch, so scrubbing to a past date cannot show that night’s oval — the legend says so whenever the playhead is elsewhere.',
      'Nothing is drawn before the first successful fetch, or offline. A stale oval presented as current would be worse than an empty globe.',
      'The oval barely overlaps global seismicity, which matters if you are looking for a connection. Only 0.77% of M7+ earthquakes — eight in the whole record, nearly all near Macquarie Island — sit under the ordinary oval. Auroral precipitation is organised by the magnetic poles; earthquakes by plate boundaries, mostly near the equator.',
    ],
    source: 'NOAA SWPC OVATION Prime. Public domain (US Government work).',
  },

  magnetometers: {
    title: 'Magnetometers',
    shows:
      'Ground observatories, sized by how much Earth’s magnetic field has moved at each one over the last hour. This is disturbance rather than field strength — the part that responds to the Sun.',
    reading: [
      'The ring grows with the range of the horizontal field over the hour, in nanotesla: largest reading minus smallest. Quiet sites sit at a few nT; a storm drives hundreds.',
      'Red marks 50 nT or more. The radius is square-rooted rather than linear, because disturbance spans three orders of magnitude and a linear scale would leave every ordinary station an identical dot.',
      'A small hollow ring means the station reported nothing this hour — no reading, not quiet. Roughly 18 of 31 are dark at any given moment.',
    ],
    limits: [
      'The 50 nT threshold is for display only. The registered analysis trigger is the 99th percentile of each station’s own distribution, because an auroral-zone site and a mid-latitude one differ by an order of magnitude on an ordinary day. Comparing raw nanotesla between stations at different latitudes will mislead you.',
      'The live network is thin and heavily northern: about 31 stations, 28 of them in the United States and Canada. Only 7.5% of M7+ earthquakes have one within 500 km.',
      'That sparseness is the honest state of free real-time magnetometry rather than a gap in this app. The larger network — INTERMAGNET’s 138 stations — publishes only definitive data, roughly eighteen months behind, and is unavailable for anything live.',
      'It is live only, with no stored history, so it does not follow the scrubber.',
    ],
    source: 'USGS Geomagnetism Program. Public domain (US Government work).',
  },

  osm: {
    title: 'Basic basemap',
    shows:
      'Standard OpenStreetMap tiles — roads, borders and place names. The most legible backdrop when what you want is where on the ground something happened.',
    reading: [
      'This is the light-toned basemap, and marks drawn over it switch to the palette validated to stay legible against pale ground.',
    ],
    limits: [
      'It is a street map. It shows little about terrain and nothing at all about the seafloor, which is where a large share of earthquakes happen — use Relief or Seafloor for that.',
      'Tiles come from OpenStreetMap’s own servers under a usage policy, so this is not a basemap to hammer. The app identifies itself as that policy requires.',
    ],
    source:
      'Map data © OpenStreetMap contributors, ODbL. Tiles served under the OSMF Tile Usage Policy.',
  },

  relief: {
    title: 'Relief basemap',
    shows:
      'Shaded relief with bathymetry — land topography and seafloor shape in one image, which puts trenches, ridges and mountain belts behind the marks.',
    reading: [
      'A dark-toned basemap, so overlaid marks use the palette validated against dark ground.',
      'The ocean floor is shaded rather than flat blue, so subduction trenches read as the deep linear features they are.',
    ],
    limits: [
      'It is a static composite, not current satellite imagery. There is no cloud, no season, and no date attached to it.',
      'Relief shading exaggerates vertical scale to make terrain readable. Slopes are not to scale.',
      'The licence terms for this imagery have not been verified in this project — worth checking before publishing an exported image.',
    ],
    source: 'NASA GIBS, BlueMarble_ShadedRelief_Bathymetry.',
  },

  seafloor: {
    title: 'Seafloor basemap',
    shows:
      'GEBCO bathymetry — the shape of the ocean floor in more detail than the relief composite, which matters because most great earthquakes happen offshore.',
    reading: [
      'A dark-toned basemap. The depth ramp behind the marks is also blue, and the mark palette was measured against this imagery specifically so the two do not collapse into each other.',
    ],
    limits: [
      'It must not be used for navigation or safety at sea. That is GEBCO’s own condition on the data, not a caution invented here.',
      'Bathymetric coverage is very uneven. Much of the deep ocean is interpolated from sparse ship tracks and satellite gravity rather than measured directly, so a smooth area often means unsurveyed rather than flat.',
      'The licence terms have not been verified in this project — check before publishing an exported image.',
    ],
    source: 'GEBCO via the BODC WMS service.',
  },

  'solar-flares': {
    title: 'Solar flares',
    shows:
      'M-class and X-class solar flares, marked at the subsolar point — the spot on Earth with the Sun directly overhead — at the moment each flare peaked.',
    reading: [
      'The marker sits where the Sun is overhead at peak time, not where anything happened on Earth. A flare has no location on the ground; the subsolar point is a proxy for "the Sun, right now" that moves with the time window.',
      'Orange is M-class, the app’s red emphasis colour is X-class — the same red used for a recent large earthquake and a disturbed magnetometer, because X flares are this layer’s own severe tier.',
      'Larger markers are stronger within a class (an M8 draws bigger than an M1). The size difference between M and X is the bigger jump, matching how the classes themselves work: each letter is ten times the X-ray flux of the one before.',
    ],
    limits: [
      'A-, B- and C-class flares are not drawn at all. They occur several times a day and are not geoeffective, so including them would turn the globe into a dense scatter with no readable signal. This is the same M1.0-or-above floor H1b’s registered trigger uses.',
      'Two catalogues sit behind this, split at 2017: NOAA’s GOES XRS reports below, NASA’s DONKI above. Each year is drawn from one of them, never both, so a flare in their 2014–2016 overlap is shown once. The deeper half is a separate download — until it runs, nothing before 2010 appears and 2011–2013 is only about a quarter complete.',
      'The record starts in 1996 even though GOES reports reach 1975, because earlier fluxes need a scaling correction this app has not verified — so "M1.0" would not mean the same thing across the join. A quiet-looking early year may be an incompletely observed one, not a genuinely quiet Sun.',
      'This shows raw occurrence only. Whether flares are followed by elevated earthquake rates is H1b’s question, registered in HYPOTHESES.md and answered with a proper significance test, never by eyeballing this layer.',
    ],
    source:
      'NOAA NCEI/NGDC GOES XRS flare reports (1996–2016) and NASA DONKI /FLR (2017 onward). Both public domain (US Government work).',
  },

  'cme-arrivals': {
    title: 'CME arrivals',
    shows:
      'Modelled coronal mass ejection arrivals at Earth, marked at the subsolar point at the predicted arrival time.',
    reading: [
      'Bright cyan — the same colour the magnetopause and magnetometer layers use — marks a direct impact. Muted grey marks a glancing blow or a minor impact: a graze, not a hit.',
      'Larger markers had a higher predicted Kp, the model’s own headline geoeffectiveness estimate, on a fixed 0–9 scale. A marker with no size beyond the floor means the model run produced no Kp estimate at all, not that it predicted zero.',
      'Like the flare markers, position is the subsolar point at the time in question — an anchor for "where on Earth is facing the source", not a location where anything was observed.',
    ],
    limits: [
      'Every marker here is a model run (WSA-ENLIL), not an observation. Roughly three quarters of modelled CMEs are predicted to miss Earth entirely and never appear on this layer at all.',
      'This shows raw occurrence only, with no significance claim. H2b, registered in HYPOTHESES.md, is the actual test of whether the hemisphere facing a direct-impact arrival sees an elevated earthquake rate — that runs in Phase 4, not here.',
      'A glancing blow can still carry a predicted Kp of several — the direct/glancing distinction is about the geometry of the hit, not automatically about its strength.',
    ],
    source: 'NASA DONKI /WSAEnlilSimulations. Public domain (US Government work).',
  },
};

/**
 * Layers that do not have a guide yet.
 *
 * **Empty, and worth keeping that way.** It exists so that adding a layer forces
 * a decision rather than silently shipping an unexplained one: the test fails
 * until the layer is either written up or listed here. Putting something here is
 * a deliberate "not yet", not a way past the check.
 */
export const GUIDES_STILL_NEEDED: readonly string[] = [];

/** Every layer the registry knows about, basemaps included. */
export function allLayerIds(): string[] {
  return [
    ...BASEMAP_REGISTRATIONS.map((entry) => entry.id),
    ...OVERLAY_REGISTRATIONS.map((entry) => entry.id),
  ];
}

export function guideFor(layerId: string): LayerGuide | undefined {
  return LAYER_GUIDES[layerId];
}
