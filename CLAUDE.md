# CLAUDE.md — Terra Pulse

Working context for Claude Code. Read `docs/PROJECT_PLAN.md` for the full
architecture; this file is the operating brief.

---

## What this is

A local-first Electron desktop application that visualizes global seismicity
alongside solar, geomagnetic, and astronomical data, and statistically tests
whether they correlate.

Two modes, deliberately separate:
- **Explore** — free-form visual investigation. No p-values, ever.
- **Analyze** — pre-registered hypothesis testing with proper corrections.

---

## Stack

- **Shell:** Electron
- **UI:** React + Vite + TypeScript + CSS Modules
- **State:** Zustand
- **Globe:** CesiumJS
- **Storage:** SQLite + R-Tree (local only, no server)
- **Analysis engine:** Python 3.12 + FastAPI + numpy/scipy/statsmodels
- **Ephemeris:** Skyfield + JPL DE440
- **Optional (Phase 6):** C++ or Rust native module for the Monte Carlo kernel

---

## Current phase

**Phase 1 — Foundation. Complete.**
**Phase 2 — Layers & Time. Substantially complete.**

Shipped in Phase 2:

- [x] Layer registry + toggle panel, all layers declarative entries
- [x] Basemaps: OSM / GIBS relief / GEBCO seafloor *(plain Blue Marble dropped —
      relief is the same imagery with the ocean floor visible)*
- [x] Plate boundaries — Bird PB2002, three kinematic groups, cased lines
- [x] Subduction zones — USGS Slab2, sawteeth pointing down-dip
- [x] Active faults — GEM, 13,696 features, revealed by zoom tier
- [x] Earthquake encoding: depth = colour, magnitude = size, M5.5+ = ring,
      last 24h = red stroke
- [x] Time scrubber with playback; recency measured from the playhead
- [x] Coverage tiers (24h–30d), magnitude floors, band isolation, pruning

**Remaining in Phase 2:** antipode chord visualisation.

**Next big piece:** the historical archive — see the "Part 2" section of the
plan file and `PROJECT_PLAN` §Storage. **Migration safety is a hard
prerequisite**: migration 2 currently drops the earthquakes table, which is
only safe while everything is refetchable.

`engine/` is not scaffolded — nothing needs it until Phase 4, and an empty
Python package would just be scaffolding ahead of need.

### Conventions these phases established

- Every globe layer is a factory returning `GlobeLayer`, holding its Cesium
  objects in closure. See `layers/osm-basemap.ts` for the smallest example.
- `unmount()` always guards on `viewer.isDestroyed()`. React effect cleanup
  order relative to the viewer's own teardown is not guaranteed, and this
  caused a real crash before the guard existed.
- Visual encoding lives in pure, Cesium-free modules (`earthquake-encoding.ts`)
  so it can be unit-tested without a WebGL context.
- The renderer never reaches the network directly. Ingest runs in main; the
  renderer sees normalised data over IPC.
- **Measure, don't assume.** Nearly every correction this project has needed
  came from measuring something that looked obvious. Colours are validated with
  the `dataviz` script against the *actual backdrop* — not a generic surface,
  and not the wrong one: boundary colours passed against near-black and failed
  at 1.01:1 over blue water.
- **Pick the right metric.** WCAG contrast measures luminance only. For a mark
  whose job is carried by hue — a red stroke on a blue dot — use OKLab ΔE.
  A 3:1 contrast bar rejected a perfectly good colour once; even white scores
  2.50:1 against the palest depth step.
- **Fake viewers in tests must really destroy.** A mock `remove()` that only
  recorded the call let a crash-on-unmount ship: Cesium's real `remove()`
  destroys, and destroying exposed a shared-material bug.
- **Never read `Date.now()` during render** — use `useNow`. It's impure, and
  nothing re-renders when a clock ticks, so the value silently goes stale.
- Layers declare `consumesEvents`; those that don't are not rebuilt when the
  poll lands. Geology doesn't change every five minutes.
- `COVERAGE_TIERS` in `packages/schema` is read by **both** main and renderer,
  so what the UI offers and what ingest fetches cannot drift apart.

---

## Non-negotiables

These are architectural decisions, not preferences. Do not quietly change them.

1. **Explore mode never displays significance claims.** No p-values, no
   correlation coefficients, no "this looks related." It shows data on shared
   axes and nothing more.
2. **Declustering happens before any statistical test.** Raw catalogs contain
   aftershock sequences that will masquerade as signal. Gardner-Knopoff
   minimum.
3. **No free parameters chosen after seeing results.** Search radii, lag
   windows, magnitude bins — all fixed in `docs/HYPOTHESES.md` before the test
   runs. Every hypothesis gets an entry with parameters and a date.
4. **Multiple-comparison correction is mandatory.** Benjamini-Hochberg FDR
   across the full test matrix. Always report how many tests were run.
5. **Cesium objects must be explicitly destroyed** in every layer's
   `unmount()`. GC will not do it.
6. **No API keys in the renderer process.** Main process only, proxied.
7. **Every ingest adapter emits the shared schema.** Downstream code never sees
   a raw USGS or NOAA payload.

---

## Layer interface

Every globe layer implements this. No exceptions — the layer registry depends
on it.

```ts
interface GlobeLayer {
  id: string;
  label: string;
  category: 'basemap' | 'overlay' | 'events' | 'analysis';
  exclusive?: boolean;
  defaultVisible: boolean;
  mount(viewer: Cesium.Viewer): void;
  unmount(): void;              // MUST destroy all Cesium objects
  setTimeWindow(start: Date, end: Date): void;
  setVisible(v: boolean): void;
}
```

---

## Data sources (all free)

| Purpose | Endpoint |
|---|---|
| Live quakes | `earthquake.usgs.gov/earthquakes/feed/v1.0/summary/` |
| Historical quakes | `earthquake.usgs.gov/fdsnws/event/1/query` |
| Space weather JSON | `services.swpc.noaa.gov/products/` |
| CME/flare + arrival times | `api.nasa.gov/DONKI/` (free key) |
| Magnetometers | INTERMAGNET, SuperMAG (registration) |
| Satellite imagery | NASA GIBS (no key) — `BlueMarble_ShadedRelief_Bathymetry` |
| Bathymetry | GEBCO via BODC WMS, `wms.gebco.net` (no key) |
| Faults | USGS Quaternary Fault DB (US), GEM Global Active Faults |
| Ephemeris | JPL DE440 via Skyfield |

---

## Caching strategy

- **Rolling cache (shipped):** driven by `COVERAGE_TIERS` in
  `packages/schema` — a single definition read by *both* main (what to ingest)
  and the renderer (what the selectors may offer), so the two can't drift.
  Currently 7d at M1+ and 30d at M2.5+. Pruned to the longest tier on every
  backfill; nothing else ever deletes.
- **Tier 1 (not built):** one-time backfill, M4.5+ global, 1970–present.
  **294,647 rows, ~62 MB** — measured. An earlier ~110k estimate here was wrong
  by 2.7×.
- **Tier 2:** on-demand cache keyed by (time window, magnitude, bbox), with TTL
  and a size cap. Do not pre-fetch the world.

**Magnitude floors are `[1, 2.5, 4.5, 5.5]`** and every value is load-bearing:
M2.5 is USGS's own small-event threshold, M4.5 is where global completeness
begins, M5.5 is the only floor flat since 1970. Round numbers were replaced
because they sat *beside* the real thresholds rather than on them.

**Analysis must use M5.5+, not M4.5+.** Measured global counts per decade:
M4.5+ rose 24× since the 1950s and 3× since 1970 — that is seismometer
deployment, not seismicity. M5.5+ varies 12% per decade. Running a
decade-scale correlation on M4.5+ would find a strong spurious signal against
any slow-varying driver, the solar cycle above all.

---

## Code conventions

- TypeScript strict mode on. The schemas are complex enough that loose typing
  will cost real debugging time.
- Shared types live in `packages/schema` and are the single source of truth.
  Generate JSON Schema from them for the Python side.
- Parameterized SQL only.
- Each layer, each ingest adapter, and each statistical method is an
  independent module with its own tests.
- Prefer readable reference implementations over clever ones. Optimization is
  Phase 6 and requires a benchmark plus a correctness oracle.

---

## Tone / working style

Plain, direct language in comments and docs. No corporate voice. Explain the
*why* for anything non-obvious, especially in the statistics code — future-me
needs to know why a correction is applied, not just that it is.

When something in the plan turns out to be wrong, update
`docs/PROJECT_PLAN.md` rather than working around it silently. The plan is
meant to change; it is not meant to drift out of sync with the code.
