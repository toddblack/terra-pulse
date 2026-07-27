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

**Phase 1 — Foundation. Complete.** Milestone met: the globe shows the last
72 hours of earthquakes, clickable, on two basemaps.

- [x] Monorepo scaffold (`apps/desktop`, `packages/*`)
- [x] Electron + React + Vite + TS, hardened main/preload
- [x] Cesium viewer mounted, camera controls
- [x] Basemap switching (OSM / NASA GIBS satellite)
- [x] SQLite + R-Tree schema and migration runner
- [x] USGS ingest adapter → normalized schema
- [x] Earthquake event layer (size = magnitude, colour = depth)
- [x] Click-to-inspect panel

`engine/` is not scaffolded — nothing needs it until Phase 4, and an empty
Python package would just be scaffolding ahead of need.

**Next: Phase 2 — Layers & Time.** See `PROJECT_PLAN.md` §9.

### Conventions this phase established

- Every globe layer is a factory returning `GlobeLayer`, holding its Cesium
  objects in closure. See `layers/osm-basemap.ts` for the smallest example.
- `unmount()` always guards on `viewer.isDestroyed()`. React effect cleanup
  order relative to the viewer's own teardown is not guaranteed, and this
  caused a real crash before the guard existed.
- Visual encoding lives in pure, Cesium-free modules (`earthquake-encoding.ts`)
  so it can be unit-tested without a WebGL context.
- Colour choices are validated with the `dataviz` skill's script against the
  actual basemap colours, not eyeballed.
- The renderer never reaches the network directly. Ingest runs in main; the
  renderer sees normalised data over IPC.

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
| Satellite imagery | NASA GIBS (no key) |
| Faults | USGS Quaternary Fault DB (US), GEM Global Active Faults |
| Ephemeris | JPL DE440 via Skyfield |

---

## Caching strategy

- **Tier 1:** one-time backfill, M4.5+ global, 1970–present. ~110k rows. This
  is the analysis engine's working catalog.
- **Tier 2:** on-demand cache keyed by (time window, magnitude, bbox), with TTL
  and a size cap. Do not pre-fetch the world.

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
