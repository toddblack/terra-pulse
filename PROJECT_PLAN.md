# Terra Pulse — Architecture & Roadmap

*A desktop application for exploring and statistically testing correlations
between global seismicity and solar/astronomical events.*

**Status:** Planning — v0.2
**Last updated:** 2026-07-24

---

## 0. Guiding Principles

1. **Modular by default.** Every data source, every analysis method, and every
   globe layer is a plugin behind a stable interface. Adding "planetary
   ephemeris" later must not require touching the globe renderer.
2. **Honest statistics.** The app's value is that it tests hypotheses properly,
   not that it makes two timelines look suggestive. Null-hypothesis machinery is
   a first-class feature, not an afterthought.
2b. **Explore and Analyze are separate modes.** Free-form visual exploration is
   legitimate hypothesis *generation* and is where most of the fun lives.
   Statistical testing is hypothesis *testing*. Both ship. They are visually
   and conceptually distinct in the UI, and Explore mode never displays
   p-values or claims of significance. Conflating the two is the single
   failure mode this project must avoid.
3. **Local-first.** No server, no accounts, no PII in v1. This eliminates an
   entire class of security concerns and ships faster.
4. **Reference-then-optimize.** Write correct, readable implementations first.
   Rewrite hot paths in a compiled language only where profiling justifies it,
   always validated against the reference.

---

## 1. Technology Stack

### Frontend / Shell
| Concern | Choice | Rationale |
|---|---|---|
| Desktop shell | **Electron** | Mature, familiar, cross-platform. Tauri is an option if bundle size becomes a problem. |
| Globe rendering | **CesiumJS** | Purpose-built for WGS84 geodesy, time-dynamic data, terrain, and swappable imagery. Not a decorative sphere. |
| UI framework | **React + Vite + TypeScript** | Existing fluency. TypeScript is non-negotiable here — the data schemas are complex enough that runtime type errors will cost real time. |
| Styling | **CSS Modules** | Component-colocated stylesheets (`Component.module.css` next to `Component.tsx`) with plain modern CSS (native nesting, custom properties). Tried Tailwind first; utility classes spread through JSX proved hard to keep track of as components multiply. Electron ships a fixed, recent Chromium, so there's no cross-browser reason to reach for Sass. |
| State | **Zustand** | Lightweight, less ceremony than Redux, good for the layer-toggle/time-window state this app needs. |

### Analysis Engine
| Concern | Choice | Rationale |
|---|---|---|
| Language (v1) | **Python 3.12+** | scipy, statsmodels, numpy, pandas. Fastest path to correct statistics. |
| Ephemeris | **Skyfield** + JPL DE440 | Free, accurate, handles planets and major moons. |
| IPC to Electron | **Local HTTP (FastAPI)** or child-process JSON | HTTP is easier to debug and lets you test the engine independently. |
| Language (v2, optional) | **C++ or Rust** for Monte Carlo kernel | See §7. |

### Storage
| Concern | Choice | Rationale |
|---|---|---|
| Event catalog cache | **SQLite** | Three layers: (0) **rolling cache, shipped** — `COVERAGE_TIERS` in `packages/schema`, currently 7d at M1+ and 30d at M2.5+, pruned to the longest tier on each backfill; (1) one-time backfill of **M4.5+ global, 1970–present** — **294,647 rows, ~62 MB measured** (an earlier ≈110k estimate here was wrong by 2.7×), the stats engine's browsing catalog, with **analysis restricted to the M5.5+ subset**; (2) on-demand cache for narrower/lower-magnitude queries, keyed by (window, magnitude, bbox) with TTL and size cap. |
| Spatial queries | SQLite's built-in **R-Tree** module | Fault-proximity and antipode-radius (bbox) queries without a Postgres server. Tried SpatiaLite first; the only available Windows binary is unmaintained and fails its own DLL init on a modern system (2016-era GEOS build) even after fixing the Windows DLL search-path issue. R-Tree ships inside SQLite core — no extension/binary to load at all — and covers what's actually needed. See Rejected Alternatives. |
| Tier 1 backfill (shipped, download only) | **Year chunks, resumable, user-triggered** | Chunked by calendar year and recorded in `archive_chunks`; fixed boundaries are what makes resume line up with a previous run. Measured: busiest year at M4.5+ is 2011 at 9,584 events against FDSN's 20,000 cap, so one request per year and the paging loop is defensive only. The current year is never recorded complete — it is still accruing — so it refetches each run and covers Jan 1 → the rolling window. Verified live: per-year counts match the FDSN `count` endpoint exactly for 1970–1975. **The archive shares the `earthquakes` table**, so the globe layer, R-Tree and dedup need no union queries; the price is that every existing query inherits it — pruning had to become magnitude-aware, dedup and the poll signature had to gain bounds. Browsable via `ARCHIVE_SPANS` (§5.1). |
| Schema migrations | **Numbered SQL steps, one transaction each** | Each migration commits with its own `schema_migrations` row or not at all — a partly-applied schema with no record of it would be re-run from the top on the next launch. `openDatabase` takes a `VACUUM INTO` snapshot to one rolling `<db>.backup` before any pending migration, and refuses to migrate if that snapshot fails. From migration 3 onward, schema changes to `earthquakes` use create-copy-drop-rename and carry `row_id` across explicitly, because reassigning it silently unlinks every row from the R-Tree. Migration 2's drop-and-recreate is history, not a template — see the note at the top of `migrations.ts`. |
| User preferences | **SQLite table** or JSON config | Local only. |
| Future cloud sync | *Supabase (deferred)* | Only if cross-device sync becomes a requirement. |

---

## 2. Module Breakdown

```
terra-pulse/
├── apps/
│   └── desktop/                  # Electron shell + React UI
│       ├── main/                 # Electron main process
│       ├── renderer/
│       │   ├── globe/            # Cesium wrapper, camera, picking
│       │   ├── layers/           # One module per toggleable layer
│       │   ├── timeline/         # Range selector + scrubber
│       │   ├── panels/           # Inspector, layer controls, results
│       │   └── state/            # Zustand stores
│       └── preload/              # Secure IPC bridge
│
├── packages/
│   ├── schema/                   # Shared TS types + JSON Schema (source of truth)
│   ├── ingest/                   # One adapter per data source
│   │   ├── usgs-quakes.ts
│   │   ├── noaa-swpc.ts
│   │   ├── nasa-donki.ts
│   │   └── faults.ts             # Static GeoJSON loaders
│   └── db/                       # SQLite access layer, migrations
│
├── engine/                       # Python analysis service
│   ├── api/                      # FastAPI endpoints
│   ├── decluster/                # Gardner-Knopoff, ETAS
│   ├── tests/                    # Statistical methods
│   │   ├── lagged_correlation.py
│   │   ├── monte_carlo.py
│   │   ├── poisson_baseline.py
│   │   └── multiple_comparisons.py
│   ├── ephemeris/                # Skyfield wrapper, tidal stress
│   └── native/                   # (v2) C++/Rust Monte Carlo kernel
│
└── docs/
    ├── PROJECT_PLAN.md           # This file
    ├── HYPOTHESES.md             # Pre-registered hypotheses (see §6)
    └── CLAUDE.md                 # Handoff notes for Claude Code
```

**Interface contract:** every ingest adapter emits records conforming to the
shared schema in `packages/schema`. The engine and UI only ever see normalized
data. Adding a new source means writing one adapter — nothing downstream changes.

---

## 3. Data Sources

All free, all confirmed available.

### Seismic
| Source | Endpoint | Notes |
|---|---|---|
| USGS real-time feeds | `earthquake.usgs.gov/earthquakes/feed/v1.0/summary/` | Pre-built buckets (hour/day/week/month × magnitude). CDN-cached, ~1 min refresh. **Use these for live view.** |
| USGS FDSN Event Service | `earthquake.usgs.gov/fdsnws/event/1/query` | Parameterized: time range, bbox, radius, magnitude, depth. **Use for historical backfill.** |
| **Plate boundaries** ✅ | `github.com/fraxen/tectonicplates` — Bird (2003) PB2002 | **Shipped** as a toggleable overlay. Derived from `PB2002_steps.json` by `scripts/vendor-plate-data.mjs` into 185 KB of merged polylines (1,683 runs). Licence **ODC-BY 1.0** — attribution required and credited in-app. The steps file carries all seven of Bird's classes (`SUB/OCB/CCB/OSR/CRB/OTF/CTF`); rendered as three kinematic groups because the palette validator passes three categorical colours all-pairs and cannot pass seven. **A motion-arrow layer built from `VELOCITYAZ` was shipped and then deleted** — that field is left-plate-w.r.t.-right with left/right set by digitisation order, so it encodes convergence *rate* and never *polarity*. See §Layer Inventory and the data README. |
| **Subduction polarity** ✅ | `github.com/usgs/slab2` — Hayes et al. (2018) | **Shipped** as the `subduction-zones` overlay: trenches with cartographic sawteeth pointing down-dip. Only `trenches_usgs_2017.csv` is used (159 KB) — not the netCDF depth grids, which answer a different question. Licence **CC0**, so attribution is courtesy rather than obligation. Dip = trench strike + 90°, verified 15/16 against known trenches and pinned by a regression test. This is the *only* source here that knows which plate dives. |
| **GEM Global Active Faults** ✅ | `github.com/GEMScienceTools/gem-global-active-faults` | **Shipped** as the `active-faults` overlay: 13,696 faults, 664,447 km, a single red, short faults revealed by zoom. (Was a muted grey; it measured 1.50:1 against GEBCO's water and got lost. Red **knowingly clashes** with the convergent boundary colour — best available separation is ΔE 10.5, under the 15 floor — accepted because faults are toggleable and boundary lines are cased and heavier. See `fault-encoding.ts`.) Derived to 2.39 MB (geometry + zoom tier only; all 23 attribute columns dropped as nothing renders them). Rendered via `PolylineCollection` — the Entity API allocates a primitive per feature — and pre-densified to a 50 km max chord because that API has no `ArcType.GEODESIC`. Licence **CC-BY-SA 4.0**: attribution required, and share-alike binds the *derived dataset*, not the app source. **It does not forbid commercial use** — that's CC-BY-NC, which this isn't. Open question only if imagery is ever sold commercially: CC-BY-SA lacks ODbL's "Produced Work" carve-out. |
| USGS Quaternary Faults | Quaternary Fault and Fold Database | US fault lines, GeoJSON. Superseded by GEM for now; revisit only if the finer US mapping is specifically wanted. |

### Solar / Space Weather
| Source | Endpoint | Notes |
|---|---|---|
| NOAA SWPC products | `services.swpc.noaa.gov/products/` | JSON: `alerts.json`, `noaa-planetary-k-index.json`, `kyoto-dst.json`, `10cm-flux-30-day.json`, `flares/` |
| NOAA SWPC event reports | Solar and Geophysical Event Reports | Forecaster-edited flare/event lists, 30-min updates. |
| NASA DONKI | `api.nasa.gov/DONKI/` | Structured CME/flare records **with predicted Earth-impact timing** — critical for lag analysis. Free API key. |
| NOAA solar wind | Real-time solar wind (DSCOVR/ACE/IMAP) | 24h rolling JSON: IMF, plasma. |

### Geomagnetic — Spatially Resolved
This is the layer that answers "where on the globe do we see spikes." Kp and
Dst are planetary averages; ground magnetometers are points on a map.

| Source | Notes |
|---|---|
| **INTERMAGNET** | Global network of magnetic observatories. Near-real-time reporting — some stations within an hour of acquisition. Definitive (calibrated), quasi-definitive, and raw tiers. Per-station vector field data. |
| **SuperMAG** | Aggregates ~600 stations into a near-global continuous measurement of ground-level field perturbations. 1-min and 1-sec products, plus derived indices (SME, SML). Free, registration required. |
| GNSS TEC maps | Ionospheric total electron content, spatially resolved. NASA CDDIS / Madrigal. *Explore mode only — pre-seismic ionospheric anomaly literature is genuinely contested.* |

### Astronomical (Phase 5)
| Source | Notes |
|---|---|
| JPL DE440 via Skyfield | Planetary + lunar positions. Enables **lunisolar** tidal stress computation. See §5.6 for the important physics caveat about planetary alignments. |

### Imagery (globe basemaps)
| Layer | Source | Cost |
|---|---|---|
| Basic ✅ | OpenStreetMap raster | Free, no key. Capped at zoom 19 — beyond that the tile server 400s. |
| Relief ✅ | **NASA GIBS** `BlueMarble_ShadedRelief_Bathymetry` | Free, no key. Static composite, so no `{Time}` segment or Clock. Level 8 / 500 m ceiling. **Replaced plain `BlueMarble_NextGeneration`**, which was dropped: this is the same imagery with seafloor relief shaded in, so the flat-ocean version was strictly less informative for a globe about seismicity. |
| Seafloor ✅ | **GEBCO** global bathymetric grid via BODC WMS (`wms.gebco.net`) | Free, no key, no fees; only stated constraint is "not for navigation". The one basemap rendered on demand rather than tiled, so it stays sharp past level 8 — at the cost of slower panning, since nothing is CDN-cached. Uses `GEBCO_LATEST` (shaded relief) over `GEBCO_LATEST_2` (colour-shaded): more topographic texture, less glare under the marks. |
| Satellite (alt) | Bing / Mapbox | Freemium, key required — **not used**, and a key in the renderer would violate non-negotiable #6. |

---

## 4. Globe Layer Architecture

Every layer implements the same interface:

```ts
interface GlobeLayer {
  id: string;
  label: string;
  category: 'basemap' | 'overlay' | 'events' | 'analysis';
  exclusive?: boolean;        // basemaps are mutually exclusive
  defaultVisible: boolean;
  mount(viewer: Cesium.Viewer): void;
  unmount(): void;
  setTimeWindow(start: Date, end: Date): void;
  setVisible(v: boolean): void;
}
```

### Layer Inventory

**Basemaps** (exclusive, pick one)
- Basic / OSM vector
- Relief (NASA GIBS, Blue Marble + shaded relief + bathymetry) — replaced the
  plain Blue Marble satellite basemap, which was dropped as strictly less
  informative once this shipped
- Seafloor (GEBCO global bathymetric grid, via BODC WMS) — the only basemap
  that renders on demand rather than serving fixed tiles, so it stays sharp
  past the level-8 ceiling the GIBS layers stop at. Free, no key; its only
  stated constraint is a "not for navigation" disclaimer.
- Night lights / blue marble

> **The seafloor basemap forced two colour checks.**
>
> *Earthquake depth ramp.* GEBCO's deep ocean sits around `#335588` and the
> depth ramp is also blue. The light-basemap ramp collapses against it — worst
> step ΔE 3.9, effectively invisible — while the dark ramp's worst is 9.7 with
> the rest at 18–46, because its shallow end is pale. Hence `tone: 'dark'`.
>
> *Plate boundary lines.* These were validated against a near-black surface,
> back when "dark" meant Blue Marble. Over blue water all three measured under
> 3:1 — 1.49/1.70/1.85 on the Mid-Atlantic Ridge, and 1.01/1.15/1.25 over the
> pale ridge crest, where divergent and transform effectively vanished. Fixed
> with a **casing** rather than by re-picking hues: the line's inner edge
> (colour against casing) is 5.1–6.3:1 and is independent of the backdrop, so
> the line carries its own contrast edge. Same principle as the earthquake mark
> halo. Applied to the dark tone only — the light palette spans lightness and
> cannot clear 3:1 against any single casing, and doesn't need to, since OSM is
> one consistent pale surface.

**Static overlays** (independent toggles)
- Tectonic plate boundaries — colored by kinematics (convergent / divergent /
  transform), from Bird (2003) PB2002 steps
- Subduction zones — trenches with cartographic sawteeth pointing down-dip,
  from USGS Slab2 (CC0)
- Active faults — global (GEM), single red, short faults revealed by zoom
- Fault lines — US (USGS Quaternary) — *superseded by GEM for now; revisit only
  if the finer US mapping is actually wanted*
- Lat/long graticule
- Day/night terminator

> **Two plate datasets, deliberately.** Bird's PB2002 gives *where* boundaries
> are and how they behave; Slab2 gives subduction *polarity* — which plate
> dives — which Bird structurally cannot.
>
> Bird's `VELOCITYAZ` is the velocity of the *left* plate w.r.t. the *right*,
> where left/right come from digitisation order, so for converging plates it
> points to the right-hand side by construction (1,129 of 1,129 subduction
> steps, 100%). It encodes convergence *rate*, never direction of dip. A
> relative-motion arrow layer built on it was 180° wrong at Tonga and Sumatra
> and has been deleted.
>
> Slab2's trench file carries strike, and dip = strike + 90° verifies on 15 of
> 16 known trenches — including Vanuatu and Manila, which dip against their
> neighbours. That check is a regression test, not a note.
>
> The two are **separate toggles rather than merged**: their geometries agree
> to a median 21 km but diverge to 166 km at p90, and any merge rule that got a
> match wrong would silently drop a real boundary. Details in
> `apps/desktop/src/renderer/src/data/README.md`.

> **The GEM fault data is CC-BY-SA, and that was a deliberate decision.**
> Share-alike binds the derived dataset (`active-faults.json`), not the
> application code — software that reads a dataset isn't an adaptation of it.
> CC-BY-SA does **not** forbid commercial use; that's CC-BY-NC, which this
> isn't. The one open question, if this ever ships imagery commercially: unlike
> ODbL, CC-BY-SA 4.0 has no "Produced Work" carve-out, so a rendered map
> containing faults is arguably Adapted Material. GEM offers custom licensing
> for uses that don't fit. Full reasoning in the data README.

**Event layers** (time-driven)
- Earthquakes — sized by magnitude, colored by depth
- Earthquakes — declustered (mainshocks only)
- Solar emission marker — subsolar point at flare time
- Solar arrival — dayside compression indicator at subsolar point at *arrival* time
- Auroral oval intensity (north + south)
- **Magnetometer stations** — INTERMAGNET/SuperMAG stations pulsing with
  disturbance amplitude. Optional interpolated surface.
- Ionospheric TEC surface (explore mode only)

**Analysis layers**
- Antipode chord (see §5.3)
- Antipode rings — 250 / 500 / 1000 km
- Lunisolar tidal stress surface
- Planetary/lunar position indicators (decorative — see §5.6)
- Heatmap / density surface
- Correlation highlight (events flagged by the stats engine)
- Seismic network detection capability (completeness map — needed to interpret
  everything else honestly)

**Rules:** basemaps are mutually exclusive; overlays are independent;
event layers respond to the global time window; analysis layers require an
engine run to populate.

---

## 5. Key Features

### 5.1 Time Window & Scrubber

Two-stage model, deliberately not an infinite scrub:

1. **Select window** — presets (72h default, 7d, 30d) or custom range picker.
2. **Fetch & cache** — pull from USGS/NOAA into SQLite, with progress feedback.
3. **Scrub within window** — playback controls, variable speed, events fade in
   at their timestamp and decay over a configurable trail duration.

Historical *analysis* spanning years goes to the **engine**, not the scrubber.
The scrubber is for perception; the engine is for measurement. Browsing the
archive visually is perception, and belongs here.

#### Archive spans — the mark budget is the design

Every view is sized to roughly the same number of marks. That budget already
exists and is already shipped: the 30d/M2.5 view draws **~7,671** marks, so
~8–10k is a demonstrated, not a guessed, ceiling.

Measured counts (FDSN `count`, 2026-07):

| span | floor | events |
|---|---|---|
| 1 year | M4.5 | 8,485 |
| 10 years | M5.5 | 4,604 |
| 20 years | M5.5 | 9,813 |
| all (1970–) | M6.0 | 7,907 |

For contrast, the combinations that do *not* fit: M4.5+ over 5 years is 38,538
and over the full span 294,648.

**The consequence, which inverts the obvious assumption:** "every large
earthquake in recorded history" is the *cheapest* view here, not the most
expensive. M7+ across 57 years is **781** marks — a tenth of the current live
view. Marker clustering and progressive detail are therefore an optimisation
for the dense M4.5+ spans, **not a prerequisite for browsing the archive**. An
earlier revision of this plan had that backwards.

**No new mental model.** `setWindowHours` already raises the magnitude floor to
whatever the chosen span was ingested at, and never lowers it. Archive spans
reuse that exact mechanism: pick a longer span, the floor rises to keep the
count in budget, and the magnitude buttons then work as they always have —
raising the floor only ever reduces the count, so M7+ over all years is free.
That is why there is no year dropdown and no second range slider; the muddiness
comes from adding controls, not from the span being long.

**`MAGNITUDE_FLOORS` gains M6.0 and M7.0.** They earn their place by the same
rule as the rest: they are USGS's own class boundaries (strong / major), not
round numbers sitting beside a real threshold. M6.5 is deliberately not added —
it is a round number, and nothing classifies at it.

#### The emphasis ring stays absolute — decided, not defaulted

Measuring the archive views raised an obvious-looking optimisation. The ring
threshold is a fixed M5.5, and the archive spans *are* M5.5+, so every mark
carries one: 26,746 events, 26,746 rings, each a second Cesium entity. Making
the threshold relative to the active floor would roughly halve the entity count
for exactly the heaviest view.

**Rejected, deliberately.** M5.5 means the same thing on every screen. The ring
answers "is this a big one?", and that question does not change because the
surrounding view narrowed — a mark that gains or loses its ring depending on
what else is displayed teaches the reader an encoding that isn't stable. The
590 ms build for the all-years view is the price of that consistency, and it is
a one-time cost per view switch rather than a per-frame one.

If the entity count ever genuinely needs to come down, the honest fix is
`PointPrimitiveCollection` instead of entities (§Phase 6), not a rule that makes
the same earthquake look different in two views.

#### Trailing window — isolating a period

The scrubber already solves positioning: with a long span selected, the
playhead walks 1970→now and playback animates decades. What it does not solve
is *isolation*, because the model is cumulative — everything up to the playhead
— which over 57 years ends with the whole archive on screen and no way to look
at just the 1990s.

The fix has a direct precedent in this codebase: **a trailing window is to time
what `isolateBand` is to magnitude.** "Only events within N of the playhead"
rather than "everything before it" — the same idea, the same one-checkbox UI
pattern, and it makes decade-browsing fall out of controls that already exist.

#### Two couplings that will bite if ignored

- **Archive view spans must NOT live in `COVERAGE_TIERS`.** That constant is
  deliberately shared between main (what to ingest) and the renderer (what to
  offer) so the two cannot drift. A 57-year entry there would make the
  launch-time backfill try to fetch 57 years on every start. View spans are a
  separate constant that the renderer reads and ingest never does.
- **`load()` must stop loading the widest range and narrowing in memory.** That
  is the current design, and it is why `INGEST_WINDOW_MS` is a stale 4-day
  constant while the UI offers 30d. It cannot survive 294k rows: archive views
  have to query by the selected span and floor.

### 5.2 Click-to-Inspect

Clicking an earthquake marker opens an inspector panel:

- Magnitude + magnitude type (`mb`, `mw`, `md` — these are not interchangeable)
- Origin time (UTC and local)
- Depth (km)
- Place description
- Coordinates
- Distance to nearest mapped fault
- Significance, felt reports, tsunami flag, alert level
- Link to the canonical USGS event page
- **Actions:** show antipode · center camera · use as analysis seed

Progressive detail on zoom: cluster markers when zoomed out, resolve individual
events as you zoom in.

### 5.3 Antipode Visualization

- **Math:** antipode of (lat, lon) is `(-lat, normalize(lon ± 180))`
- **Render:** toggle globe translucency / wireframe, draw a chord through the
  Earth's interior from event to antipode
- **Trigger threshold for *analysis*:** M6.0+ only. Below that, antipodal
  focusing energy is negligible and the candidate pool becomes noise.
- **The *visualisation* has no threshold**, and the distinction is deliberate.
  Drawing the antipode states a coordinate; it makes no claim, so there is
  nothing to gate. Restricting it would arguably imply more than showing it
  always, because a restriction reads as "we surface this when it might
  matter" — which is precisely the significance-by-implication Explore mode
  exists to avoid.

**Analysis method — no fixed radius.** Rather than picking a search radius
(a free parameter, and therefore a p-hacking hazard), record the
*distance-to-antipode* for every target quake in the time window and test
whether the distribution shows an excess at short distances relative to the
background-rate prediction. Continuous test, no guessed constant.

Visualization still draws rings at 250 / 500 / 1000 km for human readability.
For scale: a 1000 km cap is ~0.6% of Earth's surface; 400 km is ~0.1%.

**Critical confounder — detection bias.** Only about 4% of Earth's land is
antipodal to other land; most land antipodes fall in ocean, where seismometer
coverage is far sparser. Uncorrected, this measures the instrument network
rather than the Earth. The null model **must** incorporate a magnitude-of-
completeness map so that "no quake detected near the antipode" is weighted by
whether one *could* have been detected there.

Target catalog must also be declustered — the antipodal quake you find could
be an aftershock of something entirely local.

### 5.4 Statistical Engine

**Pipeline order matters:**

1. **Declustering** — Gardner-Knopoff windowing (v1) or ETAS (v2). Removes
   aftershock sequences. *Skipping this step invalidates everything downstream.*
2. **Poisson baseline** — model expected background seismicity rate per region
   and magnitude bin, so you measure deviation from expectation rather than raw
   counts.
3. **Lagged cross-correlation** — test solar event occurrence against quake
   rate/magnitude across multiple lag windows (0h, 24h, 48h, 72h, 7d…).
4. **Monte Carlo permutation** — shuffle the solar event timeline thousands of
   times, rebuild the correlation distribution, and locate the observed value
   within it. *This* is the significance test.
5. **Multiple-comparison correction** — Benjamini-Hochberg FDR across the full
   test matrix. Report both raw and corrected p-values.

**Output:** an effect size, a corrected p-value, a null distribution plot, and
an explicit statement of how many tests were run.

### 5.5 Explore Mode

The counterpart to the engine, and probably the more-used half of the app.

**Multi-track timeline panel** docked beneath the globe. Shared time axis with
the scrubber. Tracks (each independently toggleable):

- GOES X-ray flux (flare classification)
- Kp index / Dst index
- Solar wind speed and Bz
- Selected magnetometer station traces
- Lunisolar tidal stress at a chosen location
- Earthquake markers, sized by magnitude

**Interaction:** click any quake on the globe → the timeline centers on it and
highlights a configurable window before and after. "What was the sky doing when
this happened?" answered in one click.

**Constraint:** Explore mode displays no p-values, no significance claims, no
correlation coefficients. It shows data. Anything interesting found here
becomes a hypothesis written into `HYPOTHESES.md` and tested properly in
Analysis mode.

### 5.6 Solar Event Positioning

A flare's emission point and its Earth-impact point are different places —
the CME arrives hours to days later, by which time Earth has rotated.

- **Emission:** subsolar point at flare time. A single marker is appropriate.
- **Arrival:** *not* a point. A CME compresses the entire dayside magnetosphere,
  and the observable response concentrates in the **auroral ovals** at high
  latitudes. Render as dayside compression + auroral oval intensity, anchored
  to the subsolar point at arrival time.
- **Arrival timing:** taken from NASA DONKI's predicted Earth-impact estimates
  where available; otherwise derived from measured solar wind speed.

### 5.7 Tidal Stress — and the Planetary Alignment Caveat

**The physics, stated plainly:** planetary tidal forces on Earth are negligible.
Jupiter at closest approach exerts roughly one ten-millionth of the Moon's
tidal influence. Alignments do not meaningfully accumulate. Any correlation
found between planetary alignment and seismicity has no available mechanism.

**What is real:** lunisolar tidal stress is large, measurable, and there is
peer-reviewed literature finding weak but detectable tidal triggering —
particularly in subduction zones and on faults already near failure.
(Starting references: Tanaka; Cochran, Vidale & Tanaka.)

**Therefore:**
- Compute actual lunisolar tidal stress tensors at each event's location and
  time, resolved onto local fault geometry where known.
- Render planets and moons in the visualization because they are beautiful and
  wanted — but label them explicitly as decorative, not causal.
- H6 (lunisolar tidal stress) is the project's most physically defensible
  hypothesis and deserves the most careful treatment.

### 5.8 Large-Event Alerts

Notification, not warning. It reports something that has already happened, so
it belongs in Explore and makes no forward claim.

**Why this is not, and cannot be, early warning.** Real EEW (ShakeAlert, Japan)
races an alert ahead of the S-wave by detecting the P-wave at stations near the
source. It buys seconds, and needs sub-second raw waveform streams. Measured on
the USGS `all_hour` feed: first publication lags origin time by **78 s minimum,
222 s median**, before this app's own poll interval is added. S-waves travel
~3.5 km/s, so at 78 s the damaging wavefront has already covered ~270 km and at
222 s ~780 km. By the time an event is in the feed, the shaking is over
everywhere it mattered. See §11.

**Behaviour:**
- **One active alert at a time.** The most recent qualifying event holds the
  slot; a newer one replaces it. Dismissible.
- **Default threshold M6.0+** (~148/year, one per 2.5 days). M6.5+ (~50/year)
  and M7+ (~15/year) are the other sensible settings. Rates measured, not
  guessed — a threshold that fires daily gets ignored, and one that fires twice
  a year gets forgotten.
- **Click the banner to fly and select.** Not automatic. The camera invariant
  in `CesiumViewer` is that a `focusRequest` nonce is the *only* thing that
  moves it, and auto-panning would yank the view out from under someone
  mid-investigation — the same reason dragging clears the selection. An opt-in
  "follow new large events" toggle can exist for the leave-it-running-on-a-
  screen case; it must be off by default.
- OS-level notification (Electron `Notification`) when the window isn't
  focused, since that is the case where an in-app banner is useless.

**The firing rule — the source is the delta, not the catalogue.** An alert
fires only for an event that arrived in a **live poll or a user refresh**, and
only once. It is never raised by a scan of stored events.

This is worth stating as a rule rather than an implementation detail, because
it makes a whole class of bug structurally impossible instead of guarded
against. The obvious alternative — "scan for large events we haven't alerted
on" — has to defend against the launch backfill firing an alert for every large
event of the past month. Sourcing from the poll delta means the backfill is
simply not an alert source, and that defence is never needed.

**The launch digest is a separate thing, and shipped alongside.** "What did I
miss while away" carries no freshness bound, covers however long the app was
shut, and is a list you choose to read rather than an interruption. Same
magnitude threshold, so "notable" means one thing; ordered by magnitude rather
than time so its cap can never hide the largest event.

**What still needs care:**
- **Once per event id.** USGS revises magnitudes, so the same event will
  reappear in later polls and must not re-fire.
- **Revisions cross the threshold upward.** An M5.8 becomes M6.1 an hour later.
  The check therefore runs on every arrival of an event, not only the first —
  which is compatible with once-per-id, since the id is what's remembered.
- **The first poll after launch.** It pulls a 24-hour feed, so an M6 from
  yesterday is new *to us* without being news. A modest origin-time bound
  (within the last hour) handles it and stays stateless — no "have we launched
  yet" flag to get wrong.
- **A quiet period is not a failure.** Days pass with nothing at M6+; the UI
  must not imply the feed is broken.

### 5.9 Aftershock Forecasting

The honest version of "early warning" that this project genuinely can do.
Aftershock rates follow a well-characterised empirical decay, and USGS itself
publishes these operationally.

**Model:** Reasenberg & Jones (1989) — the rate of aftershocks of magnitude ≥ M
at time *t* after a mainshock of magnitude *Mm*:

    λ(t, M) = 10^(a + b(Mm − M)) / (t + c)^p

Omori-Utsu decay in time, Gutenberg-Richter in magnitude. Generic parameters
work immediately; fitted-to-this-sequence parameters are better and need the
observed sequence.

**This is a forecast, so it lives in Analyze**, with its parameters registered
before use like everything else. It does not violate non-negotiable #1 — it is
not a significance claim — but it is model output, and model output must never
be presented with the same weight as an observation.

**Display — in the inspector, on selection**, and the split matters:

- **Live events:** the forecast. Expected count in the next 24 h and 7 d, with
  an interval, not a point estimate. Labelled as generic parameters unless
  actually fitted.
- **Archive events:** what *actually followed*. For a 1985 mainshock a forecast
  is meaningless, but the observed sequence is real data and is arguably the
  more interesting panel. This is pure observation and is Explore-safe.

Only shown for events large enough to have a sequence worth describing (M5+),
and only inside a window where the decay is still meaningful. "Expected
aftershocks: 0.02/day" on a 1974 M4.6 is noise wearing a number.

**The one number people misread catastrophically:** Reasenberg-Jones also
yields the probability that an aftershock *exceeds* the mainshock — i.e. that
the mainshock was a foreshock. It is small (typically a few percent) and it is
the figure most likely to be screenshotted without context. If it is shown at
all, it is shown with its framing attached, never as a bare percentage.

---

## 6. Pre-Registered Hypotheses

Maintained in `docs/HYPOTHESES.md`. Every hypothesis is written down *before*
running the analysis, with its parameters fixed. This is what separates
discovery from the multiple-comparisons trap where testing enough combinations
guarantees a "significant" result from pure noise.

Initial set:

| ID | Hypothesis | Parameters | Mechanism plausibility |
|---|---|---|---|
| H1 | X/M-class flare occurrence elevates global M5+ rate | lags: 0–7d | Low |
| H2 | Effect is stronger on the hemisphere facing the CME at **arrival** time | subsolar longitude at arrival ±90° | Low |
| H3 | Coronal hole high-speed streams elevate M5+ rate | lags: 2–5d (transit time) | Low |
| H4 | Kp/Dst geomagnetic disturbance correlates with M5+ rate | lags: 0–3d | Low |
| H4b | **Local** magnetometer disturbance correlates with **nearby** M5+ rate | station radius 500km, lags 0–72h | Low, but spatially specific — a stronger test than H4 |
| H5 | M6+ quakes are followed by an excess of M5+ at short antipodal distance | distance-distribution test, 0–72h, completeness-corrected | Moderate — antipodal focusing is a real wave phenomenon |
| H6 | Peak lunisolar tidal stress correlates with M5+ rate | resolved onto fault geometry; Phase 5 | **Highest** — established mechanism, existing literature |

**Expected result:** most of these will show no significant effect after
correction. That is a legitimate and reportable finding, and the app is built
to say so plainly. H5 and H6 have the only physically plausible mechanisms;
H1–H4 are included because they are the project's originating question and
deserve an honest test rather than dismissal.

**Not tested:** planetary alignment as a causal factor. See §5.7 — the effect
size is physically negligible and no mechanism exists. Planets appear in the
visualization only.

---

## 7. The C++/Rust Learning Track

The Monte Carlo permutation kernel is the one component where a compiled
language genuinely earns its place: it's CPU-bound, embarrassingly parallel,
and completely self-contained behind a narrow interface.

**Approach:**
1. Ship the Python/numpy implementation first. Correct and readable.
2. Build a benchmark suite and a set of known-answer tests.
3. Reimplement the kernel in C++ (or Rust) as a native Node addon (N-API) or a
   Python extension (pybind11 / PyO3).
4. Validate the compiled version against the Python reference on every test
   case. Identical results, measured speedup.

This gives you a real systems-programming project with an existing correctness
oracle — the ideal way to learn. It also means the compiled code is entirely
optional: the app works without it.

**C# note:** C# has no natural home in this architecture. Choosing it would mean
Unity instead of Cesium, which costs the geodesy, terrain, and imagery layers
that make this app worth building. Recommend against it *for this project*.

---

## 7.5 Memory Management

Garbage collection is not the concern; three specific patterns are.

1. **Cesium entity/primitive lifecycle.** Cesium objects are not reclaimed by
   the JS GC merely because you dropped the reference. Every layer's
   `unmount()` must explicitly destroy its primitives, entities, and imagery
   providers. This is the leading cause of memory growth in Electron+Cesium
   apps. Add a dev-mode assertion that entity count returns to baseline after
   toggling every layer off.
2. **Single canonical dataset.** Keep one in-memory copy of the loaded event
   set and derive all views (filtered, time-sliced, clustered) as projections.
   Never retain per-frame state during scrubbing.
3. **Engine-side arrays.** A Monte Carlo run over 110k events with 10k
   permutations is the memory high-water mark. Chunk permutations rather than
   materializing the full matrix. This is also precisely where manual memory
   management becomes the lesson in the C++/Rust rewrite (§7).

---

## 8. Security Posture

Local-first architecture removes most of the attack surface:

- **No server, no accounts, no PII** in v1
- **Electron hardening:** `contextIsolation: true`, `nodeIntegration: false`,
  all IPC through an explicit preload bridge with a minimal allowlist
- **CSP** restricting network access to known data-source domains
- **API keys** (NASA DONKI, Cesium Ion, Mapbox) stored in the main process, never
  exposed to the renderer
- **Input validation** on all ingested data before it reaches SQLite —
  parameterized queries only
- **Dependency auditing** in CI
- **Code signing** for distributed builds

If cloud sync is added later: Supabase with row-level security, OAuth, and
server-side proxying of all third-party API calls.

---

## 9. Roadmap

### Phase 1 — Foundation
- Electron + React + Vite + TypeScript scaffold
- Cesium viewer mounted, camera controls, basemap switching
- SQLite + R-Tree schema and migrations
- USGS ingest adapter, 72-hour default window
- Earthquake event layer with magnitude/depth encoding
- Click-to-inspect panel
- **Milestone:** a working globe showing the last 72 hours of quakes.

### Phase 2 — Layers & Time
- Layer registry and toggle UI
- Fault line + plate boundary overlays
- ~~Terrain and satellite basemaps~~ — satellite shipped in Phase 1; terrain
  dropped, see §11
- Time window selector + scrubber playback
- ~~**Archive browsing (§5.1)**~~ — **shipped.** `ARCHIVE_SPANS` (1y/M4.5,
  10y/M5.5, all/M5.5) in their own "History" group, M6/M7 floors, a trailing
  window, floor-relative emphasis rings, and `load()` querying by span. Needed
  no clustering: the views that matter are ~8k marks.
- Marker clustering / progressive detail — for the dense M4.5+ multi-year
  spans only. Not a prerequisite for the above.
- ~~Antipode chord visualization~~ — **shipped.** Straight chord through the
  interior (`ArcType.NONE`), globe translucency rather than wireframe (Cesium's
  globe wireframe is a private debug flag), offered for any selected event.
- **Milestone:** full visual exploration tool. **Reached.**

### Phase 3 — Solar & Geomagnetic Data
- NOAA SWPC and NASA DONKI adapters
- Solar emission + arrival layers (§5.6), auroral ovals
- INTERMAGNET / SuperMAG station layer with disturbance amplitude
- Multi-track timeline panel — **Explore mode** (§5.5)
- Click-a-quake → center timeline on it
- ~~Large-event alerts (§5.8)~~ — **shipped early.** Needed no new data source,
  only the existing USGS poll, so it did not have to wait for the rest of this
  phase. One active alert, click-to-fly, OS notification when unfocused.
- **Milestone:** Explore mode complete. This is a genuinely useful app even if
  Phase 4 never ships.

### Phase 4 — Statistical Engine
- Python service scaffold + FastAPI
- Gardner-Knopoff declustering
- Magnitude-of-completeness map (required for H5)
- Poisson baseline model
- Lagged cross-correlation
- Monte Carlo permutation testing
- FDR correction
- Results panel with null distribution plots, clearly separated from Explore
- Aftershock forecasting (§5.9) — Reasenberg-Jones, generic parameters first,
  fitted per-sequence after. Shares the declustering and Gutenberg-Richter
  machinery built for the hypothesis tests, which is why it belongs here rather
  than in Phase 3. The *observed* sequence panel for archive events needs none
  of that and can land earlier.
- **Milestone:** H1–H5 tested and honestly reported.

### Phase 5 — Astronomical Extension
- Skyfield + DE440 integration
- Planetary and lunar position layer (labeled decorative)
- **Lunisolar tidal stress tensors**, resolved onto fault geometry
- Tidal stress timeline track + globe surface
- H6 testing
- **Milestone:** tidal triggering analysis — the project's best shot at a
  real signal.

### Phase 6 — Optimization & Polish
- Profile the engine, identify hot paths
- C++/Rust Monte Carlo kernel with validation harness
- Export: figures, CSV, reproducible analysis configs
- Packaging and code signing

---

## 10. Open Questions

- [ ] Bundle Python with the app, or require a local install? (PyInstaller vs.
      documented prerequisite — affects distribution complexity significantly)
- [ ] Global fault coverage — is GEM's dataset complete enough, or do regional
      sources need stitching?
- [ ] Offline mode — how much data to pre-bundle for first run?
- [ ] SuperMAG registration terms — confirm redistribution rules before shipping
      a binary that pulls their data.
- [ ] Magnitude-of-completeness map — compute from catalog, or is there a
      published gridded product to use directly?

      **Measured 2026-07-28** (USGS global feed, 14-day sample) — the bias is
      far larger than "some regions are better instrumented", and it has a
      sharp edge between M3 and M4:

      | Floor | Events | % United States |
      |---|---|---|
      | M1+ | 3,425 | 86% |
      | M2+ | 1,464 | 69% |
      | M2.5+ | 908 | 51% |
      | M3+ | 630 | 31% |
      | M4+ | 455 | **6%** |
      | M5+ | 111 | 7% |

      By band: M1–2 and M2–3 are both **99% US**; M3–4 is 95% US; M4–5 drops
      to 6%. Roughly **92% of all non-US events in the feed are M4+** — only
      ~37 non-US events below M4 worldwide in two weeks.

      This is not geology. Japan, Chile, Indonesia and Greece are extremely
      active and nearly absent below M4 because their small events go to
      national catalogs this app does not ingest, while a dense US network
      records an equivalent M2 many times over.

      Two consequences already acted on:
      - The globe's magnitude selector labels coverage per floor, so a user
        cannot mistake the US network for a global pattern (§5.3's detection
        bias, made visible rather than documented).
      - It confirms **M4.5+ as the right Tier 1 analysis threshold** — that is
        where the catalog becomes globally honest. H5 in particular cannot use
        anything below it without the completeness correction.

      Also note the low end is contaminated by **induced** seismicity:
      Texas, Oklahoma and New Mexico were all top-10 regions for M1–2, largely
      wastewater injection rather than tectonics.

      **Update 2026-07-28 — EMSC added as a second source.** EMSC aggregates
      ~70 national agency catalogs, which is precisely the data USGS's global
      feed lacks. Measured on the merged catalog (USGS authoritative, EMSC
      filling gaps, 4-day sample):

      | Floor | USGS alone | Merged | US share before → after |
      |---|---|---|---|
      | M1+ | 1,084 | 2,764 | 86% → **35%** |
      | M2+ | 465 | 1,813 | 69% → **20%** |
      | M3+ | 186 | 923 | 31% → **7%** |
      | M4+ | 125 | 250 | 6% → **3%** |

      A sharper finding fell out of the dedup check. Match rate between the two
      sources, by band:

      | Band | USGS | EMSC | EMSC matching a USGS record |
      |---|---|---|---|
      | M4.0–4.5 | 43 | 150 | 23% |
      | M4.5–5.0 | 43 | 53 | 77% |
      | M5.0+ | 39 | 43 | 91% |

      **USGS's global feed is materially incomplete between M4.0 and M4.5** —
      EMSC reports ~3.5× as many events there. Completeness begins at M4.5,
      not M4. This pins the Tier 1 threshold more precisely than the earlier
      measurement did: M4.5+ is right, and M4+ would not have been.

      **Update 2026-07-30 — M4.5+ is right for *space*, and wrong for *time*.**
      The finding above is about a snapshot: at M4.5 the catalog stops being a
      map of where the seismometers are. It says nothing about whether the
      catalog is comparable *across decades*, and measured, it isn't. Global
      counts per decade:

      | Decade | M4.5+ | M5.0+ | M5.5+ | M6.5+ |
      |---|---|---|---|---|
      | 1950s | 3,149 | — | 2,496 | 309 |
      | 1970s | 25,843 | 13,581 | 4,377 | 354 |
      | 1990s | 43,144 | 14,660 | 4,865 | 489 |
      | 2010s | 75,278 | 18,469 | 4,898 | 489 |

      M4.5+ rose **24× since the 1950s and 3× since 1970**. The Earth did not
      do that — networks densified and older events were never recorded to
      begin with. M5.0+ still drifts 36%. **M5.5+ varies 12% and M6.5+ is flat
      back to the 1950s.**

      Consequences, both binding:

      - **Analysis (Explore's counterpart) must read M5.5+, not M4.5+.** Any
        decade-scale test against a slow-varying driver — the solar cycle above
        all, which is the whole point of this project — would otherwise find a
        strong correlation that is purely instrument deployment history. This
        is the single largest threat to H1–H5 and it is invisible in the data
        itself.
      - **Explore may still browse M4.5+**, because looking at a specific era
        is a legitimate thing to do. It carries a coverage label; it is never
        the default for a long span.

      Also measured: **FDSN caps every query at 20,000 events**, so the Tier 1
      backfill has to be chunked and resumable regardless of design.

      The residual limitation is no longer US bias. It is that small events are
      only recorded where instrument networks are dense — an M2 in the
      mid-Pacific is detected by nobody, and no aggregator changes that. Any
      spatial analysis below ~M4.5 still needs the completeness correction
      §5.3 requires.
- [ ] How many magnetometer stations can Cesium render smoothly before
      clustering becomes necessary?

**Resolved:**
- ~~Solar event positioning~~ → §5.6. Emission point + arrival-time dayside
  compression and auroral ovals.
- ~~Minimum magnitude for cache~~ → §Storage. M4.5+ full backfill, everything
  else on-demand.
- ~~Antipode search radius~~ → §5.3. No fixed radius; distance-distribution test.

---

## 11. Rejected Alternatives

| Option | Why not |
|---|---|
| Three.js instead of Cesium | Would require hand-rolling geodesy, terrain, and imagery layers Cesium provides. |
| Unity + C# | Loses Cesium's mapping stack; heavier toolchain for marginal benefit. |
| Postgres/Supabase for v1 | Adds a server, accounts, and a security surface for a dataset SQLite handles trivially. |
| Web app instead of desktop | Cesium in-browser is viable, but desktop enables local caching, offline analysis, and heavier computation without hosting costs. |
| Infinite historical scrubber | Data volume makes it unusable; window-select is both faster and clearer. |
| Cesium World Terrain as a basemap | Ion's free tier is non-commercial only. It also needs `enableLighting` (day/night shading) to be visible at all, which conflicts with wanting the whole globe uniformly lit for data visualization — half the quakes would sit on the "night" side. |
| Earthquake early warning (EEW) | Structurally impossible from this data source, not merely hard. Real EEW detects the P-wave near the source and races the S-wave, buying seconds from sub-second raw waveform streams. Measured on the USGS `all_hour` feed: first publication lags origin by **78 s min / 222 s median**, before this app's poll interval. At ~3.5 km/s the S-wave has covered ~270 km by 78 s and ~780 km by 222 s — the shaking is over before the event exists in the feed. Recorded here so it doesn't get re-proposed. What *is* possible is §5.8 (alerts, after the fact) and §5.9 (aftershock forecasting). |
| Earthquake prediction (where/when/magnitude in advance) | Not a solved problem, and not one this app is going to solve. Aftershock *forecasting* (§5.9) is a different and legitimate thing: it is a probabilistic rate for a sequence already underway, not a claim that an earthquake is coming. |
| SpatiaLite (real attempt, not skipped) | `node:sqlite`'s extension loading genuinely works (verified). The blocker is the binary: the only real Windows build available (`spatialite-bin` on npm) is a single unmaintained release bundling GEOS 3.5 (~2016). Its DLL fails its own init routine on a modern system even once the Windows DLL search-path problem is fixed — confirmed with a direct `LoadLibraryEx` call outside of Node entirely, so it's not a Node/SQLite-specific issue. R-Tree (built into SQLite core) covers the bbox/radius queries actually needed; revisit real SpatiaLite if a maintained binary source turns up later. |
