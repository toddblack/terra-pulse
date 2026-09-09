import type { LayerGuide } from './layer-guides';

/**
 * The same explanation system `layer-guides.ts` built, for the rows of the
 * multi-track timeline (§5.5) instead of the globe layer registry.
 *
 * ## Why this is a separate file rather than more entries in `LAYER_GUIDES`
 *
 * `layer-guides.test.ts` asserts that every key in `LAYER_GUIDES` names a
 * real, currently-registered layer — the check that catches a guide left
 * behind for a deleted layer. A track row is not a registry entry: it has no
 * `GlobeLayer`, nothing to mount and nothing to destroy. Adding its id there
 * would fail that assertion the moment someone re-reads it carefully, and
 * widening the check to tolerate track ids would blur the one thing it
 * currently guarantees: *every key here is real*. Two small files, each
 * meaning exactly what it says, beats one file with a footnote.
 *
 * The rows now have a registry of their own (`track-rows.ts`), so
 * `track-guides.test.ts` checks against that rather than a hardcoded list —
 * the same forcing function, on both sides.
 *
 * `LayerGuideModal.tsx` and `LayerGuideButton` still do the actual
 * rendering — they look here whenever a layer guide doesn't match, so this
 * gets the whole modal, its keyboard/backdrop handling and its styling for
 * free rather than duplicating any of it.
 */
export const TRACK_GUIDES: Record<string, LayerGuide> = {
  'track-geomagnetic': {
    title: 'Geomagnetic activity (Kp / Dst)',
    shows:
      'How disturbed Earth’s magnetic field is, two ways: Kp, the global planetary index (0–9), and Dst, the ring-current strength in nT. This is the ground-truth half of space weather — the measured effect, not its solar cause.',
    reading: [
      'The bar is the interval’s typical (median) Kp; the thin cap above it, when there is one, is the interval’s single worst hour. The gap between them is how variable the interval was — a bar and cap that coincide means one hour, or an interval that never moved.',
      'The dashed line marks Kp 5 (NOAA’s G1 storm threshold) — display emphasis only, not a claim. Bars and caps that reach or cross it turn the app’s red.',
      'Dst rides the same bar as a number in the readout rather than its own bar, because a single extreme Dst hour (the March 1989 storm reached −589 nT) would flatten every other bar in the row if it sized anything.',
      'Hover or use the arrow keys to read out an exact interval; the same instant is read across every row at once, so lining a spike up with the row below or above answers "did the wind arrive before the storm?" directly.',
    ],
    limits: [
      'Kp is quasi-logarithmic, so the bar is a median, never a mean — averaging it would compute a number that is not on the scale at all. The same applies to X-ray flux and, for a different reason, to earthquake magnitude.',
      'Kp reaches back to 1932 (GFZ Potsdam) and Dst to 1963 (Kyoto via NASA OMNI2) — genuinely different depths from two different observatory networks, so a row may show Kp with no Dst for three decades’ worth of hours.',
      'A spike here is a correlation you can *see*, not one that has been tested. Explore mode makes no significance claim; whether geomagnetic activity actually predicts anything about seismicity is H4c’s question, registered in HYPOTHESES.md and answered — once Phase 4’s analysis engine exists — with a proper test, never by eyeballing this row.',
    ],
    source: 'GFZ Potsdam (Kp), NASA OMNI2 / Kyoto World Data Center (Dst).',
  },

  'track-solar-wind': {
    title: 'Solar wind speed and IMF Bz',
    shows:
      'The bulk speed of the solar wind (km/s) and the north–south orientation of the interplanetary magnetic field it carries (Bz, in nT, GSM coordinates) — the driver half of space weather, upstream of the geomagnetic activity above it.',
    reading: [
      'The bar is the interval’s typical (median) speed; the cap is its fastest hour. The dashed line marks 500 km/s, the conventional slow/fast boundary.',
      'Bz in the readout is the interval’s most southward reading, not its largest magnitude either way. Southward is the geoeffective direction: it points opposite Earth’s own field, which is what lets the solar wind connect to it and drive a storm. A northward Bz of the same size is comparatively inert.',
      'A fast stream arriving with a southward Bz is the combination that tends to precede a geomagnetic storm — read this row against the one above it for that.',
    ],
    limits: [
      'Coverage is not monotonic and a gap must never be read as "calm wind." Measured across the real record: 92% in 1980, collapsing to 32–42% through 1985–1994 after the one spacecraft at L1 left, recovering to 98–100% from 1995 on. A row this row shows nothing on may simply be a decade with no instrument watching, not a quiet Sun.',
      'The gap is worst exactly where it matters most: around the October 2003 Halloween storm, the wind sensor was blind for 48 straight hours — saturated by the same solar energetic particles that made the storm significant — while Dst read −383 nT the whole time. A "% measured" caption appears below the peak whenever a window is materially incomplete, for exactly this reason.',
      'A spike lining up with the row above it is not evidence of anything by itself — H3b’s registered test, in HYPOTHESES.md, is what would actually answer whether solar wind speed predicts seismicity.',
    ],
    source: 'NASA OMNI2 (1963–), NOAA SWPC propagated real-time solar wind (live tail).',
  },

  'track-xray-flux': {
    title: 'GOES X-ray flux',
    shows:
      'How bright the Sun is in X-rays, in the 0.1–0.8 nm band — the exact measurement solar flare classification (A/B/C/M/X) is defined on. Flares are also drawn on the globe as their own layer; this row is the underlying signal they’re classified from, over time.',
    reading: [
      'The row is plotted on a log scale, not a linear one — flux genuinely spans nine orders of magnitude, from quiet-Sun background to the largest X-class flares, and a linear scale would draw everything below M-class as indistinguishable from zero.',
      'The letters are decades: A < B < C < M < X, each exactly ten times the flux of the one before. The number after the letter resets at every boundary, so it is not a running scale — "C1.0" is ten times "B1.0", but "B8.3" is smaller than "C1.0", not bigger. Watching the readout step from C1.0 down to B8.3 is a small decline, not a jump; it only looks like one if the letters are read as if they kept counting upward together.',
      'The dashed line marks M-class — the same floor the solar-flares globe layer draws at, and the geoeffective threshold H1b’s registered trigger uses.',
      'The bar is the interval’s typical (median) reading; the cap is its single highest minute.',
    ],
    limits: [
      'Live only — there is no historical archive behind this row yet, unlike every other row on this track. Scrub back more than about a week and it will show nothing at all, even though the window itself can reach back 130 years. NOAA does publish a real historical archive (NCEI, per-satellite-generation netCDF/CSV files back to 1974), but ingesting it is a materially larger undertaking than this row— a genuine gap, not an oversight, and not yet planned.',
      'Each hourly reading is that hour’s single highest minute, not an average — deliberately, because a flare lasting a few minutes would otherwise be diluted toward invisibility inside its own hour. The consequence is that an hour can read hotter than its typical minute actually was.',
      'This shows raw occurrence only, with no significance claim. Whether X-ray/flare activity predicts anything about seismicity is H1’s registered question — tested against the deeper GOES historical record, not this live row — and it is answered in Analyze mode, never by watching this track.',
    ],
    source: 'NOAA SWPC (services.swpc.noaa.gov/json/goes/primary/), from GOES’s own X-ray sensor.',
  },

  'track-earthquakes': {
    title: 'Earthquakes',
    shows:
      'The same events the globe is currently drawing, laid onto the shared time axis as one marker per time slice, sized by that slice’s largest magnitude — so a spike in any row above can be checked directly against what the ground was doing.',
    reading: [
      'A marker’s size is the largest magnitude in its time slice, on a fixed 0–9.5 scale — the same scale the globe itself uses, so a marker means the same thing here as it does there. M5.5+ takes the app’s red emphasis, matching the globe’s own ring.',
      'Clicking an earthquake on the globe draws a dashed guide line here at its exact time — "what was the sky doing when this happened," answered by looking straight down the column.',
      'This row follows whatever window, magnitude floor and playhead position the globe itself is currently showing — it cannot show an event the globe is hiding, or vice versa.',
    ],
    limits: [
      'One marker per time slice, not one per event — only the slice’s single largest earthquake gets a mark. Smaller events nearby are folded in without their own marker, so this is not a complete count; the event list and legend elsewhere in the app are.',
      'A quake lining up with a spike in another row is not evidence of anything — Explore mode makes no significance claim by design. Every hypothesis this app tests is pre-registered in HYPOTHESES.md with its parameters fixed before the test runs, specifically so a pattern noticed by eye here can never quietly become the test itself.',
    ],
    source: 'This app’s own USGS/EMSC earthquake catalogue — no separate ingest.',
  },

  'track-tidal-stress': {
    title: 'Lunisolar tidal stress',
    shows:
      'The shear stress the Sun and Moon are exerting on one mapped fault’s own plane, across the visible window. Unlike the tidal-potential globe layer — which is defined everywhere and makes no claim about any fault — this resolves that pull onto a specific orientation, which is what turns a potential into a stress a fault could actually feel.',
    reading: [
      'The curve is the resolved shear, with the midline at zero. It runs against a fixed ±1.5 kPa scale, so the amplitude means the same thing for every fault and in every window — a strongly stressed trace genuinely looks louder than a weak one.',
      'The fast oscillation is the semidiurnal tide, about 12.4 hours. The slow swelling and fading over a fortnight is the spring/neap cycle, when the solar and lunar tides fall in and out of alignment — measured across a real month, the daily peak swings by about 2.4×. Both are visible at once, which is the reason for the fixed scale.',
      'Which fault the row is describing is named in its caption. It follows the selection: pick an earthquake, click a fault trace, or probe a point, and the row resolves stress onto the nearest mapped fault to that place.',
      'For scale, the whole range here tops out around 1.5 kPa — roughly the pressure of a hand resting on a table, and something like a hundred-thousandth of the stress released in a moderate earthquake.',
    ],
    limits: [
      'The sign is not resolved, and the row says so. Which half of the cycle encourages slip and which resists it depends on reading strike in the same sense GEM measured its dip and rake against — and strike here is derived from the digitised direction of the mapped trace, which is arbitrary. The *shape* of the curve is right either way, because that ambiguity is one constant flip for the whole fault rather than a per-hour error; only the labels "positive" and "negative" are unearned.',
      'It needs a dip and a rake, and GEM publishes them for only 21.7% of its 13,696 faults (2,976, measured when the dataset was vendored). Most traces have no plane to resolve onto and the row will say so rather than guess one.',
      'The window has to be short enough to draw a 12.4-hour cycle, so the row stops at 30 days and explains itself past that. Across a decade a sampled tide is not a slower tide — it is aliased noise that would move convincingly and mean nothing.',
      'No ocean tide loading, and the free-surface condition is applied whatever the fault’s depth. Near a coast the ocean load is comparable to the solid-earth tide drawn here and shifts its *phase*, not just its size — the same two simplifications H6 reports as caveats on its own result.',
      'This is not H6 and proves nothing. H6 is the registered test of tidal triggering; it resolves stress onto Global CMT focal mechanisms rather than onto mapped traces, and it has been run — over 14,021 independent earthquakes it found no detectable relationship between the tidal cycle and when they happened, a clean null, as did every other test in the registered matrix. The numbers behind that belong in Analyze mode and are reported there. A quake lining up with a peak on this row is a coincidence you can see, and Explore mode makes no significance claim about it.',
    ],
    source:
      'Computed locally — no network. Sun and Moon positions from the same analytic ephemeris the tidal-potential layer uses; fault dip and rake from GEM’s Global Active Faults database; the stress chain is a port of the analysis engine’s own H6 physics.',
  },

  'track-magnetometer': {
    title: 'Ground magnetometer',
    shows:
      'How disturbed Earth’s magnetic field was at ground level, measured by the observatory nearest whatever you have selected. This is the same quantity the magnetometer globe layer shows on each station — the peak-to-peak swing of the horizontal component — plotted over time instead of as a single current value.',
    reading: [
      'Each bar is that interval’s largest swing minus its smallest, in nT. The scale is logarithmic, because the range is genuinely enormous: a quiet interval at Boulder is around 4 nT while the 2003 Halloween storm reached over 2,000 nT at College, Alaska. On a linear scale every quiet day would be a flat line along the axis.',
      'The dashed line marks 50 nT, the app’s own "this is more than ordinary" level for a station. Bars reaching it take the app’s red. It is display emphasis, not a threshold anything is tested against.',
      'The caption names the station and how far it is from what you selected. That distance is the thing to read first — see below.',
      'This row reaches back to 1987, so scrubbing a short window to March 1989 shows the Quebec storm as the observatories actually recorded it. It is the only row here whose history comes from a live query rather than a stored archive.',
      'A grey mark on the baseline is an interval the station did not report. Observatories drop out for maintenance constantly, and one that goes down during a storm is exactly the interval you must not read as calm.',
    ],
    limits: [
      'The nearest station is often nowhere near. The USGS network is about 31 observatories and heavily northern — 10 of them sit below 45 degrees latitude — so for most of the world the "nearest" station is hundreds to thousands of kilometres from the point you selected. The distance is printed for exactly this reason: a disturbance recorded 2,000 km away says very little about the ground beneath an epicentre.',
      'Geomagnetic disturbance is a global, near-simultaneous phenomenon driven by the Sun, not by the ground. A storm shows up at every station at once. So a bar rising near an earthquake is almost always telling you about space weather, not about that earthquake.',
      'Nothing is served before 1987, and the four USGS processing levels have real holes between them — 2015, for one, is covered by none of the two obvious candidates. The row says "no data for this window" rather than drawing a flat line, because an era nobody published and a genuinely quiet station look identical otherwise.',
      'Only minute-resolution data is served, so the row goes quiet on any window longer than 30 days. A year would be over half a million samples, and the service returns nulls rather than hourly averages if you ask it to thin them.',
      'Whether ground magnetic disturbance relates to nearby seismicity was going to be H4b. It was withdrawn unrun in August 2026 after measurement showed its trigger set correlated at rho = 0.74 with the planetary Kp index that H4c already tested — and H4c came back a clean null. This row is for looking, and it settles nothing.',
    ],
    source:
      'USGS Geomagnetism Program (geomag.usgs.gov), horizontal component at 1-minute cadence, public domain. Four processing levels are tried in turn — variation, adjusted, quasi-definitive, definitive — and the row reports whichever answered.',
  },
};

export function trackGuideFor(id: string): LayerGuide | undefined {
  return TRACK_GUIDES[id];
}
