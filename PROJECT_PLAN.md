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
| Event catalog cache | **SQLite** | Two-tier: (1) one-time backfill of **M4.5+ global, 1970–present** ≈ 110k rows, tens of MB — this is the stats engine's working catalog; (2) on-demand cache for narrower/lower-magnitude queries, keyed by (window, magnitude, bbox) with TTL and size cap. |
| Spatial queries | SQLite's built-in **R-Tree** module | Fault-proximity and antipode-radius (bbox) queries without a Postgres server. Tried SpatiaLite first; the only available Windows binary is unmaintained and fails its own DLL init on a modern system (2016-era GEOS build) even after fixing the Windows DLL search-path issue. R-Tree ships inside SQLite core — no extension/binary to load at all — and covers what's actually needed. See Rejected Alternatives. |
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
| USGS Quaternary Faults | Quaternary Fault and Fold Database | US fault lines, GeoJSON. |
| GEM Global Active Faults | GEM Foundation | Worldwide fault coverage. |

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
| Satellite | **NASA GIBS** | Free, no key, near-real-time |
| Satellite (alt) | Bing / Mapbox | Freemium, key required |
| Basic/vector | OpenStreetMap raster | Free |

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
- Satellite (NASA GIBS)
- Night lights / blue marble

**Static overlays** (independent toggles)
- Tectonic plate boundaries
- Fault lines — US (USGS Quaternary)
- Fault lines — global (GEM)
- Lat/long graticule
- Day/night terminator

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

Historical analysis spanning years goes to the **engine**, not the scrubber.
The scrubber is for perception; the engine is for measurement.

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
- **Trigger threshold:** M6.0+ only. Below that, antipodal focusing energy is
  negligible and the candidate pool becomes noise.

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
- Marker clustering / progressive detail
- Antipode chord visualization
- **Milestone:** full visual exploration tool.

### Phase 3 — Solar & Geomagnetic Data
- NOAA SWPC and NASA DONKI adapters
- Solar emission + arrival layers (§5.6), auroral ovals
- INTERMAGNET / SuperMAG station layer with disturbance amplitude
- Multi-track timeline panel — **Explore mode** (§5.5)
- Click-a-quake → center timeline on it
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
| SpatiaLite (real attempt, not skipped) | `node:sqlite`'s extension loading genuinely works (verified). The blocker is the binary: the only real Windows build available (`spatialite-bin` on npm) is a single unmaintained release bundling GEOS 3.5 (~2016). Its DLL fails its own init routine on a modern system even once the Windows DLL search-path problem is fixed — confirmed with a direct `LoadLibraryEx` call outside of Node entirely, so it's not a Node/SQLite-specific issue. R-Tree (built into SQLite core) covers the bbox/radius queries actually needed; revisit real SpatiaLite if a maintained binary source turns up later. |
