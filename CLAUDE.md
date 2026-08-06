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

**Phase 2 complete.** Antipode chords were the last item.

**Antipode view (§5.3) — shipped.** Entered from the inspector on any selected
event; a red chord animates from the quake straight through the planet to the
point opposite, with the globe made translucent.

- **`ArcType.NONE` is load-bearing.** The polyline default is GEODESIC, which
  drapes the line over the surface — that draws the long way *round* the Earth,
  the exact opposite of the thing being shown.
- **Offered for every event, not just M6.0+.** §5.3's threshold governs the
  Phase 4 *analysis*, where the candidate pool matters. The viewer states a
  coordinate and makes no claim — and restricting it would arguably imply more,
  since a restriction reads as "we surface this when it might matter".
- **True wireframe is not available.** Cesium's globe wireframe is a private
  debug flag; `debugWireframe` is 3D Tiles only. `globe.translucency` is the
  public API and looks better anyway.
- **The layer restores translucency to its previous values on unmount, not to
  `false`.** It borrows scene-wide state; leaking it leaves every later view
  see-through with no visible cause. Tested.
- **Drag-deselect is suppressed while the mode is active.** Rotating to see
  where the chord comes out is the whole point, and the existing rule would
  have dropped both the chord and the inspector holding its exit on the first
  drag. Escape also exits.
- `setDimmed` is a new **optional** method on `GlobeLayer`: the earthquake layer
  fades its marks so 26,000 far-side dots don't drown one line. One colour
  write per entity, once per toggle — a rebuild would cost the full 590 ms.

**Migration safety — done.** Was the hard prerequisite for the archive; it no
longer blocks anything.

- Each migration and its `schema_migrations` row commit in one transaction, so
  a failure rolls back whole instead of leaving a half-changed schema that the
  next launch re-runs from the top.
- `openDatabase` snapshots the file with `VACUUM INTO` before applying any
  pending migration, to one rolling `<db>.backup`. A failed backup aborts the
  migration rather than proceeding without one.
- Migration 2 is left exactly as written — it is already applied, and editing
  applied history desynchronises the code from disk. Migration 3 onward uses
  create-copy-drop-rename; the pattern and its two footguns are documented at
  the top of `migrations.ts` and exercised in `migrate.test.ts`.

**Historical archive (Tier 1) — download path shipped.** User-triggered from
the archive panel, never automatic: ~295k events and a few minutes of requests
is not something to start on someone's behalf.

- Chunked by **calendar year**, oldest first. Boundaries are fixed years
  because resume works by recording which chunks finished, so the plan has to
  come out identical every run. Measured: the busiest year at M4.5+ is 2011 at
  9,584 events, against FDSN's 20,000 page cap — so a year is one request, and
  the paging loop is defensive rather than routine.
- The **current year is never recorded complete**, because it isn't. It is
  refetched each run, which also fills the gap between January 1 and the
  rolling cache's 30-day window.
- `pruneEarthquakesBefore` now keeps everything at or above the archive floor.
  It pruned on time alone, which would have deleted the entire archive on the
  next launch and reported success.
- Verified against the live service, not just mocks: per-year stored counts
  match USGS's own `count` endpoint exactly for 1970–1975.

**Archive browsing — shipped.** `ARCHIVE_SPANS` in `packages/schema`, offered
as their own "History" group in `RangeControls`.

The design in one line: **every view is sized to the same mark budget**, and
the existing floor-auto-raise enforces it. Measured entity build / query cost
against the real 306k-row database:

| view | marks | build | query |
|---|---|---|---|
| 30d/M2.5 (live, was already shipping) | 7,671 | 110 ms | 19 ms |
| 1y/M4.5 | 8,485 | 161 ms | 21 ms |
| 10y/M5.5 | 4,604 | ~120 ms | 26 ms |
| all/M5.5 | 26,746 | 590 ms | 107 ms |
| all/M7 | 781 | 11 ms | 27 ms |

And the two deliberately not offered: 5y/M4.5 is 38,538 marks at 827 ms, and
all/M4.5 (294,648) is a **V8 out-of-memory crash**, not merely slow. That is
why the M4.5–5.5 band is capped at one year.

**Clustering is NOT a prerequisite, and an earlier note here said it was.**
The intuition that deep history is the expensive view is backwards: M7+ across
all 57 years is **781** marks, a tenth of the live view.

What went in:

- `ARCHIVE_SPANS` is **separate from `COVERAGE_TIERS` and ingest never reads
  it** — a 57-year entry in the shared constant would re-download the archive
  on every launch. Guarded by a test, not just a comment.
- M6.0/M7.0 added to `MAGNITUDE_FLOORS` (USGS class boundaries; M6.5 stays out
  — it is a round number with no class on it).
- **The emphasis ring stays a fixed M5.5+, on every view.** A floor-relative
  version was built and reverted: it halved the entity count in archive views
  (26,746 marks each carrying a ring is most of that view's 590 ms build), but
  M5.5 means the same thing on every screen, and "is this a big one?" doesn't
  change because the surrounding view narrowed. The entity cost is the price of
  a consistent encoding. Don't re-propose it as an optimisation without saying
  so out loud — it's a deliberate trade, not an oversight.
- A **trailing window**: what `isolateBand` is to magnitude, applied to time.
  Its length is `previousWindowHours` — one step down the same ladder — so the
  trail is a decade inside the all-years view and a year inside the decade.
  It rides `setTimeWindow`, the cheap channel, so it does not rebuild entities
  as the playhead moves.
- `load()` **queries by span and floor** instead of loading a fixed widest
  range and narrowing in memory. The old design could not survive the archive:
  "load the widest range" over 57 years is an OOM, not a slow render.
- **Archive spans toggle; live tiers don't.** Clicking the active span returns
  to the live view you came from — window, floor and trailing flag together,
  since entering the archive changes all three. Without it the History buttons
  were a one-way door. The asymmetry is deliberate: a live tier switched "off"
  has nothing to fall back to, because the globe always shows *some* window.

**Observed aftershock sequences — shipped** (§5.9's Explore-safe half). In the
inspector for any event M5.0+: what the catalogue actually recorded inside a
Gardner-Knopoff window. The *forecast* half stays in Phase 4.

- **Gardner-Knopoff windows are reused, not invented.** GK is already the
  declustering standard (non-negotiable #2), so the events this panel calls
  aftershocks are exactly the ones Phase 4 will remove as dependent. The fits
  were checked against GK's published Table 1 before use — M6.0 → 53.2 km vs 54
  tabulated, M7.0 → 918 d vs 915.
- **The time window steps *down* 45.8 days at M6.5** and that is deliberate.
  It's in the published piecewise form. The obvious fix — take the larger branch
  — restores monotonicity and then gives **20,946 days at M9**, 57 years, which
  would swallow the whole archive. Don't "fix" it without reading the note on
  `gardnerKnopoffWindowDays`; there's a test pinning the step.
- **The strip plots events/day, not counts, and this was a real correction
  caught on real data.** Log-spaced bins are unequal — 1 day for the first,
  ~890 for the last — so raw counts show bin width and run *backwards*. Tohoku's
  counts are [182, 236, 204, 223, 289], which reads as aftershocks becoming more
  frequent. As a rate: [182, 39.3, 8.9, 1.5, 0.32]/day, textbook Omori. Nothing
  is fitted — a curve through those bars would be Analyze's job.
- **Counted at M4.5+ whatever the view's floor is**, because that's the one level
  uniform across the whole database, so 1985 and 2026 sequences are comparable.
  It therefore disagrees with the globe on purpose; the floor is always printed
  beside the count.
- **A zero from an undownloaded archive is indistinguishable from a real zero**,
  so the query returns the uncovered years and the panel says "lower bound".
  Coverage counts the rolling cache and the always-refetched current year, so no
  archive is needed for a recent event.
- **Foreshocks are flagged, not folded in.** When something bigger followed, the
  window was sized to the wrong magnitude and the panel's subject is wrong.
  Verified on real data: the 2011-03-09 M7.3 correctly reports the M9.1 after it.
- Stale IPC replies are made **unrenderable** rather than unlikely — results are
  stored against the id they describe. Clicking through a cluster fires
  overlapping requests with no ordering guarantee, and the failure mode is one
  event's sequence under another's heading, looking entirely normal.
- Costs, real catalogue: median 0.7 ms at M5, 9.6 ms at M7, 88 ms worst at M8+.

**Fault association — shipped** (§5.10). Nearest mapped GEM fault, its name,
slip rate and kinematics — in the inspector for a selected event, and via a
**fault probe** mode that answers for any clicked point.

- **The reason it exists: "recurrence interval" was two different quantities.**
  "The southern San Andreas is overdue" is *paleoseismology* — trenching, ~10–14
  ruptures over millennia. "M6+ here occurred 29 times since 1970" is the
  *instrumental catalogue*. **The 57-year archive can never say whether anywhere
  is overdue**; that's an §11-class limit, not a matter of effort. Recurrence is
  also a property of a fault, not of a circle — hence association, not a radius.
- **Slip rate is shown; recurrence is NOT derived from it.** Converting mm/yr to
  years needs a characteristic slip per event, i.e. magnitude-scaling relations
  — model output with assumptions, which belongs in Analyze, not beside
  observations. Don't "finish the job" by dividing without reading §5.10.
- **"No useful association" is the common case and the panel is built around
  that.** Measured: the median M6+ event is **42.9 km** from any mapped trace,
  only 20% are within 10 km, and only 21% of nearest traces are *named*. Deep
  events are worse (median 78.1 km) because subduction geometry puts the surface
  trace far inboard — they get an explicit caveat. Beyond 150 km it names
  nothing. A panel written around the Parkfield example looks broken in the field.
- **It never claims the event was on the fault** — reports trace and distance,
  lets the reader judge. Epicentres carry location error; GEM maps surface
  traces while ruptures happen at depth.
- Vendor script keeps 4 of GEM's ~20 columns: +59 bytes/feature, 2.5→3.16 MB.
  **263 `net_slip_rate` values are the literal string `"None"`** — Python's None
  serialised, and truthy — so the parser rejects rather than coerces.
- **The JSON grew past what TypeScript will infer.** Heterogeneous shapes at
  3.16 MB make the imported literal type stop resolving: `tsc` still passes but
  type-aware lint rules see an unresolvable type and every property read errors.
  `data/active-faults.ts` asserts the shape once; nothing else imports the JSON
  directly. Watch for this on any other vendored dataset that grows.
- Brute force over 157,548 vertices at 1.1 ms — no spatial index, deliberately.

**Next: instrumental recurrence on the archive** — the honest half of the
original goal, now that §5.10 has drawn the line around what it can claim.
The Gardner-Knopoff module is the missing prerequisite, in place.
Measured first: raw M6+ gaps near Tokyo have a 0.06 y median against 0.32 y
declustered, so **declustering is not optional for a rate claim** (non-negotiable
#2 says so anyway). The squeeze is real and needs designing around, not ignoring
— at M7+ declustering barely matters but n collapses to 3–6 events per region
(LA M7+ within 500 km: n=4; Kathmandu: n=3, mean 4.85 y vs median 9.66 y). Any
interval must show n and the spread, and probably refuse to state one below some
n.

**Large-event alerts — shipped** (`PROJECT_PLAN` §5.8), out of Phase 3 order
because they need no new data source, only the existing poll.

- **Sourced from what a poll or refresh *fetched*, never from a query over
  stored events.** That is what makes the launch backfill structurally
  incapable of firing alerts, rather than something guarded against. The
  scanning alternative has to actively defend against announcing every large
  event of the past month on startup.
- **Tracks *alerted* ids, not *seen* ones.** USGS revises magnitudes, so an
  M5.8 that arrives below the bar must still be eligible when it comes back as
  M6.1. Recording everything seen would swallow exactly those events.
- One hour freshness bound, stateless — it handles the first poll after launch
  pulling a 24-hour feed, without a "have we polled yet" flag to get wrong.
  **The consequence: an event older than an hour never alerts.** That gap is
  covered by the launch digest below, not by widening the bound.
- **The poll fires once immediately at launch, not after the first interval.**
  It used to be `setInterval` only, so the first poll — and therefore the first
  possible alert — was five minutes late, while the event itself was already
  drawn on the globe by backfill.
- Threshold is **M5.8**, chosen by frequency: measured 485/year at M5.5 (1.3 a
  day, into ignore-it territory), 233/year at M5.8, 139/year at M6. Deliberately
  *not* a USGS class boundary, unlike `MAGNITUDE_FLOORS` — those encode
  detection completeness, this encodes how often a person wants interrupting,
  and a preference is allowed to sit between the boundaries.
- **Alerts never move the camera on their own.** The `focusRequest` nonce stays
  the only thing that moves it; the banner is click-to-fly.
- **Early warning is off the table** — not hard, impossible from this input.
  Measured USGS first-publish lag is 78 s min / 222 s median; the S-wave has
  covered ~270–780 km by then. Recorded in §11.

**"While you were away" digest — shipped.** The passive counterpart to the
alert: no freshness bound, covers however long the app was shut, shown once per
launch and clickable to fly to an event.

- Backed by `app_state` (migration 5), a two-column key-value table holding one
  `seen_through_utc` watermark.
- **The watermark advances on every successful poll, not on quit.** A crash then
  costs one poll interval instead of replaying a whole session as "missed" —
  and this feature exists precisely for people who weren't there to quit tidily.
- **Ordered by magnitude, not time, and that is load-bearing.** The list is
  capped at 10; a chronological cap could hide an M7.5 behind ten M5.9s, which
  is the one thing a digest must never do. Sorting by size means the cap only
  ever trims the least interesting end.
- **`collectMissedEvents` must run before polling starts.** The first poll fires
  immediately and moves the watermark, so reading it afterwards compares now
  against now and reports an empty absence on every launch. There is a test
  named for exactly this.

**Planned, not built:** aftershock *forecasting* (§5.9, Phase 4) — the model
half. The observed-sequence half shipped; see below.

**Event list — shipped.** A collapsible top-right panel listing exactly what the
globe is drawing, click-to-fly, sortable by time or magnitude.

- Reads `useEarthquakesUpToPlayhead()` — the same projection the legend's count
  uses — so the list, the count and the marks **cannot** disagree. It follows
  the floor, window, band isolation, playhead and trailing window without
  knowing any of them exist.
- **Windowed, not capped.** Only the ~26 visible rows exist as DOM nodes, with a
  full-height spacer so the scrollbar still describes the whole list. 30d/M2.5
  is 7,900 rows and the all-years archive view is 26,746 — a cap would hide most
  of the catalogue and make the scrollbar lie. `event-list-window.ts` is pure
  and tested.
- Two bugs it produced, both worth remembering:
  - A shrinking list left the slice start past its end, so `slice` returned
    nothing — a blank panel with a working scrollbar. Clamp `first` at **both**
    ends.
  - The `ResizeObserver` was bound in an effect keyed on `open`, so when the
    scroller unmounted for an empty list and came back, the observer was still
    watching a detached node and the measured height stayed 0 — blank again,
    healed only by closing and reopening. **Bind observers with a ref callback,
    not an effect**, and don't conditionally unmount a measured element.
    `visibleRange` also now falls back to a screenful when height is 0: the
    failure mode should be "too many rows", never "none".

### Panel placement

**Panels describe themselves; a column positions them.** `App.module.css` owns
`.leftColumn` (range controls + archive) and `.rightColumn` (event list +
legend); the panels carry no `position: absolute`.

This is not tidiness. Both columns hold a panel whose height changes at runtime
— the range controls gain and lose floors and notes, the legend gains and loses
whole sections as layers toggle — so any `top` offset or `max-height` on a
neighbour is a guess that goes wrong on the next toggle or resize. In a column,
overlap is unreachable: `min-height: 0` lets the flexible panel shrink instead.
The wrapper takes `pointer-events: none` and gives it back on children, or its
gap swallows globe drags.

Cesium's `homeButton` is off, like every other default widget. It was the only
camera reset — if that becomes annoying, add one to our own chrome where we
control placement rather than turning it back on.

### Known gaps

- ~~`INGEST_WINDOW_MS` is 4 days while the UI offers 30d~~ — fixed by archive
  browsing. `load()` now queries the selected span and floor directly, so the
  constant is gone rather than corrected.
- **`COVERAGE_TIERS` is shared with ingest.** Archive view spans live in
  `ARCHIVE_SPANS` and must stay there: main loops `COVERAGE_TIERS` to decide
  what to fetch on launch, so a 57-year entry would try to refetch the whole
  archive every start. `coverage.test.ts` asserts the separation.
- **Marker clustering** is still unbuilt, and is now only needed for the dense
  M4.5+ multi-year spans the selector deliberately doesn't offer.

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
- **The archive changed the cost of queries that were never touched.** Adding
  ~295k rows to the shared `earthquakes` table made a 30-day-sized assumption
  false everywhere at once, and the symptom was "`pnpm dev` takes forever", not
  an error. Two found by measuring against the real 306k-row database:
  - `findCandidateMatches` bound only `source`, so SQLite planned it as
    `SEARCH ... USING INDEX idx_earthquakes_source_time (source=?)` — every row
    of that source — and filtered spatially afterwards. 1.25 s per call, once
    per EMSC candidate during backfill: **63 minutes** for a 3,000-candidate
    pass. Adding the time bound the predicate already implied uses the same
    index as `(source=? AND time_utc>? AND time_utc<?)`: **0.2 ms**, 6,431×.
  - `earthquakes:refresh` returned `queryEarthquakes(db, {})` — the whole
    catalogue — which the renderer discarded, because the store re-queries with
    its own window. 1.25 s plus a ~100 MB structured clone per Refresh press.
  - `insertEarthquakes` upserted row-by-row with **no transaction**, so every
    event paid its own durability flush. 7,000 upserts: **66 s** loose, **0.3 s**
    wrapped — 216×. It uses `SAVEPOINT`, not `BEGIN`, so it nests inside a
    caller's transaction instead of throwing.
  - `catalogSignature` planned as `SCAN earthquakes` — all 306k rows — twice
    per poll, forever. Scoped to the live window it uses the time index: 68.7 ms
    → 5.0 ms. Scoping is also *more correct*: the archive is immutable once
    downloaded, so counting it meant a finished download flipped the signature
    and rebuilt the globe layer, destroying the selection, over events nowhere
    near the window on screen.
- **The archive is never *loaded* at startup, and never was.** The renderer
  asks for its window and gets it in 1.6 ms. Every symptom above came from
  queries that *scanned* the table without needing to. When something gets slow
  after the archive lands, look for a missing bound, not for loading.
- **Nothing on the startup path may wait on the network.** `main` used to
  `await backfillEarthquakes(db)` *before* `createWindow()`, making
  time-to-first-pixel the cost of two live FDSN queries plus their inserts.
  It also fails badly: with USGS slow or unreachable, an app that could have
  shown the whole local catalogue showed nothing. The window now comes up
  first and backfill notifies the renderer when it lands. The database already
  holds the last run's data — backfill is a refresh, not a prerequisite.
- **A composite index only narrows on the columns you actually bind.**
  `(source, time_utc)` with only `source` bound is a full scan of that source
  wearing the word "INDEX" in the query plan. `EXPLAIN QUERY PLAN` against real
  data volumes is the check; the plan *looked* fine at 30 days because the
  scan was small, not because it was avoided.
- **Go to the real service before believing it works.** The archive passed a
  full mocked suite and then failed on its first live run: USGS reports **null
  depth** on a few pre-1980 events (4 in ~48,500 sampled, all before 1980) and
  `depth_km` was `NOT NULL`. Nothing in a fixture was ever going to surface
  that. Migration 4 makes depth nullable — the first real use of
  create-copy-drop-rename — and `UNKNOWN_DEPTH_COLOR` is its own off-ramp
  colour, because 0 km would have been a claim USGS never made.
- **The free perceptual room isn't always where you'd guess.** The unknown-depth
  swatch had to clear ΔE 15 from a 5-step blue ramp on *both* basemaps. Every
  obvious light grey failed on the dark basemap — that ramp runs pale, so its
  top step is already in the light-neutral region (#d6d3d1 landed at ΔE 5.8).
  The room was *below* the ramp: #78716c, ΔE 16.3 on both. Also the one mark
  that does **not** flip per basemap, because it isn't on the ordinal ramp.
- **Transactional DDL was verified, not assumed.** The create-copy-drop-rename
  pattern depends on a failed migration rolling back its schema changes. That
  holds in SQLite even for R-Tree virtual tables and their shadow tables —
  which was the doubtful case, and is now a test rather than a belief.
- **Fake viewers in tests must really destroy.** A mock `remove()` that only
  recorded the call let a crash-on-unmount ship: Cesium's real `remove()`
  destroys, and destroying exposed a shared-material bug.
- **`pnpm build` was broken and `pnpm dev` could never have told us.**
  `vite-plugin-cesium` computed its output as `path.join(root, outDir)`, and
  electron-vite passes an *absolute* `outDir` — `path.join` doesn't absorb one,
  only `path.resolve` does. Windows rejected the resulting `src\renderer\C:\…`
  outright; **on macOS and Linux the same join is merely wrong**, so the build
  succeeds having copied 7.9 MB of Cesium workers somewhere nothing reads, and
  the app launches with a broken globe. Replaced with a small local plugin
  (`electron.vite.config.ts`) that stages the assets into the renderer's
  `public/`, which is Vite's own "serve these bytes untouched" mechanism and
  needs to know nothing about the output directory.
- **Cesium is now bundled rather than loaded from a global.** The old plugin
  marked it external for builds and injected a `<script>` tag while leaving dev
  to import it as a module — two different loading paths, only one of which was
  ever exercised. The renderer chunk is 13 MB as a result, which for an app
  loading off local disk costs nothing worth the divergence.
- **`ELECTRON_RUN_AS_NODE=1` makes Electron a liar.** Set in the environment, it
  runs the binary as plain Node: `require('electron')` returns the npm shim's
  *path string* and ESM named imports fail with "does not provide an export
  named 'BrowserWindow'". Both look exactly like a broken main process and are
  not. Verify with `env -u ELECTRON_RUN_AS_NODE` before believing either. The
  ESM main process is fine — checked by running the built app.

- **Tile servers must be told who we are.** Zooming the OSM basemap filled the
  globe with "403 Access blocked — App is not following the tile usage policy".
  Nothing was wrong with the request *rate*; the requests were anonymous. OSM's
  policy requires "a clear, unique User-Agent string that names your app" and
  explicitly rejects "a library's generic default", which is what stock Electron
  sends — and the packaged app loads from `file://`, so there is no Referer
  either. `main/tile-identity.ts` attaches
  `TerraPulse/<version> (+repo url)` to tile hosts only. Verified against the
  live server: identical URL, same second, generic UA returns the block image
  and ours returns the map.
  - **The block image is served with HTTP 200**, with "403" drawn *into the
    picture*. Cesium cannot detect it as an error and renders it as a valid
    tile — which is why it appeared as blocks rather than a load failure. The
    tell in the headers is `cache-control: no-cache` against a real tile's
    `max-age`.
  - It must be set in **main**: `User-Agent` is a forbidden header for renderer
    `fetch`/XHR, and Cesium builds these requests internally anyway.
  - Scoped to tile hosts rather than set globally, and matched on a dot
    boundary so `tile.openstreetmap.org.evil.com` doesn't collect our identity.

### Packaging

`pnpm --filter @terra-pulse/desktop package` → `apps/desktop/release/`:
a **105 MB NSIS installer** plus a `win-unpacked/` folder with a runnable
`Terra Pulse.exe`. Config in `electron-builder.yml`. Windows x64 only so far.

- **`- '!node_modules/**'` in `files` is load-bearing.** electron-builder adds
  everything in `dependencies` *on top of* whatever `files` lists, so listing
  `out/**` alone excluded nothing: the first build shipped a **146 MB** asar
  containing 3,863 files of `node_modules/@cesium`, all of it already compiled
  into `out/renderer`. With the negation the asar is 20.5 MB.
- **`dotenv` is bundled, not externalized** (`externalizeDeps.exclude`), which is
  what makes the above possible — `out/` then has no runtime node_modules
  dependency at all, only Node built-ins Electron supplies.
- `build/icon.png` is a **placeholder**, generated by
  `scripts/make-placeholder-icon.mjs` in pure Node. Replace with a real
  1024×1024 design; nothing else changes. electron-builder derives the `.ico`.
- **Unsigned**, so SmartScreen warns on first run. Signing needs a paid
  certificate and is a distribution problem, not a build one.
- **macOS cannot be built from here** — `.dmg` and signing need macOS tooling.
  A `macos-latest` CI runner is the usual answer.
- Packaged `dotenv` looks for a `.env` beside the executable and finds none. It
  degrades quietly (injects 0 vars) rather than throwing, but any API key the
  app grows will need a different mechanism than `.env` when packaged.
- **`viewer.dataSources.add()` is asynchronous, and anything that *reads*
  `viewer.dataSources` in the same commit will miss what was just added.** This
  shipped as a real bug: on every poll and every manual Refresh, the selection
  reticle vanished while the inspector stayed open. The layer rebuild removes
  the old data source synchronously and attaches the new one a microtask later,
  so the selection effect ran in the gap, found nothing, and cleared
  `selectedEntity` — then never re-ran. The store was right the whole time;
  only Cesium's view of the selection was lost, which is exactly why the panel
  and the reticle disagreed. Fixed by subscribing to `dataSourceAdded` rather
  than resolving once per commit (`selection-sync.ts`). Any future code that
  looks up an entity by id needs the same treatment — a one-shot lookup is a
  race, not a lookup.
- **An idle queue is not a finished queue.** The data layers wait for the globe
  to paint, gated on Cesium's `tileLoadProgressEvent`. Both obvious readings of
  "done" are wrong at startup: `globe.tilesLoaded` is `true` on a fresh viewer
  and the queue count is `0`, because nothing has been *requested* yet — Cesium
  queues on its next render frame. So the gate opened instantly and the
  earthquake dots mounted against an empty planet. `first-paint.ts` requires the
  queue to have filled before an empty queue counts, latches so a basemap switch
  can't blink the layers out, and keeps a timeout fallback so an offline basemap
  can't hold the data hostage.
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
