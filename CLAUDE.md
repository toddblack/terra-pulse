# CLAUDE.md — Terra Pulse

Working context for Claude Code. Read `PROJECT_PLAN.md` for the full
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
  *instrumental catalogue*. **Neither tier of the archive can say whether
  anywhere is overdue** — 57 years below M7.5, 126 at or above it, against a
  southern San Andreas recurrence of ~150–200 years. That's an §11-class limit,
  not a matter of effort. Recurrence is also a property of a fault, not of a
  circle — hence association, not a radius.
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

**Hover identification + one location panel — shipped.** Hovering a quake, fault
or plate boundary shows a tooltip and a pointer cursor; clicking a fault or
boundary opens the location panel.

- **`setInputAction` stores ONE action per event type.** Hover and drag-deselect
  both want `MOUSE_MOVE`; registering separately left only the last one, with no
  error — one feature simply never fires. They are a single handler now.
- **The fault probe and the geology inspector were merged.** They repeated each
  other's fault section and answered the same underlying question from two entry
  points. One `LocationSelection` slot now carries a coordinate plus what was
  clicked (`fault` | `boundary` | `point`), and one panel renders all three.
- **Probe mode survived the merge on purpose.** It is the only way to ask about a
  point with no drawn line or earthquake under it — "how often do M6+ happen near
  Seattle". Deleting it would have quietly removed the original archive goal. It
  stays a *mode* because a bare-globe click already means "deselect".
- **A selected fault/boundary/probe point gets the *same* bracket reticle as a
  quake, in a different colour** — amber GEM, violet PB2002, near-white for a
  bare probed point. A selection should look like a selection; only the *kind*
  differs, so only the colour does. Drawn as a billboard in
  `location-highlight.ts` rather than reusing Cesium's indicator, because
  `viewer.selectedEntity` already carries the earthquake selection and a fault is
  a batched `Polyline` with no entity to assign — and because both can then be
  marked at once. Clicking geology also clears `viewer.selectedEntity`, since
  Cesium's own left-click handler sets it for any entity it picks.
  - **Two versions were rejected before this one, both by the user:** a glow
    along the feature's whole trace (reads as restyling the line, and a long
    boundary lights up half the globe) and a cased ring (legible, but not the
    established selection language). The ask was "the same selector, another
    colour" — take that literally.

- **The reticle used to vanish ~30 s after selecting a boundary, and the cause
  was a stale dependency.** `useNow` ticks every 30 s → `nowMs` changes →
  `useVisibleEarthquakes` returns a new array identity → the selection-sync
  effect re-ran (it listed `events`) → it re-applied the *store's* selection over
  whatever Cesium had set, clearing the boundary. `events` was only ever there to
  survive layer rebuilds, which the `dataSourceAdded` subscription already
  handles properly. **Anything keyed on `events` re-runs on a 30 s timer** — that
  *was* the tell for this whole class of bug; the timer itself is now gone, see
  "The 30-second rebuild" below.
- **The coordinate is always where the pointer was, never the feature's
  centroid** — recurrence for the middle of a 500 km trace answers for somewhere
  the user never clicked.
- Leaving probe mode clears a probed *point* but keeps a clicked feature: a point
  can't be refreshed with the mode off, a clicked fault doesn't need to be.

**The deep tier needs a view, not just a download** — and the first attempt at
that view cost more than it was worth.

- **`ARCHIVE_SPANS`' widest view was 100 years**, sized when the archive started
  at 1970. From 2026 that reaches 1926, so **91 events** — including the 1906 San
  Francisco M7.9 and the 1906 Ecuador-Colombia M8.8 — sat in the database with no
  view able to draw them. **`all` is now 130 years**, which covers the whole
  archive (earliest event 1900-01-31) and costs 262 extra marks: 27,029 at M5.5,
  against 26,746 before.
- **A separate `1900+` span at M7.5 was built first, then removed.** It needed
  M7.5 in `MAGNITUDE_FLOORS`, which meant a seventh floor button, which widened
  the *entire left column* — `.leftColumn` is `width: max-content`, so its widest
  child sizes Magnitude, Window, History, Archive and Probe together. One span
  that genuinely covers everything beat a second button.
  - **Any new magnitude floor pays that column-width tax.** The floor row has no
    `flex-wrap`, so it cannot absorb an extra button.
  - M7.5 remains in `RECURRENCE_FLOORS` — different selector, different panel,
    and there it genuinely changes the answer by moving the epoch to 1900.
- **`all` now spans two floors' worth of record, so it says so.** Pre-1970 holds
  only the M7.5+ deep tier: 262 marks against 26,767 after. Unlabelled, a
  scrubber playback reads as seismicity exploding in 1970. `RangeControls` shows
  `before 1970: M7.5+ only` as a *warning*, not a note, whenever the window
  reaches past `ARCHIVE_START_YEAR`.
- **The archive panel's copy was hardcoded to 1970** and reported "1970–present"
  over a fully-downloaded deep tier, which read as the download having failed.
  It names `DEEP_ARCHIVE_START_YEAR` now.

**Antipode rings on the globe — shipped** (§5.3). Entering antipode mode now
also draws 250/500/1000 km rings at the far end and marks any in-window hit with
its magnitude and delay.

- **The rings carry no statistical meaning and the code says so twice.** §5.3
  keeps the registered test radius-free precisely so no constant has to be
  guessed; these exist so a human can see "that one landed inside 250 km"
  without measuring. Don't let them harden into a threshold.
- Hits are **amber, not the chord's red** — red already means "this is the thing
  being drawn", and a hit is a different kind of object. Keeping them distinct
  stops a marker reading as an endpoint of the chord.
- Drawn as `ellipse` rather than polylines so they follow the curve; a 1000 km
  circle is wide enough that a chord across it shows at grazing angles.
- **`EMPTY_HITS` is a module constant, not `[]` inline.** The hits arrive from an
  async lookup, and a fresh array each render is a new identity — which would
  re-run the layer effect, rebuild the chord and restart its animation on every
  render while the request was in flight.

**Antipodal window — shipped** (§5.3, the observational half of **H5**). In the
inspector for any M6+ event: what the catalogue recorded within 1000 km of its
antipode in the registered 72 h window — distance, delay, magnitude.

- **The background rate ships with every answer and is the whole point.** A bare
  list of hits near an antipode is a coincidence generator. The prompting case: a
  Colombia M7.4 followed 4.6 h later by a Sumatra M5.1 just **197 km** from its
  antipode. Striking — until you see that this patch of Sumatra produces an M5+
  **every 8 days anyway** at that radius. So the panel prints the rate *before*
  the result, with equal weight.
- **Measured across the 14 most recent M7+ triggers, the confounder is total.**
  All 3 that produced any hit were South America → Indonesia. Every other
  antipode has a background of hundreds to tens of thousands of days: Mexico 940,
  Philippines 6,892, Japan **20,676** (one per 57 years), Tonga silent. The
  apparent "signal" is entirely that South America and Indonesia are both highly
  seismic *and* antipodal to each other. Nothing will ever be found opposite
  Japan because the South Atlantic is empty.
- **`backgroundSilent` exists for that case.** ~36% of M6+ antipodes have had *no*
  M5+ within 500 km since 1970, so an empty window there says nothing at all —
  sparse instrument coverage and real quiet are indistinguishable. The panel says
  so rather than presenting absence as a finding.
- **No probability is printed.** A rate is descriptive; "p = 0.03" would be a
  significance claim (non-negotiable #1). The registered H5 test — declustered,
  completeness-weighted, KS against the null — stays an Analyze job.
- **`ANTIPODAL_WINDOW_HOURS` is 72 and must not be shortened to 24** because a
  suggestive case happened to land at 4.6 h. H5 was registered 2026-07-24 at
  0–72 h; changing it now is exactly the free-parameter-after-the-fact that
  non-negotiable #3 forbids. A 24 h variant is defensible *a priori* — surface
  waves cross in ~2–3 h — but it must be registered as a *second* hypothesis and
  paid for in the FDR denominator. Pinned by a test.
- `normalizeLongitude` short-circuits in-range values and `antipodeOf` uses a
  single half-turn shift, because the modulo route drifted ~1e-14° on real
  coordinates. Exact round-tripping isn't achievable in floating point and isn't
  required — that's a nanometre — so the test asserts closeness, not equality.

**Observed recurrence intervals — shipped** (§5.11). "How often do independent
earthquakes happen here", from the catalogue. In the inspector and the fault
probe, with radius (100–500 km) and floor (M5.5–M7) selectors.

- **Declustering is mandatory and is most of the answer.** A recurrence interval
  is a rate claim (non-negotiable #2). Measured at Tokyo 300 km: **448 raw M5.5+
  become 218 independent**; the M6+ median gap goes 0.06 y → 0.32 y. The raw
  number isn't noisier, it answers a different question. Both counts are always
  shown so the removal is visible.
- **Floors never go below M5.5.** It's the only level flat since 1970 — M4.5+
  rose ~3× on network growth, which would shorten intervals through the record
  for purely instrumental reasons. Don't add a lower floor to "get more data".
- **Three refusals, each guarding a specific error:**
  - Below **8 intervals** no median is printed — Kathmandu M7+ gives 2 intervals
    with mean 4.85 y and median 9.66 y. Raw gaps are listed instead. Verified:
    Istanbul and Kathmandu land on 7 at the defaults and correctly withhold.
  - An **incomplete archive blocks the summary entirely** — a hole merges two
    real gaps into one longer false one, always erring toward "rarer than it is",
    and looks exactly like a complete answer.
  - **"Since the last" is labelled elapsed time, not a countdown.** It's the one
    number a reader will turn into "so we're due".
- **Zero is a real answer** — Denver has no independent M5.5+ within 500 km since
  1970, and the panel says so in those terms rather than looking broken.
- `declusterGardnerKnopoff` sweeps **largest-first**, and an event already
  designated independent can never be demoted. Without that guard a small early
  shock whose window happens to reach a much larger later one could claim it —
  deleting the very event a recurrence count cares most about.
- Cost: 32–294 ms real catalogue; worst case (500 km, M5.5, 783 raw) 197 ms.
  O(n²) declustering dominates — fine on a click, not on a drag.

**Deep archive tier — M7.5+ back to 1900 — shipped.** A second tier beneath the
M4.5+/1970 one, so the very largest events get a 126-year record instead of 57.

- **1900 is a hard floor and no source fixes it.** Measured M7.5+ per decade:
  0–3 through the 1890s, then 40 in 1900–10 and 20–58 flat after. That step is
  instrumental seismology arriving. USGS lists **15** M7.5+ events for all of
  1500–1900 — 6 North America, 9 mostly Caribbean, **none** in Japan, China, the
  Mediterranean or South America, which all have written records of huge quakes.
  Adding NOAA significant-events or regional historical catalogues would fill
  those gaps *unevenly* and turn a uniformly short record into a regionally
  biased one — worse for a rate. Pre-1900 may be worth showing; never counting.
- **No external catalogue needed: USGS already serves ISC-GEM.** Of 262 M7.5+
  events for 1900–1970, 222 are `iscgem` + 9 `iscgemsup`, and 252 carry `mw`.
  Verified live for 1960–64: 19 events, all `mw`, no null depths, including
  Valdivia 1960 (M9.5) and Alaska 1964 (M9.2).
- **`completeSinceYear(floor)` is the load-bearing piece** — 1900 at M7.5+, 1970
  below. Assuming 1900 at M6 would count seven near-empty decades as observation
  and inflate every interval through them. `recurrenceEpochYear` wraps it and the
  panel prints the epoch, because it moves when the floor moves.
- Both tiers share `archive_chunks` and never overlap (deep stops at 1969);
  `completedArchiveYears(db, floor)` keeps them apart via `min_magnitude <=
  floor`. Deep runs first — 262 events vs ~295,000, so the cheap work lands first.
- **Measured payoff at Tokyo:** M7.5+ within 500 km goes from **4 events since
  1970 (median withheld) to 17 since 1900** — 16 intervals, comfortably above the
  threshold. Per era: 4/8/2/3 across 1900-30/30-60/60-90/90-now, so the long
  record is what makes the busy mid-century visible at all.

**Plate-boundary context — shipped.** The recurrence panel names which boundaries
the region's events sit on, ranked, with the PB2002 class ("mostly a subduction
zone").

- **It reports rather than filters, and that was a measured reversal.** The
  intuitive design — restrict the query to the nearest boundary — **destroys the
  sample**: of Tokyo's 17 M7.5+ events, only **3** lie within 100 km of the
  boundary nearest the city (`OK-PS`). Ten are on the Japan Trench (`PA\OK`),
  the rest spread over three more pairs, because Tokyo is a **triple junction**
  and the closest boundary is not the seismogenic one. Wellington is worse: its
  nearest boundary is 9 km away and **none** of its events are within 100 km.
- Filtering on "near *any* boundary" fails the other way — 16 of Tokyo's 17
  survive it, so it costs complexity and removes nothing. In a subduction zone a
  circle already *is* a corridor.
- Don't re-propose the corridor filter without re-reading this; it looks obviously
  right and the data says otherwise.
- **Subduction polarity is deliberately not decoded.** PB2002's `/` and `\`
  encode which plate subducts; getting it backwards would be a confident false
  claim, and the class field already says the boundary type. Labels are
  "Pacific–Okhotsk", never "Pacific under Okhotsk". Test pins it.
- A test asserts every plate code in the real dataset has a name, so a PB2002
  revision can't silently surface bare two-letter codes in the panel.

**The 30-second rebuild — fixed.** Found by the user noticing the selection
reticle "pulse as if it were a new selection about every 30 seconds". It was: the
whole earthquake layer was being destroyed and rebuilt twice a minute, forever,
and the reticle replaying its appear animation was the only visible symptom.

The chain, which is worth being able to recognise again: `useNow` ticks →
`useVisibleEarthquakes`' memo lists `nowMs` → the filtered array gets a **new
identity** even though its contents are almost always identical → the
event-driven overlay effect in `useGlobeLayers` is keyed on `events` → teardown
and rebuild → `dataSources.add` → `dataSourceAdded` → `watchSelection` re-applies
the selection to a brand-new entity → Cesium's `SelectionIndicator` animates.
Cost per rebuild, from the numbers already measured in this file: **110 ms at
30d/M2.5, 590 ms in the widest archive view** — the latter a visible hitch, on a
timer, with nothing on screen having changed.

- **The built set no longer reads a clock at all.** Its cutoff is
  `loadedWindowStartMs`, captured by `loadForCurrentView` at the instant it
  queried, so the array's identity changes when the *data* changes and at no
  other time. A quiet poll already skips `load()` (`result.changed`), so during a
  quiet stretch the layer now rebuilds **zero** times rather than 120 an hour.
- **The displayed edge still moves continuously**, through `setTimeWindow` →
  `applyVisibility`, which flips `show` flags instead of rebuilding. That split —
  built set stable, window live — was always the documented design; the clock in
  the memo had been quietly undoing it.
- The built set therefore keeps a few events that have aged past the window
  between loads. They are hidden, not drawn, so this is invisible; the trade is
  a handful of dormant entities against a full rebuild twice a minute.
- **`useEarthquakesUpToPlayhead` took over the live trailing edge**, which it had
  been inheriting. Without that the event list and the legend's count would have
  kept events the globe had already hidden — breaking "the list, the count and
  the marks cannot disagree", which is the reason that projection exists.
- **`displayWindow` is now the single definition of the visible span**, shared by
  the viewer's `setTimeWindow` and that projection. They were separate
  expressions that happened to match, and one of them was about to stop matching.
  Tests assert the two callers agree on `startMs` across live/playhead/trailing.
- **`useNow` was seven `setInterval`s, one per call site.** Seven timers at seven
  arbitrary phases woke the app every ~4 s in staggered bursts. It is one shared
  ticker behind `useSyncExternalStore` now, so every consumer also sees the
  *same* instant — which matters the moment two of them compare answers.
- The remaining timers are all deliberate: the shared 30 s clock, main's 5-minute
  poll, `usePlayback`'s `requestAnimationFrame` (only while playing), the 50 ms
  hover-pick throttle, and `first-paint.ts`'s one-shot fallback.

## Phase 3 — Solar & Geomagnetic. Started.

**Geomagnetic field layer (IGRF-14) — shipped.** Earth's main magnetic field as
a raster over the globe, with three views and no network dependency at all.

- **It is computed, not fetched.** 195 Gauss coefficients at 27 epochs is 20 KB
  vendored; evaluating it is a few hundred flops. No key, no service, nothing to
  rate-limit, nothing that can be offline.
- **It reaches 1900 — the same year the deep archive starts.** IGRF is definitive
  back to 1900, so the layer follows the *existing playhead* across the whole
  126-year record rather than being a snapshot. Scrubbing animates real secular
  variation: the north dip pole leaving Canada, the South Atlantic Anomaly
  deepening. Outside 1900–2030 it **clamps and says so** (`igrfCoverage`) rather
  than extrapolating, because running secular variation forward decades produces
  confident nonsense.
- **The algorithm is a deliberate port of IAGA's reference implementation**
  (`pyIGRF14`, itself a reduction of chaosmagpy), not an independent derivation.
  A spherical-harmonic expansion that is subtly wrong still produces a smooth,
  entirely plausible field — so matching the reference is worth more than
  matching the maths from memory. Pinned to **IAGA's own 12 published test
  values** spanning 1900–2030, agreeing to **0.01 nT**, which is the resolution
  of the published values themselves. Worst observed deviation 0.0067 nT.
- **`sampleFieldGrid` hoists per-row work and that is load-bearing.** The
  Legendre table depends only on latitude and the trig table only on longitude.
  Called per point, a 360×181 grid builds 65,160 of each; hoisted, 181 and 360.
  **38 ms** for the full grid, against roughly 40× that naive — the difference
  between a scrub that moves and one that doesn't. A test pins both the timing
  and the agreement with the unhoisted path.
- **A raster, not entities.** 65,160 cells as Cesium entities would be 2.4× the
  widest archive view (already measured at 590 ms) to draw what is fundamentally
  an image. One canvas → one `SingleTileImageryProvider` → one texture. This
  Cesium version's single-tile provider takes a URL, so it goes via
  `canvas.toDataURL()`.
- **Repaint is guarded on a quantised key** (`quantity:year.x`). The playhead
  moves continuously and the field does not, so without it the layer would
  resample and re-encode a PNG every animation frame during playback. The new
  imagery layer is attached *before* the old one is removed, so the globe never
  flashes bare mid-scrub.
- **Never a rainbow, and that was the skill's call not mine.** Conventional
  geomagnetic charts use one; it invents boundaries in smooth data and is
  unreadable under colour blindness. Intensity is magnitude → **sequential blue,
  strictly monotonic in OKLab lightness** (0.905→0.338). Declination and
  inclination have a meaningful zero → **diverging blue↔red with a neutral grey
  midpoint**, where the neutral band *is* the agonic line and the magnetic
  equator. Validated, not eyeballed: poles separate at CVD ΔE 19.2 (light) and
  23.6 (dark) against a floor of 8.
- **The domain is fixed across dates, deliberately.** Rescaling to each date's
  own min/max would renormalise the colours on every scrub tick and hide exactly
  what the layer exists to show. Measured over 1900–2030: intensity runs
  21,909–69,432 nT, so the domain is 20,000–70,000 and clamping never bites.
- **The quantity is not in `LayerContext` and not on `GlobeLayer`.** In the
  context it would rebuild every static overlay per click, faults included —
  the cost `consumesEvents` exists to avoid. On the shared interface it would
  drag a one-layer concern into the schema package. `isGeomagneticFieldLayer`
  narrows instead, and the push goes down the same channel as `setDimmed`.
- **Two bugs the user found by switching the layer on, both invisible to tests
  until they existed:**
  - **`mount()` set `visible = false`.** `useGlobeLayers` toggles overlays by
    mounting and unmounting and **never calls `setVisible`** — mounted *is*
    visible, as the note on `mountOverlays` says. The raster attached with
    `show = false` and nothing ever turned it on, so the layer drew nothing
    while looking entirely healthy. The only visible symptom was the *other*
    overlays flashing as the static group rebuilt.
  - **Basemaps were not pinned to the bottom of the imagery stack.**
    `addImageryProvider` appends to the top, so a basemap mounted after a raster
    overlay covers it. Reachable, and quietly: **relief and seafloor share
    `tone: 'dark'`**, so switching between them re-runs the basemap effect but
    *not* the overlay effect (whose deps carry `backdropTone`, not
    `activeBasemapId`) — leaving the field raster attached, marked visible, and
    completely buried. All three basemaps now `lowerToBottom` on mount, which is
    where a basemap belongs anyway and protects any future imagery overlay.
- **The field layer was rebuilt around pre-rendered frames, after three failed
  attempts at doing it live. This is the entry worth reading before touching
  it.** The first design built a fresh raster on every playhead tick — compute
  grid, paint canvas, encode PNG, decode asynchronously, construct provider, add
  layer, remove old. It produced three bugs in succession, each hidden behind
  the last:
  1. the layer attached with `show = false` (mount ≠ visible);
  2. the old raster was dropped when the new one was *requested*, not when it
     had decoded, leaving a gap that a busy main thread never closed;
  3. a sequence guard that discarded **every** frame, because under playback a
     newer load was always *requested* before the previous one finished — which
     is why it looked frozen on the first frame and then snapped to live at the
     end, when requests stopped and the last load finally had no successor.
  4. and then, with the frames pre-rendered, an **even flicker throughout
     playback** — because `show` is not a cheap flag. In
     `GlobeSurfaceTileProvider`, `_onLayerShownOrHidden` routes a hide straight
     to `_onLayerRemoved`: hiding an imagery layer **destroys its tile imagery**
     and showing it again re-creates the skeletons and re-uploads the texture.
     Selection moves **`alpha`** instead, which `addDrawCommandsForTile` reads
     during compositing — `if (imagery.imageryLayer.alpha === 0.0) continue;`,
     **before** texture units are counted. So a frame at alpha 0 stays resident
     and costs nothing to draw. Every frame now keeps `show = true` for its whole
     life and only alpha moves. **This one was settled by reading Cesium's
     source rather than reasoning about it — the three guesses before it were
     all wrong.**
  **The lesson is not any of those four fixes.** It is that Cesium's
  `ImageryLayer` is not built to be swapped several times a second, and patching
  a pipeline that fights its own substrate just moves the failure. Frames are now
  rendered once, added as imagery layers with `show = false`, and playback flips
  an alpha — the same idea as the earthquake layer's visibility flags, and the project's
  own rule: **built set stable, visibility live.** The throttle, the sequence
  token and the swap ordering all deleted; there is nothing on the frame path to
  reload, decode or starve.
  - **Grid resolution halved to 2 degrees on measurement**: 47.4 ms/frame at 1°
    against **7.1 ms at 2°** — a 6.7x saving, better than the 4x the area
    implies because the Legendre table is per-row. Cost: 402 nT deviation on a
    50,000 nT scale (0.8%, 7% of one ramp step). Free, because IGRF is degree 13
    and its shortest wavelength is ~27° — 2° sampling is an order of magnitude
    past what the model can resolve.
  - 66 frames at ~65 KB is ~4 MB of VRAM and a **~0.5 s** background warm-up.
  - The build **yields once before its first frame**, because `mountOverlays`
    calls `mount` then `setTimeWindow` synchronously — building immediately
    rendered the first frame for today rather than for the playhead.
  - It picks the nearest unbuilt frame **per iteration** rather than ordering the
    queue once, so scrubbing during warm-up re-aims at what is being looked at.
- **The earlier symptoms, kept because the diagnosis technique generalises.**
  The user noticed the field reappearing "in gaps of earthquakes populating the
  globe" — the tell that this was main-thread starvation rather than a logic
  error, and what pointed at the async decode.
  - `usePlayback` seeks every **50 ms**, so the playhead asked for 20 repaints a
    second against a **38 ms** grid sample. Repaints are now throttled to
    **150 ms with a trailing edge** — the trailing edge is what guarantees the
    final playhead position is drawn rather than whichever frame won the race. A
    quantity change bypasses it, because a deferred response to a button press
    reads as a dead button.
  - **The real one: the old raster was dropped when the new one was *requested*,
    not when it had decoded.** `addImageryProvider` is **not** synchronous — the
    PNG behind it still has to load — so there was always a gap with the old
    layer removed and the new one empty. Idle, the decode lands in a frame and
    the gap is invisible; under playback the earthquake layer's `applyVisibility`
    and Cesium's rendering starve the callback past the next repaint and the gap
    never closes. Now it uses `SingleTileImageryProvider.fromUrl`, which resolves
    **after** the image loads, and swaps only then — worst case one stale frame
    instead of an empty globe. A sequence token discards loads superseded while
    in flight, since they finish out of order under load.
  - **Any layer that rebuilds an imagery provider per frame has this problem.**
  - The test for this was **vacuous on the first attempt** and worth remembering
    why: it asserted against a fresh mount, where there is no previous layer to
    remove, so it passed with the bug reintroduced. It now mounts, settles, and
    only then holds the *second* load open.
- **Two encoding bugs found by looking at the output, not by testing it.** Both
  produced arithmetically correct rasters that were wrong on screen:
  - **The declination domain was the definitional range, `[-180, 180]`, and that
    made the layer look broken.** Measured at 2026, median |D| is **13.1°** and
    **77% of the surface is within 30°** — which on a ±180 scale is 7% off
    centre, i.e. grey. Only the magnetic poles, where D genuinely sweeps the
    full circle, took any colour. Now ±30 **clamped**, which puts that 77%
    across the whole ramp; near-neutral cells fell from most of the globe to
    **14.6%**. `FieldScale.clamped` makes the legend say `≤`/`≥`, because a
    clamped end is a floor, not a measurement. **Set a domain from the
    distribution, never from the definition.**
  - **The diverging midpoint was the palette's *dark chart surface*
    (`#383835`), which inverted the ramp's salience.** That value exists so
    zero disappears into a dark chart background — but this raster sits on the
    globe, and both arms run light near the centre out to dark at the poles. A
    dark midpoint therefore made lightness go dark → light → dark, punching a
    notch through zero: the magnetic equator rendered as a **black line** and
    the agonic lines as dark seams, making the neutral band the loudest thing
    on screen when it should be the quietest. The midpoint is a light neutral on
    both backdrops now, and a test pins lightness as monotonic from each pole in
    to zero. **A palette's per-mode surface colour is not automatically the
    right midpoint for an overlay that isn't drawn on that surface.**
- **The scrubber looked broken and was correct physics.** Over the default 72 h
  window the field moves **1.1 nT** against a 50,000 nT scale; over 1900→2026 it
  moves **13,732 nT**. Nothing on screen said which year was drawn, so the layer
  read as inert. The legend now names the year and says the field changes over
  decades — the fix was a caption, not code.
- **The field legend is a section of `DepthLegend`**, appearing only while the
  layer is on, exactly as the plate-boundary and fault keys already did. Its
  ramp is drawn as discrete steps rather than a CSS gradient so that what the
  legend shows is literally what the encoding produces — a gradient would
  interpolate in sRGB between the ends and quietly disagree with the raster.
- **Intensity uses viridis, not the palette's single blue, and not a rainbow.**
  The blue was correct and unreadable — one hue is one visual dimension, and the
  South Atlantic Anomaly came out as a pale smudge. The user asked about the
  full-spectrum maps they'd seen elsewhere, so all four were rendered and
  measured in OKLab lightness:

  | ramp | monotonic | L range | biggest step |
  |---|---|---|---|
  | blue | yes | 0.91 → 0.34 | 0.049 |
  | viridis | yes | 0.29 → 0.92 | 0.088 |
  | cividis | yes | 0.26 → 0.92 | 0.082 |
  | turbo (rainbow) | **no** | 0.25 → **0.37** | 0.199 |

  Turbo's lightness rises *and* falls, which manufactures contour bands the data
  doesn't contain, and its net range is 0.25→0.37 — brightness carries almost
  nothing, so hue does the work alone and it fails in greyscale, print and CVD.
  Viridis is multi-hue **and** monotonic, which is the combination worth having.
  **A deliberate departure from the palette's "sequential = one hue" rule, taken
  on that rule's own rationale.** Don't revert without re-reading the table.
- **How fast the field actually moves**, since "is this thing working" is a fair
  question: median **41 nT/yr**, p90 87, max 128 — about 0.08% of the ramp per
  year, so it takes decades. The dip pole is the dramatic part: 70.5°N 96°W in
  1900 → 81.0°N 110°W in 2000 → **85.5°N 135°E in 2026**, i.e. out of Canada,
  over the pole, heading for Siberia.
- Sanity check worth keeping: the model's 2025 intensity minimum lands at
  **lat −25.9, lon −60.5 at 22,073 nT** — the South Atlantic Anomaly, exactly
  where it belongs.

**Playback speeds now scale with the window — and this was an archive-wide bug,
not a field-layer one.** The ladder was `[1, 6, 24]` h/s, correct for the 30-day
window it was written for and never revisited when archive spans shipped:

    30d    12min   2min    30s     <- as designed
    1y     2.4h    24min   6min
    10y    24.4h   4.1h    61min
    130y   316h    52.8h   13.2h   <- two days at the default

So playback across the archive wasn't slow, it was unusable — and it looked like
whatever layer you were watching had frozen. `playbackSpeedsForWindow` now offers
the speeds that cross the current window in 5 s to 15 min, **derived from a
ladder rather than tabulated**, so adding a span can't leave it stale. Same
mechanism and same reason as `magnitudeFloorsForWindow`. `setWindowHours` keeps a
still-valid choice and otherwise re-picks; the archive-exit path needed its own
adjustment because it sets the window directly rather than going through it.
This fixes earthquake playback over the archive too.

**Reconnaissance that shaped the rest of the phase:** SWPC's JSON products are a
**rolling window, not an archive** — Kp is 7 days at 3-hourly, GOES X-ray 7 days
at 1-minute (4.6 MB). They can drive live views and can never drive H1/H3b/H4c,
which are decade-scale rate correlations. Deep Kp exists at GFZ Potsdam (to
1932) as a *separate* source. NOAA's OVATION auroral product is live and ideal
for the next layer: a 360×181 grid of aurora probability, same raster shape as
the field, with an observation time and a ~1 h forecast.

**Auroral oval (OVATION Prime) — shipped.** The live counterpart to the IGRF
layer, and the answer to "why don't solar storms show up on the magnetic field".

- **They can't, and the numbers say why.** IGRF is the *main* field from the
  geodynamo; it has no term for the Sun. A storm perturbs the *external* field:
  ~100 nT typical, 589 nT for Quebec 1989, an estimated 850–1750 nT for
  Carrington — **0.2% to 3.5%** of a 50,000 nT main field, lasting hours. Even a
  civilisation-scale storm is invisible on that ramp. The same storm drags the
  auroral oval from the polar cap down over populated latitudes, which is
  enormous. One event, and only one of the two layers can show it.
- **Not persisted, deliberately.** Everything else stored here is a *record*;
  this is a forecast of a transient, superseded every five minutes. Caching it
  would add 65 KB a poll — 19 MB a day — for data no view can ask for again. The
  consequence is stated in the UI: nothing until the first poll, nothing
  offline. A stale oval presented as current is worse than an empty globe.
- **Transparency carries meaning here, and it is the one place it does.** About
  70% of cells are zero on a quiet grid (measured 45,284 of 65,160 live). Those
  are absences, not small values; painting them with the ramp's low end would
  wash the planet faintly green and imply a global phenomenon. The IGRF layer
  does the **opposite** with uniform alpha, because a magnetic field is never
  absent. Alpha fades in only across the bottom few percent — a hard cut at the
  threshold would draw a contour belonging to the threshold rather than the data.
- **Green is literal, not decorative:** 557.7 nm atomic oxygen. It also keeps
  the two space-weather rasters apart when both are on. Monotonic in OKLab
  lightness (0.17 → 0.96), same rule as the field ramp.
- **The adapter transposes twice, and both matter.** The product runs longitude
  0–359 from the prime meridian and latitude south-first; an image needs -180
  first and north first. Getting the longitude wrong puts the Pacific over
  Africa and still looks like a plausible aurora. Verified live: activity
  58,898 north / 95,939 south / **646** in the tropics — polar, as it must be.
- **`AURORA_MAX_PROBABILITY` is 60, not 100 and not the observed maximum.**
  Scaling to 100 compresses ordinary nights into the bottom third; scaling to
  the observed peak renormalises every poll and makes "brighter than last time"
  unreadable. Saturation should mean exceptional, not Tuesday.
- **`setTimeWindow` is a deliberate no-op.** There is no archive of past grids,
  so scrubbing to 1975 cannot show the aurora of 1975 — and silently leaving the
  current oval up while the playhead sits in the past would misrepresent it. The
  legend says "live only — does not follow the scrubber" whenever the playhead
  is elsewhere.
- The async swap **is** allowed here, unlike on the field layer: this changes
  every five minutes, not several times a second. The one rule carried over is
  removing the old raster only after the replacement has decoded.
- Its tests are **fixture-based, not live**. The adapter was checked once against
  the real product; adding a second pair of network tests would have made
  `pnpm test` non-deterministic the way the EMSC ones already do.

**Earthquake poll back to 60 s, with two guards.** It was 60 s, then 5 minutes
because rebuilds hitched while rotating, and is now 60 s again — the user wanted
the freshest catalogue and the reasons for backing off had mostly gone.

- **The rebuild rate is bounded by how often earthquakes happen, not by how
  often we ask.** At the M1+ ingest floor the catalogue gains an event every
  three to five minutes, so a faster poll mostly makes the same rebuilds
  prompter. What it genuinely costs is *batching* — several events that arrived
  together used to land in one rebuild.
- The two things that made it safe again: the **timer-driven rebuild is gone**
  (a quiet poll now rebuilds nothing, because the renderer only reloads on
  `result.changed`), and `catalogSignature` is scoped to the live window.
- **EMSC is polled every fifth tick, not every tick.** It is a gap-filler, not
  the primary source, and it is *slow* — an FDSN database query measured at over
  five seconds for a single record, which is why its own tests trip vitest's
  default timeout. USGS is a CDN read that costs nothing, so the two sources get
  the cadence each deserves. The invariant — EMSC no oftener than every five
  minutes — is pinned against the *product* of the interval and the divisor, so
  it survives someone changing the base rate.
- **An overlap guard, which 5 minutes never needed.** A poll could not outlast a
  five-minute interval; it can easily outlast sixty seconds. Without the guard a
  slow run would let the next start on top of it, piling up against the same
  database and the same alerter.

**Kp and Dst history track — shipped.** The scrubber-following half of space
weather, and the answer to "the aurora doesn't animate": these do.

- **Two sources, split by index: GFZ Potsdam for Kp (1932), NASA OMNI2 for Dst
  (1963).** The table stores them independently, so a row legitimately carries
  Kp and no Dst for thirty-one years' worth of hours.
- **The "GFZ is unreachable" diagnosis was wrong twice, and the second wrong
  answer is the one worth remembering.** First it was blamed on DNS; then, more
  confidently, on a TCP-level egress block covering GFZ's whole address range,
  supposedly a build-sandbox restriction. Both were inferred from `curl`
  failing. `curl` is the broken thing: it returns **error 43** against GFZ while
  returning 200 against USGS, because this box's build uses the Schannel TLS
  backend. Node's `fetch` — the runtime the app actually uses — retrieves the
  5.5 MB file in **634 ms**, and always could have. **Check a source with the
  runtime that will actually fetch it before concluding anything about the
  network**; a second tool's failure is not corroboration when both tools are
  the same tool.
- **Verified against ground truth before anything was built on it:** the March
  1989 Quebec storm parses as **Dst -589 nT at 1989-03-14T01:00Z** with **Kp 9**
  the evening before — the documented values — and a year file yields exactly
  8,760 samples with no fill values leaking. **Both sources agree on it**, which
  is how the GFZ column map was checked: GFZ puts Kp 9 in the last interval of
  03-13 and the first of 03-14, straddling OMNI's Dst minimum.
- **The fill values are width-matched sentinels, not zero**: 99999 for OMNI's
  five-digit Dst, `-1.000` for GFZ's Kp. Read as data they become a +99999 nT
  excursion and a Kp below the bottom of the scale. GFZ's is at least
  unmistakable — Kp is bounded 0–9, so a negative cannot be a measurement —
  whereas OMNI's old `99` for Kp*10 sat *inside* the plausible range as 9.9 and
  would pass any check a chart applies. GFZ's fill appears only on the current
  day in the nowcast, where later intervals have not happened yet.
- **SWPC's Dst is deliberately not ingested.** SWPC publishes one, and it is
  **Geospace model output** at one-minute cadence, whereas OMNI carries the
  Kyoto observatory-derived index. Same name, same unit, different quantities —
  and Dst is registered data for H4c, so blending them would leave no way to tell
  which any hour came from.
- **SWPC's Kp is now out too, on the same argument.** It used to fill the recent
  tail, justified here as "genuinely the same planetary index". It isn't quite:
  SWPC publishes NOAA's *estimate* from eight stations, GFZ the definitive IAGA
  index from thirteen. That distinction was tolerable only while GFZ looked
  unreachable. GFZ serves its own 30-day nowcast file — **8 KB**, byte-identical
  in format to the 5.5 MB archive — so the tail now comes from the same
  publisher as the history. H4 named SWPC by name, so it was **withdrawn
  unrun and replaced by H4c** in `HYPOTHESES.md` rather than edited in place.
- **Kp is one request; Dst is 63.** GFZ's archive file is the whole 1932-onward
  record in a single ~5.5 MB read: 829,416 hourly samples, measured at 2.6 s to
  fetch and parse and **812 ms** to insert. OMNI is still a year-file loop and
  is effectively all of the ~184 MB the panel warns about. The backfill runs Kp
  first because it is nearly free, and `SpaceWeatherProgress.phase` names which
  half is running — a single bar driven by years would sit at zero through the
  Kp phase and then jump.
- **Resume needs no bookkeeping table, unlike the earthquake archive.** There,
  "did 1974 finish?" cannot be answered from the events — a quiet year and an
  unfetched year look identical. Here the hour is the primary key and every year
  has ~8,760 of them, so `spaceWeatherYearsPresent` *is* the record. The current
  year is always refetched, because it isn't finished and recent Dst is
  provisional.
- **That query is asked per index, and it is load-bearing.** It used to mean
  "does this year hold any sample?", a fair proxy while one source carried both
  indices. Kp's single request puts samples in *every* year from 1932 — so a Dst
  loop asking the old question would skip all 63 OMNI years and never fetch Dst
  again, with no error and a backfill that reports complete in seconds.
- **`parseOmniHourly` deliberately discards OMNI's Kp column**, and this is
  structural rather than tidiness. `insertSpaceWeather` coalesces with
  `excluded` winning, and the backfill fetches GFZ first and then loops the OMNI
  years — so an OMNI sample carrying Kp would overwrite GFZ's thirds with OMNI's
  rounded tenths for every hour from 1963 on, undoing the switch on the very run
  that performed it. Reordering the phases would hide that, not remove it.
- **The two Kp encodings differ by at most 0.033 and agree exactly on the
  integers**, which is where every threshold in the app and in `HYPOTHESES.md`
  sits (display emphasis 5, H4c's trigger 6). So rows left from the OMNI era are
  imprecise, never misclassified — which is why no migration was needed.
- **The GFZ file carries four more columns we don't ingest, and one of them is
  the reason to remember this.** `ap`/`Ap` is the **linear** equivalent of Kp,
  and it is the one that may be averaged — Kp is quasi-logarithmic, so a mean Kp
  is not a meaningful quantity. Nothing needs it yet because the track takes the
  *extreme* of each bucket rather than the mean, but any Phase 4 rate work that
  wants a mean geomagnetic level must use ap, not Kp. Also there: sunspot number
  from 1932 and F10.7 solar flux from 1947. Neither appears in any registered
  hypothesis — H3b registers solar wind *speed alone*, not Bz — so they are
  Explore material if
  anything. Note the **sunspot column is CC BY-NC 4.0** while the rest of the
  file is CC BY 4.0; ingesting it would put a non-commercial term on a dataset
  that otherwise has none.
- **Null never overwrites a value** (`COALESCE(excluded.x, x)`): a later pass
  carrying Kp but not Dst must not erase a Dst we already have.
- **Downsampling takes the extreme of each bucket, never the mean.** A storm is
  a spike a few hours long; averaging a decade into 300 buckets flattens every
  storm in the record into the background and produces a chart whose entire
  subject is missing.
- **Each interval now draws twice — a bar for the typical, a cap for the peak —
  because the extreme alone lies at width.** Every bucket reporting its worst
  hour makes a decade of quiet years with one storm each look *identical* to a
  decade of continuous disturbance. The gap between bar and cap is the
  interval's variability, read directly; at short windows a bucket is one hour,
  the two coincide, and the track degenerates to what it drew before.
  - The cap is a **2px line, not a taller bar**, so a track of brief storms
    doesn't read as one long one — it adds a line's ink instead of a column's.
  - **Same hue for both**: they are two statistics of one measurement, not two
    series. The cap carries higher opacity only to hold its own at 2px.
  - The bar turns red when the interval *sat* at storm level and the cap when it
    merely touched it — a rarer and louder claim than the other.
- **The typical is a median, and the mean is barred twice over.** Once for the
  flattening above; and independently because **Kp is quasi-logarithmic**, so
  the arithmetic mean of two Kp values is not a meaningful quantity at all (`ap`
  is the linear equivalent). A median is an **order statistic** — it selects an
  observed reading rather than computing a new one — so it never does arithmetic
  the index doesn't support. For an even count it takes the lower of the two
  middles rather than splitting them, which keeps the answer on Kp's own
  28-value scale instead of inventing a rung.
- **`bucketsForWidth` is one per 3px, not 2.** A 2px mark with a 1px gap.
  Touching was survivable when a bar was a solid column; with caps, neighbouring
  ones merge into a continuous line that reads as a plotted series.
- **The axis ticks land on calendar boundaries, not on even divisions of the
  window** — a label reading `1994` is worth more than `12 Mar 1994 04:17`. So
  the first tick is rarely at x = 0 and the count varies as the window slides,
  which is correct: the axis describes the calendar, not the viewport. Months
  and years step by calendar rather than by a duration, or "every 3 months"
  becomes "every 91.3 days" and drifts off the boundaries.
- **Three axis bugs found by sweeping every real window at five widths**, none
  of which any unit test would have suggested. Worth re-running that sweep after
  touching the ladder:
  - A 48-hour window drew **`12:00 00:00 12:00 00:00`** — two identical labels
    with nothing to say which day either belonged to. Midnight on an hour axis
    now names the day. Times still repeat *between* dated midnights, which is
    right and conventional; the invariant is that no two **adjacent** ticks read
    the same.
  - The ladder jumped 2 days to 7, so a **week on a narrow track got one tick**
    (7/2 overshoots a 3-tick budget, 7/7 is a single label). There is a 3-day
    rung now.
  - End labels overhung the track by up to **9px**, centred on ticks at x≈0 and
    x≈1. `TrackTick.anchor` anchors the two ends inward. After the fixes: worst
    label slack **52px**, worst overhang **−1px**, zero adjacent duplicates.
- **Hover is a nearest-x column, not per-bar hit testing.** A bar is 2px wide and
  there are up to 300 of them, so requiring the pointer to land on one leaves
  most of the track dead. The reader aims at a *time*. The readout replaces the
  header caption rather than floating near the cursor — the panel is short and a
  floating tooltip would clip against its edge — and the same values are reachable
  by keyboard, since 300 focus stops is not a real alternative.
- **Kp sizes the bars, Dst only colours them.** Kp is bounded 0-9 so a fixed
  scale is honest; Dst is unbounded below, and one -589 nT hour would flatten
  every other bar in the record — which is exactly the hour you want to see in
  context.
- **Bars are positioned by timestamp, never by array index.** Gaps are common
  (OMNI has them; a partial backfill has whole missing years) and index spacing
  would close them silently, drawing a continuous record that does not exist.
- **OVATION emits a seam at the equator, and it is theirs not ours.** Measured
  live: latitudes 0, -1 and -2 carry values of 1-4 across ~90% of longitudes
  while every row from +1 to +40 and -3 to -40 is exactly zero. It drew as a
  faint green line right around the globe. Suppressed below
  `AURORA_MIN_LATITUDE` (20 degrees) rather than by raising the visibility
  threshold, because real aurora at the oval's edge also has low values and
  raising the floor would clip the phenomenon itself. Dropped at the *call site*
  in the encoding, not in the adapter, which stays faithful to its source per
  non-negotiable #7.
- The track lives **inside the scrubber's panel**, not above it, so they share
  one time axis and one box — the inspector's `max-height` is computed against
  the height of whatever sits down there, and a second panel would have cost it
  twice over.
- `KP_STORM_THRESHOLD` is 5 (NOAA G1) for **display emphasis only**. H4c's
  registered trigger is **Kp >= 6**. Keeping them apart is non-negotiable #3: a
  display threshold drifting into the analysis is a free parameter chosen after
  seeing the data. A test pins the separation.

**Relative times are one helper now, app-wide** (`panels/time-labels.ts`). They
were five separate formatters — event list, hover tooltip, legend freshness,
large-event banner, missed-events digest — each with its own ladder and
abbreviations, so the same elapsed time could read "5d ago" in one place and
"120 hr ago" in another, and the scrubber rendered a 130-year span as
**"47483d ago"**.

- **Seven consumers now**: the five above plus the **hover tooltip's top-right
  age** and the **inspector's header**. All measure from the wall clock via
  `useNow`, *not* from the playhead — they describe the same events and a reader
  comparing a tooltip against a list row must not find them disagreeing.
  - In the inspector the age sits **beside the magnitude, not under Origin
    time**, where it was first put. Magnitude, place and age are the three
    facts that identify an event conversationally — "M6.2 near Kamaishi, three
    hours ago" — so they belong together above the fold, visible whichever
    sections are expanded; the field list is for precise values you go looking
    for. It also matches the tooltip's reading order, so clicking a mark keeps
    the same three facts in the same places.
  - **Not in the header's right-hand corner**, which belongs to the close
    button: muted text beside a `×` reads as button chrome and invites
    misclicks. And it is *moved*, not duplicated — the same value twice in a
    panel this short is noise.
  - Adding `useNow` to the inspector re-renders it every 30 s, which in this
    codebase is a question worth asking rather than assuming: the collapsible
    sections each own an IPC hook, and recurrence alone is 32–294 ms of O(n²)
    declustering. Checked — every section's effect is keyed on primitives
    (`eventId`, `key`, lat/lon, radius, floor), none of which a clock tick
    touches, so nothing refetches. Keep it that way if a section grows a
    dependency.
  - `HoverTarget` carries `timeUtc`, the **instant, not a formatted age**.
    Formatting it in `describeEarthquake` would need a clock and would freeze
    the answer at the moment the pointer last moved.
- **One number, one unit, never compound.** `45s / 12m / 3h / 5d / 3w / 7mo /
  4.0y`. The label exists to be read at a glance and compared down 26 list rows;
  "1y 2mo 3d ago" does neither. Precision lives elsewhere — the inspector prints
  the exact UTC instant, and the list row carries it in `title`.
- **Thresholds cross where the smaller unit stops reading, not at the exact
  conversion.** Days run to 14 before becoming weeks, because nobody thinks in
  "2w" for 8 days; weeks run to 8 before becoming months. Years keep one decimal
  below a decade and drop it above, where the fraction is noise.
- **The event list switched from absolute to relative**, reversing an earlier
  note that said "a relative age on 26,000 rows is unreadable". That was true of
  a days-only ladder — `47483d` — and stops being true once years are in it.
- `formatAgoFrom` returns **null** for an unparseable input rather than a label,
  so a bad timestamp shows nothing instead of "just now".

**Solar wind speed and IMF Bz — ingest shipped.** Speed is H3b's registered
quantity; **Bz is not registered for anything**, and is carried for Explore and
for §5.6's magnetopause work.

- **The history cost nothing to add.** Speed and Bz are columns 25 and 17 of the
  same 55-field OMNI2 rows the Dst backfill was already downloading and
  discarding. The only new endpoint is the live tail.
- **Coverage is not monotonic, and that is the whole story.** Measured hourly
  coverage: 8% in 1963, 61% by 1970, **92% in 1980** with ISEE-3 at L1 — then a
  collapse to **32-42% from 1985 to 1994** after ISEE-3 left for comet
  Giacobini-Zinner, recovering to 98-100% from 1995 with WIND and ACE. Any "it
  improves over time" assumption is simply false.
- **`SOLAR_WIND_COMPLETE_SINCE_YEAR` is 1995, and the number that sets it is
  not coverage.** H3b defines a stream onset as sustained speed over a threshold
  for **six hours**, so what matters is unbroken six-hour windows: **16.9%** of
  them in 1993, 24.8% in 1994, **97.6% in 1995**. A 5.8x swing in detectability
  from spacecraft coverage alone — the same trap as running a decade-scale
  correlation on M4.5+ earthquakes.
- **The record is missing preferentially at its own maxima, which is worse than
  a uniform gap.** Around the 2003 Halloween storm: 2003-10-29 and 10-30 have
  **zero of 48 hours** with a speed, while Dst reads -350 and -383 straight
  through. **59 of 2003's 72 missing hours — 82% — are those four days.** ACE's
  plasma instrument saturates on solar energetic particles exactly when the wind
  is most extreme; ground magnetometers don't. So anything counting high-speed
  events under-counts the biggest ones, and a gap must never be read as "no
  stream". Dst and Kp are what distinguish a quiet spell from a blinded sensor.
- **The live tail must be SWPC's *propagated* product, not its raw L1 stream.**
  OMNI is time-shifted to the bow shock nose as a defining property, and
  `products/geospace/propagated-solar-wind.json` is too; `json/rtsw/` is the
  raw measurement 1.5 million km upstream. Measured offset: **59.4 minutes** on
  a 362 km/s wind, and it scales inversely with speed — a whole bucket at hourly
  resolution. Bucketing on `time_tag` instead of `propagated_time_tag` would
  shift the entire live week an hour early. Same "same name, different quantity"
  rule that keeps SWPC's modelled Dst and NOAA's estimated Kp out.
- **Two endpoints, for the same reason the Kp adapter has two.** The seven-day
  file is 1.19 MB — polled every 15 minutes that is 114 MB/day — so the poll
  reads the **6.5 KB one-hour** file, which overlaps a 15-minute cadence four
  times over. The seven-day file runs once per backfill to fill the week OMNI's
  lag cannot reach.
- **Columns are read by name from the payload's own header row**, unlike the
  OMNI adapter which must use positions because its format has no header. There
  is no reason to hard-code offsets that a future inserted column would shift.
- **Bz is GSM, not GSE, and they sit one column apart in OMNI.** GSM is
  referenced to Earth's dipole, so it is the frame where southward Bz means the
  reconnection condition that drives storms. Verified for the SWPC feed against
  its own `solar-wind-mag-field.json`, which names its frame.
- **Hourly values are means here, and that is not a contradiction of the Kp
  rule.** Kp may not be averaged because it is quasi-logarithmic; speed and Bz
  are linear measurements, and OMNI's own hourly values are averages of
  high-resolution data. An extreme would make the live week disagree in kind
  with every hour before it.
- **`OMNI_FIELDS_VERSION` exists because presence stopped being a resume test.**
  The Dst loop skipped years already holding Dst — complete while Dst was all
  this adapter took. A database backfilled before this change holds every Dst
  year, so the loop would skip all 63 and never fetch the wind columns, with no
  error and a panel reporting complete. **Testing `wind_speed` presence instead
  is wrong and looks right**: coverage is genuinely 32-42% through 1985-94, so
  "absent" and "never fetched" are indistinguishable per year, and such a year
  would refetch forever. The marker records what the *parser asked for*. Bump it
  when a column is added; `completedYears` reports 0 while it is stale, or the
  panel would say complete and nobody would press Resume.
- Migration 7 is `ALTER TABLE ADD COLUMN` x2 — adds only, so create-copy-drop-
  rename doesn't apply. Verified against a copy of the real 202 MB database:
  **924 ms**, all 829,443 space-weather and 311,070 earthquake rows preserved.

**The track is two rows now** — geomagnetic and solar wind — which is §5.5's
multi-track timeline in its first real form.

- **Two rows because two y-scales in one plot is the worst thing you can do to a
  chart.** Kp is 0-9, speed is 250-900 km/s, Dst is 0 to -600 nT. They get a row
  each and share the x, which is what makes "did the wind arrive before the
  storm?" answerable by looking down a column.
- **One bucketing, laid out twice.** `layoutTrack` takes a `TrackSpec` naming
  which fields a row plots and what its scale is, so both rows come from the
  same `downsampleSpaceWeather` call and *cannot* land on different x positions.
  Duplicating the layout per row would have let a change to gap handling or
  hover apply to one and not the other.
- **The hover index is shared.** Pointing at an hour reads out both rows at that
  hour; only the top one prints the time, since the rows are read as one block
  and always show the same instant.
- **`WIND_SPEED_MAX` is 1000 km/s, measured not guessed.** Pooled over 34,259
  real hours from 1974/2003/2015/2024: p50 450, p90 656, p99 782, p99.9 877, max
  1189. It **clips 0.035%** — one hour in 2,900 — to put the ordinary range
  across most of the row instead of a third of it. A ceiling of 1200 clips
  nothing and spends a fifth of the height on values that never occur.
- **`FAST_WIND_THRESHOLD` is 500 for display only**, kept as its own constant
  even though H3b registers the same number, exactly as `KP_STORM_THRESHOLD` is
  kept apart from H4c's trigger. If the registered value is ever amended this
  one must not silently follow.
- **Bz is taken as the *minimum* per bucket, not the maximum.** Southward is the
  geoeffective direction; taking the max would headline the least interesting
  hour of every interval. Same for Dst, and the opposite for Kp and speed —
  `peakOf` handles each in its own disturbed direction.
- **The height budget is real and doubles.** The track sits inside the scrubber
  panel, and the inspector is centred, so it pays clearance at the top too:
  every rem the panel grows costs the inspector two. A second row is ~2.5rem, so
  both plots dropped 1.85rem → 1.5rem to claw 0.7rem back and the inspector's
  `max-height` went 23rem → 27rem. **A third row costs the same way** — the
  cheap answer then is a row the reader can collapse, not a shorter one.
- **Absence is drawn, because absent and quiet are the same picture.** A bucket
  with no measurement and one that measured something low both produce a short
  bar or none. `SpaceWeatherBucket` carries `kpHours` / `windSpeedHours`, and a
  bucket measuring zero of them gets a **2px baseline mark in neutral grey** —
  not the series hue, or a decade with no spacecraft at L1 would read as a
  decade of very slow wind. Contiguous gaps merge into a dotted axis; isolated
  dropouts read as dashes.
- **A row also says how much of the window it saw**, below 95%. Measured on the
  real database: the 48-hour Halloween blackout is **0% wind against 100% Kp and
  Dst** while Dst reads -383; the surrounding 5-day window is 51%; 1985-1994 is
  40%; 2015 is 100% and shows no caption. A peak drawn from a third of the hours
  is a different claim from one drawn from all of them, and nothing else on
  screen tells them apart.
  - The threshold is 95% and not 100% because OMNI drops scattered single hours
    even in its best years — a caption on every view is noise that stops being
    read, which would cost it exactly when it matters.
  - **It exposed a real gap in the live window**: the last 30 days measure only
    57% wind and 70% Dst, because OMNI's recent data ends before SWPC's 7-day
    file begins. Not a bug, a limitation of the two-source design that was
    invisible until the caption existed.
- **The refactor dropped the ResizeObserver and lint caught it.** Width would
  have stayed at the 480px fallback forever, so bucket count and tick count
  would never have adapted to the real width — a silent wrongness, not a crash.
  It is a ref callback on the first row only, since both are the same width.

**Magnetopause (§5.6) — shipped as an off-by-default layer.** Shue et al. (1998)
evaluated on the stored wind, drawn as an open wireframe at ~10 Earth radii.

- **The only layer that draws model output**, which is why its category is
  `analysis`, its label says `(model)`, and it is a thin wireframe rather than a
  shaded skin — a solid surface would read as an object that is there.
- **Validated against 396,183 real hours**: standoff p50 **10.62 Re** (textbook),
  min 5.11, and **298 hours (0.075%) inside geosynchronous orbit**. The eight
  most-compressed hours are all recognisable storms — Bastille Day 2000,
  2001-03-31, 2003-05-29, and **2024-05-10/11 (Gannon)** at 5.23 Re against a
  measured Dst of -406. It reproduces known events from independent inputs.
- **Geosynchronous orbit is drawn beside it, and is what makes it legible.**
  "6.3 Re" is a number; "inside geosync, so those satellites are in raw solar
  wind" is an event. The ring is drawn even when the boundary cannot be — that
  is what shows the *boundary* is what is missing.
- **It flashed under playback on the first attempt, and the cause was the field
  layer's lesson in a different medium.** `entities.removeAll()` plus a re-add
  of all 21 polylines on every hour change leaves a frame with nothing drawn.
  The entity equivalent of flipping an alpha is a **`CallbackProperty`**: the
  geometry is created once on mount and never removed, and only the positions it
  reads change. `antipode-layer.ts` already used this. **Anything that redraws
  on the playhead needs this shape** — imagery via alpha, entities via callback,
  and never by replacing the objects.
  - The position arrays are **cached, not computed in the callback**, which runs
    every frame: 21 polylines of ~49 points is ~60,000 `Cartesian3` allocations
    a second to redraw geometry that has not moved.
  - Out-of-order responses needed no new guard — `useSpaceWeather`'s effect
    cleanup already discards a superseded query, which is what the field layer
    needed a sequence token for.
- **Enabling it flies the camera to ~26 Re**, because at normal zoom the
  boundary is entirely off screen and a layer that drew it silently would look
  broken. Not restored on unmount: flying back would fight a reader who turned
  it off *because* they had navigated elsewhere.
- **3.8% of stored hours fall outside the range Shue et al. fitted**, including
  most large storms — `MagnetopauseShape.extrapolated` reports it rather than
  continuing silently. Still to surface in the legend.
- `subsolarPoint` is computed analytically, not via Cesium's ephemeris: the
  ICRF-to-fixed transform needs asynchronously-loaded Earth-orientation data and
  can be `undefined` on early frames — a lot of failure surface for a quantity a
  low-precision formula gets within a fraction of a degree, which at 10 Re is
  nothing. Pinned against the solstices, equinoxes and 15°/hour rotation.
- **Null wind draws no boundary.** The same rule as the track's absence marks,
  and `useSolarWindAt` reads the *containing hour only* — carrying a value
  forward across a gap would present conditions measured years earlier as
  current.

**Ionosphere (TEC) — shipped.** SWPC's GloTEC as a raster, off by default, with
a total/anomaly toggle. The layer the "charged atmosphere" question actually
wanted, and the one place the equatorial crests are visible.

- **The domain is 60 TECU, not the product's declared 300.** GloTEC's own
  metadata gives `tec` a range of 0-300; five maps spanning a month measure p50
  12.9, p95 41.9, max 60.5. Using the declared range would leave every ordinary
  map in the bottom fifth of the ramp — **the exact mistake the declination scale
  made once**. Set a domain from the distribution, never the definition.
- **Cells are placed by their own coordinates, not by list order.** The product
  emits 5,184 point features in a consistent order and nothing documents that. A
  raster built by consuming them in sequence renders a plausible-but-scrambled
  image the first time that changes — and scrambled TEC looks like weather.
- **`anomaly` is the analytically useful quantity and raw TEC is the intuitive
  one, so both are one click apart.** Raw TEC is dominated by local time: the
  daylit hemisphere is always high, so a plain map mostly draws the terminator.
  The anomaly removes that. It is signed, so it gets a diverging ramp with a
  light neutral midpoint — measured p1 -6.1, p99 +10.0, domain ±10.
- **Magenta, because hue is how four rasters stay apart.** aurora = green,
  field = viridis, magnetopause/magnetometers = cyan, TEC = magenta; the anomaly
  diverges purple↔orange rather than reusing the field's blue↔red, since both
  can be on at once. Single hue for the sequential ramp — the field's departure
  to viridis was for structure TEC does not have. Brighter means more, matching
  the other two rasters.
- **Uniform alpha, the opposite of the aurora.** The aurora makes transparency
  carry meaning because ~70% of its cells are genuine zeroes. The ionosphere is
  never absent, so a see-through cell would misstate coverage. Only a cell the
  product did not supply is transparent.
- **Pulled on demand, not polled — the only feed here that is.** A map is
  **2.4 MB** against the auroral grid's 65 KB, so a timer would spend ~14 MB an
  hour on a layer that is off by default. `useTec` fetches only while the layer
  is visible; main caches for one publication cadence and shares one in-flight
  request between askers.
- **`quality_flag` is carried uninterpreted.** 72% are 0 and 14% are 5, and the
  payload never says what they mean. They do *not* cluster like model-fill —
  flag 5 runs 17-25% through mid-latitudes and **0%** poleward of 75 degrees.
  Guessing that 5 means "modelled" and masking on it would invent a distinction.
- Verified live: all 5,184 cells filled, zonal-mean TEC peaking at **±16-21
  degrees** — the equatorial ionization anomaly's crests, where they belong — and
  an equator-to-pole ratio of 25.7 against 8.6 TECU.

**And the trap that layer makes visible, written into the schema so it cannot be
lost:** the equatorial crests overlap **68% of M7+ earthquakes** because both are
equatorial for unrelated reasons — the field's geometry on one side, plate
boundaries on the other. Same spurious-by-construction shape as the antipodal
South America/Indonesia pairing. Anything drawn from "quakes fall where TEC is
high" has to answer that first.

**The aurora is not where a quake-versus-charge comparison can be made, and it
is worth knowing why before building on it.** Measured over 1,045 M7+ events
using this app's own IGRF: **68% sit within 30° geomagnetic latitude** and only
**0.77% (8 events) fall under the ordinary auroral oval** — nearly all of them
Macquarie Island. Auroral precipitation is organised by the magnetic poles;
large earthquakes by plate boundaries. The geographies barely intersect, so a
spatial test has n = 8 with a single-region confounder. Note also that the *most
charged* atmosphere by electron density is not the aurora but the equatorial
ionization anomaly at ±10-20° magnetic latitude — which overlaps that 68%
**because both are equatorial**, the same spurious-by-construction trap as the
antipodal South America/Indonesia pairing. The viable form of that question is
**H4b**: local magnetometer disturbance and nearby seismicity, which works at
all latitudes because induced currents are global.



**Why the aurora cannot animate, so it isn't re-attempted:** SWPC publishes only
`ovation_aurora_latest.json`. There is no archived grid product — checked. The
oval is a nowcast, and the layer says so whenever the playhead is elsewhere.

**Also next:** Phase 3 proper (solar/geomagnetic ingest), or aftershock *forecasting*
(§5.9's model half, Phase 4) once the Python engine exists.
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

### Window size

Remembered between launches in `app_state` under `window_bounds`, with 1600×1000
as the first-run default. `window-bounds.ts` holds the decisions as pure
functions; `index.ts` does the Electron wiring.

- **`getNormalBounds()`, never `getBounds()`.** While maximised the latter
  reports the maximised rectangle, so saving it makes un-maximising restore to
  full screen and silently loses the size the reader actually chose.
- **Size and position are restored independently.** Undock a laptop and the
  saved position points at coordinates no display covers; restored there the
  window opens genuinely invisible with no obvious way back. When that happens
  the *size* is still honoured and only the position is dropped, so Electron
  centres a window that is still the size you picked.
- **"On a display" needs a grabbable overlap, not any overlap** — 120×40px. A
  window one pixel onto the screen is as unreachable as one fully off it.
  Negative coordinates are normal (a second monitor to the left), so a naive
  `x >= 0` check would discard a valid position on every launch.
- **Writes are debounced 400 ms and flushed on `close`.** `resize` fires
  continuously while dragging and each write is a synchronous SQLite
  transaction on the main process; without the debounce one drag is hundreds of
  them, competing with the render loop exactly while the window is moving.
  Without the flush, a resize in the last moment before quitting is the one
  change that never persists.
- The stored value is parsed strictly — a `NaN` width reaches `BrowserWindow` as
  a window that never appears, which is a baffling failure for something this
  peripheral.
- `MIN_WIDTH` is 1000 and is **not cosmetic**: the inspector is 24rem wide and
  sits left of centre, so its left edge lands 448px from centre and below 1000px
  it reaches the left column. It moves with the inspector's width, not alone.

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

### Collapsible inspector sections

All four inspector sections — What followed, Near the antipode, Nearest mapped
fault, How often here — are collapsed by default behind `CollapsibleSection`.
Prompted by the panel covering the time scrubber.

- **A collapsed section is unmounted, not hidden, and that is the point.**
  `{open && children}`, never `display: none`. Each section owns a data hook, so
  unmounting is the only thing that actually stops the IPC: recurrence alone is
  32–294 ms of O(n²) declustering in main, paid on *every* selection before
  this. Clicking through the event list is now free unless you asked for an
  answer. If anyone converts this to CSS hiding "to preserve scroll position",
  they will silently restore the whole cost.
- **The headers therefore can't carry a summary.** "What followed — 47
  aftershocks" needs the query to have run, which is the cost being avoided.
  Considered and rejected on those grounds; the heading states the question.
- **Expansion lives in `useGlobeStore`, not the panel**, so it survives changing
  selection. It is a statement about what you are interested in, not about one
  earthquake. Absent means collapsed, so `toggleSection` negates rather than
  comparing against `false` — otherwise the first click on every section is a
  no-op. Test pins it.
- **Independent, not a true accordion.** The sections answer different questions
  and comparing two at once is reasonable.
- **Open/closed is signalled without hue.** The app's existing active language
  is a tinted fill in a colour that *means* something (violet for the recurrence
  region, red for the antipode chord). A disclosure state means nothing beyond
  "there is more here", so it gets neutral emphasis — flat and dim closed,
  filled/outlined/near-white open — plus a literal `show`/`hide` word, because a
  0.7 rem rotated triangle is not enough on its own. The border exists in both
  states and is merely transparent when closed, so opening doesn't shift the row.
- **`max-height` is now `calc(100vh - 18rem)` and the arithmetic is not
  guessable.** The panel is centred (`top: 50%` + `translateY(-50%)`), so its
  bottom edge sits at `(100vh - height) / 2` — **every rem off the height buys
  only half a rem of clearance**, and the clearance is paid at the top too,
  where nothing is in the way. The scrubber is ~5.7 rem tall at `bottom: 1rem`.
  Collapsing makes the collision rare; this makes it impossible, which matters
  because two expanded sections would otherwise put the panel straight back over
  the scrubber.
- `NearestFault` and `RegionalRecurrence` are also used by `LocationPanel`,
  which is not collapsible, so each exports both a `*Body` and a framed
  `*Section`. The frame is the only difference.

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
- **`setInputAction` stores ONE action per event type — a second registration
  silently replaces the first.** Hover picking and drag-deselect both want
  `MOUSE_MOVE`; registering them separately left only whichever ran last, with
  no error and one feature simply never firing. They are now a single handler
  that does drag first, then hover. Same applies to any future MOUSE_MOVE work.
- **`scene.pick()` is a GPU render-target readback, not a cheap CPU test.**
  Running it on every `MOUSE_MOVE` at 60 Hz stalls the pipeline while rotating.
  Hover picking is throttled to 50 ms and skipped entirely mid-drag (the pointer
  is moving the camera; the result would be discarded anyway).
- **A `PolylineCollection` pick returns a `Polyline`, not an `Entity`.** There is
  no entity id to look up, so the faults layer attaches the `FaultRecord` itself
  as `id` at `add()` time — that is the only channel by which a pick can say
  *which* fault. Plate boundaries and subduction zones are entities and already
  carried `properties`, so they needed nothing.
- **Cesium property `getValue()` is typed `unknown`; narrow it, never `String()`
  it.** Coercing a non-string yields `"[object Object]"`, which then renders as a
  plausible-looking plate pair rather than failing visibly.
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
- **`.parent element { ... }` out-specifies a bare state class, and the failure
  is invisible.** Both mode switches wrote `background: none` on
  `.switch button` / `.hypothesisSwitch button` — specificity (0,1,1) — while
  the selected state set `background-color` on `.active` / `.hypothesisActive`
  at (0,1,0). The element-qualified rule wins regardless of source order, so
  **the "filled = active" fill never rendered at all**, leaving near-black text
  on a dark panel: the selected item was the least readable thing in the
  switch. Nothing errored, the CSS read correctly at a glance, and it survived
  every review until a user said the tabs were hard to read. Confirmed with
  `getComputedStyle` — the active tab reported `rgba(0, 0, 0, 0)` — rather than
  by reasoning about the cascade. **Put state styling on state classes only**,
  and reach for computed styles before arguing about colour values.
- **The fix also changed polarity, on the user's call**: the active tab is now
  cyan text on an 18% cyan tint, not dark text on a solid fill. Solid-fill +
  dark text is fine at 13px (the Run button) and muddy at 11px inside an
  otherwise dark UI, whatever its luminance ratio says — the same
  "pick the right metric" lesson the depth ramp taught, applied to type.
- **Never read `Date.now()` during render** — use `useNow`. It's impure, and
  nothing re-renders when a clock ticks, so the value silently goes stale.
- Layers declare `consumesEvents`; those that don't are not rebuilt when the
  poll lands. Geology doesn't change every five minutes.
- `COVERAGE_TIERS` in `packages/schema` is read by **both** main and renderer,
  so what the UI offers and what ingest fetches cannot drift apart.

---

### Every layer explains itself

**A new layer must ship with a guide** — `panels/layer-guides.ts`, one entry per
layer id, surfaced by the `?` in the layer panel and the legend.

This is enforced by `layer-guides.test.ts`, not by convention: adding a layer to
the registry **fails the suite** until someone either writes its guide or puts it
on `GUIDES_STILL_NEEDED` deliberately. A rule in a document gets forgotten; a red
test does not. **That list is currently empty** — all twelve layers are written
up — and it is worth keeping that way; it is a deliberate "not yet", not an
escape hatch.

The shape is fixed at four sections — what it shows, how to read it, **what it
can't tell you**, where it came from. The third is why the feature exists. Nearly
every layer here carries a caveat that changes what a reader may conclude (the
field cannot show a storm; the aurora does not follow the scrubber; TEC's crests
overlap 68% of large quakes for reasons unrelated to earthquakes), and until this
existed all of it lived in code comments where no user would meet it. The app was
already careful not to *draw* anything untrue — this is the other half.

The fourth section is also where `SOURCES.md`'s attribution gets paid: a licence
condition is not satisfied by a file in the repo that nobody reading a rendered
map ever opens.

## Phase 4 — Statistical Engine. Started.

**Python statistical engine, round 1 — H4c shipped end-to-end.** `engine/`, a
new Python 3.12 package outside the pnpm workspace (deliberately — `pnpm -r
test` must not break for anyone without Python installed). FastAPI, numpy,
scipy; no statsmodels (Benjamini-Hochberg is ~10 lines, hand-rolled and
cross-checked against `scipy.stats.false_discovery_control` rather than
adding a dependency for it). `engine/README.md` has the setup/run/test
commands.

**Dev-only this round, and that's a scope decision, not an oversight.**
Electron main adopts an already-running engine on 127.0.0.1:8787 (the normal
dev loop — run `pnpm engine:dev` in a second terminal) or spawns one itself;
either way, failure is a typed status (`python-not-found`, `start-timeout`,
`contract-mismatch`, `crashed`, ...) pushed to the renderer, never a crash —
same posture as a missing DONKI key. A packaged build reports the engine
`unavailable` and Analyze mode stays visible rather than hidden, because a
hidden feature is a second code path nobody exercises. PyInstaller/bundling
is still open (§10 of `PROJECT_PLAN.md`).

**Why H4c first, not H5 (which has richer Explore-mode prior art) or H1b.**
H4c (Kp/Dst geomagnetic disturbance) needs zero new ingest — Kp since 1932,
Dst since 1963 are already in the database — and its
threshold→episode→lag-window-ratio→Poisson→Monte Carlo shape is shared by
H1b, H2b and H3b almost unchanged, so proving it once pays off for four of
the five remaining hypotheses. H5 at that time was thought to need a
magnitude-of-completeness map (it did not — see its entry below) and
doesn't exist yet and uses a structurally different KS-test shape; it's next,
once that map is built. H1b needs a GOES 1996-2016 flare ingest this app
doesn't have yet.

**Gardner-Knopoff declustering is an independent Python port, not a call into
the TS code — and the two are verified to agree, not just assumed to.**
`engine/terra_pulse_engine/pipeline/decluster.py` ports the exact formulas
from `packages/schema/src/aftershocks.ts`, including the M6.5 seam's
deliberate non-monotonicity (see that file's own note — don't "fix" it in
either language independently). Pinned against GK's published Table 1 in
both languages, and against a shared real-data fixture
(`engine/tests/fixtures/gk_parity.json`, 1,461 real M5.0+ events from
2011-01-01 to 2011-06-01, including the Tohoku M9.1 sequence) asserted by a
test in each language. They agree exactly: 609 of 1,461 survive as
independent, same ids, both implementations.

**The moving-window Poisson baseline exists because a pooled one would
manufacture a correlation, and this is executable, not just argued.**
`pipeline/baseline.py`'s `local_rate_per_hour` estimates the background rate
within a window (±half the registered baseline width) centred on each
trigger rather than pooling across the whole record — H1b's own registered
mitigation for the catalogue's ~36%-per-five-decades secular drift at M5.0+,
which H4c's completed registration (below) adopts for the same reason.
`test_baseline.py` plants a synthetic secular trend and shows a pooled
estimate is biased at both edges while the moving-window one isn't — the
test *is* the argument for why M5.0+ is defensible here.

**H4c's registration had four implied parameters, and they were completed in
`HYPOTHESES.md` before any code ran, not decided in code.** The original
2026-08-14 entry specified the trigger (Kp≥6 or Dst≤−100), the lag windows
and the 1963 time range, but left the episode definition, the baseline
window width, the null-resampling scheme and the tail implied — which rule 2
forbids. Completed in place (not as a new H4d entry) on 2026-08-18, because
H4c had never been run: rule 3's "amendments are new entries" exists to stop
edits *after* a result is known, and there was no result here to protect.
Also completed there: an "Effective span" field, because the registered 1963
start reflects only when Kp/Dst exist, not when the M5.0+ target catalogue
does — that's 1970, the same boundary the earthquake archive's own Tier 1
uses, for the same reason (pre-1970 records are the pre-WWSSN-network era).
The engine truncates to 1970 and reports the truncation explicitly rather
than absorbing it silently.

**The M5.0-vs-M5.5 tension this file itself raised is real, and the
resolution is: honor the registration.** Elsewhere in this file, the
caching-strategy notes say "Analysis must use M5.5+, not M4.5+" and name
H1–H5 as "the single largest threat" — but `HYPOTHESES.md` registers H1b
through H5 at M5.0+, and H1b's own entry shows this was a considered
tradeoff (a local baseline fixes the secular-drift problem without needing
to throw away 3.7× the target events). Per the user's explicit decision this
round: `HYPOTHESES.md` is the pre-registration of record, so M5.0+ stands
for these hypotheses. `ARCHIVE_ANALYSIS_MIN_MAGNITUDE = 5.5` is untouched —
it governs Explore's own rate claims, a separate thing, and this doesn't
change that.

**Analyze mode is the app's first non-Explore surface, and non-negotiable #1
gets defence in depth, not one guard.** `useAppModeStore` (`'explore' |
'analyze'`, not persisted — a fresh launch always opens in Explore).
`App.tsx` mounts `ExploreShell` or `AnalyzeShell`, never both — genuinely
unmounted, not hidden, so nothing Explore-side is running while Analyze is
active. Four independent layers keep a p-value from ever reaching Explore:
the `renderer/src/analyze/**` directory boundary; `useAnalysisStore.ts` being
the *only* place an `AnalysisResult` is held; an ESLint `no-restricted-imports`
rule scoped to `panels/`, `layers/`, `globe/`, `state/` forbidding imports
from `analyze/` or the analysis types from `@terra-pulse/schema` (verified to
actually fire on a deliberate test violation, not just written and trusted);
and `analyze/explore-purity.test.ts`, which scans Explore source for a
p-value identifier or a rendered p-value literal like `p = 0.03`.

**That last scan went through one real revision, worth remembering.** The
first draft also matched bare "correlation" and "significan(t/ce)" as
substrings, and immediately found two permanent false positives in real
code: `event.significance` is USGS's own field name (nothing to do with
statistics), and `AntipodalSection.tsx`'s own doc comment *quotes* `"p =
0.03"` while explaining why Explore doesn't print one. Both are legitimate
Explore-mode prose. The scan now matches only `pValue`/`pAdjusted`
identifiers and a numeric p-value literal pattern, with comments stripped
before matching — precise signals instead of words that this codebase's own
documented design-rationale style will always contain somewhere.

**Cesium stays mounted across the mode switch.** Nothing is destroyed
switching to Analyze (non-negotiable #5 untouched) — remounting the viewer
would re-run every layer's mount/unmount path for zero benefit.

**End-to-end verified against the real dev database, not just synthetic
fixtures.** 92,106 raw M5.0+ events (effective span), 48,371 declustered,
496,423 space-weather hours since 1970. Trigger counts — 1,149 Kp≥6
episodes, 511 Dst≤−100 episodes — match an independent SQL/JS recomputation
exactly. The result is a clean null (ratios 0.975–1.014, nothing rejected at
q=0.05 even before FDR), which is the expected outcome given H4c's own
registered "low" mechanism plausibility — null results are results
(`HYPOTHESES.md` rule 5), and this one is reported with the same weight a
rejection would get.

**Measured cost: ~30 seconds per run, not the "seconds" this round's plan
estimated.** Declustering the 92k-row catalogue is fast (well under a
second, vectorised via `np.searchsorted` plus windowed haversine); the cost
is `hypotheses/h4c.py`'s permutation loop, which draws one redrawn trigger
set per iteration in a plain Python `for` loop rather than a fully
batch-vectorised call. Comfortably inside the single-POST design's 120s IPC
timeout, so this round's "no progress/cancel UI" call still holds — but it's
the first place to optimise if a future hypothesis's data volume pushes it
further. Noted in `engine/README.md`, not fixed this round.

**FDR reports two adjusted values per test, because the registered matrix
isn't complete.** `pipeline/multiple_comparisons.py`'s `benjamini_hochberg`
takes a `family_size` separate from the number of p-values actually
supplied: this round reports BH within the 6 tests run *and* BH against the
19-test unblocked registered matrix (H1b 4 + H2b 2 + H3b 4 + H4c 6 + H4b 2 +
H5 1 — H6's 2 stay deferred to Phase 5, H4b's 2 stay blocked, no
magnetometer table exists), and the 19-test figure is always the
conservative one the UI leads on. `correction.partialMatrix` and a
plain-English note travel with every result rather than letting a UI
convention carry that caveat alone.

**Next:** H1b, H2b or H3b (same pipeline shape, minor parameter changes —
proving that reuse was the point of choosing H4c first), or the
magnitude-of-completeness map H5 was thought to need — see the H5 entry below for why it turned out to be unnecessary.

**H3b shipped the same morning — and the reuse bet paid off exactly as
argued above.** Coronal hole high-speed streams (OMNI2 wind speed) vs.
declustered global M5.0+ rate. `hypotheses/h3b.py` is ~90% the same shape as
`h4c.py` — one trigger instead of two, four lag windows instead of three, a
1995 registered start instead of 1963 — and needed **zero** changes to
`pipeline/`. Chosen over H1b (needs a GOES 1996-2016 flare ingest this app
doesn't have) and H2b (a structurally different hemispheric-split test, not
a lag-window one) specifically because it was the cleanest test of whether
round 1's pipeline actually generalized.

- **Registration gap, same category as H4c's.** H3b's trigger definition and
  gap-handling rule were already fully registered (2026-08-15); what was
  missing was the baseline window, null model and tail — completed
  2026-08-19, and **identical to H4c's** (±182.625 days, uniform-redraw,
  one-sided upper) for the identical reason (the same M5.0+ secular-drift
  problem), not copied out of laziness. Unlike H4c, no separate "effective
  span" note was needed: 1995 already sits inside the catalogue's own
  1970-onward completeness window, so nothing truncates what was registered.
- **`pipeline/triggers.py`'s `extract_threshold_episodes` needed no changes
  at all** — `min_consecutive_hours=6` was the exact second use case it was
  built for on day one. The only genuinely new code is `hypotheses/h3b.py`
  itself (assembly, ~250 lines, closely mirroring `h4c.py`) plus widening
  the request contract (`series` literal gains `wind_speed`, `SeriesPayload`
  gains `windSpeed`) and the registry (one new entry).
- **Catalogue queries now reach back to `ARCHIVE_START_YEAR` (1970)
  regardless of hypothesis**, not each hypothesis's own registered start —
  `apps/desktop/src/main/ipc/analysis.ts`'s `CATALOG_QUERY_START_UTC`.
  Declustering benefits from full context (a pre-1995 mainshock can still
  correctly claim a post-1995 aftershock); each hypothesis module filters
  its own *target* set to its own registered start afterward. Costs H4c
  nothing (it already filtered to 1970), and gives H3b real declustering
  context across its own 1994/1995 boundary it wouldn't otherwise have had.
- **The UI generalized to a hypothesis switch, not two hardcoded panels.**
  `AnalyzeShell` now fetches the engine's own `/v1/hypotheses` list
  (`useEngineHypotheses`) and renders a small selector when more than one is
  implemented; the header, statement and "N tests in this family" line are
  all derived from whichever is selected, via a `HYPOTHESIS_COPY` lookup
  that is presentation only (never crosses into the engine request). A
  first attempt defaulted the selection inside a `useEffect` calling
  `setState` — React's own lint rule caught it (`set-state-in-effect`): there
  was nothing to *subscribe* to, so it was a plain derived value
  (`explicitSelection ?? implementedHypotheses[0]?.id`) computed in the
  render body, not a sync.
- **End-to-end verified the same way H4c was**, against the same real dev
  database: 54,219 raw M5.0+ events (1995+), 27,315 declustered, 1,357 wind
  stream onsets (≥500 km/s for ≥6 measured hours) — matching an independent
  SQL/JS recomputation of the same gap-handling rule exactly. Expected daily
  rate (~2.357/day) matches the catalogue's own global declustered rate
  (~2.368/day) to within 0.5%. Clean null again (ratios 0.985–1.021),
  consistent with H3b's own registered "low" mechanism plausibility. Cost:
  ~37s, same order as H4c's ~30s — the permutation loop, not declustering,
  is still the bottleneck, and it's the same one both hypotheses share.
- **Next:** H1b or H2b are what's left of the four originally considered;
  H5 shipped 2026-08-20 without needing the completeness map at all.

**H2b shipped the same day, and it is the one that actually tests whether
this design generalizes.** H4c and H3b are both "threshold on a series →
episode → lag-window ratio → moving Poisson baseline → Monte Carlo" — H2b
is a hemispheric rate ratio with **no baseline at all**, its trigger set is
discrete CME arrivals rather than anything thresholded, and its null comes
purely from permuting arrival instants. Chosen over H1b specifically because
it needed zero new ingest (arrival time, glancing-blow and minor-impact
flags are already stored) while still exercising a structurally different
part of the pipeline — H1b would only have proven more parameter reuse on
the same shape H3b already proved.

- **The request contract had to split, not grow more optional fields.**
  H2b's parameters genuinely have no `baselineWindowDays` — there is no
  baseline in this test at all — so widening the existing
  `AnalysisParameters` model with nullable fields would have reopened
  exactly the "field present but silently unused" gap non-negotiable #3
  exists to close. `contracts.py` now has `LagWindowRunRequest` (H4c/H3b)
  and `HemisphereRunRequest` (H2b) as genuinely separate, fully-required
  models; `api/main.py` reads `hypothesisId` from the raw body first, then
  validates the rest against that hypothesis's own model, rather than
  FastAPI validating one shared shape automatically. Same single
  `/v1/analysis/run` URL and same typed-422 behaviour either way — the
  dispatch moved, not the contract surface a caller sees.
- **`pipeline/subsolar.py` is a straight port of the magnetopause layer's
  `subsolarPoint`** (`apps/desktop/src/renderer/src/layers/magnetopause.ts`),
  not a re-derivation — same reasoning as porting Gardner-Knopoff rather
  than re-implementing it from the paper. Pinned against the exact same
  reference instants that TS function's own test suite uses (solstice/
  equinox declination, the ~15°/hour westward drift, legal-longitude
  bounds) rather than a fresh tolerance, so a divergence between the two
  independent implementations would fail a test on whichever side drifted.
- **"Subsolar longitude ±90°" is a longitude band, not a 3D angular
  distance from the subsolar point** — completed into H2b's registration
  alongside the other implied parameters (null model, tail, the inherited
  M5.0+ floor). Latitude never enters the classification. This is the
  literal reading of "subsolar **longitude**", it splits the globe exactly
  in half by construction regardless of season (a true angular cap from the
  subsolar *point* would shrink and grow with solar declination), and it's
  the conventional approximation for a day/night terminator test.
- **A real performance bug, caught by this round's own end-to-end
  verification against the real database, not by a user report.** The
  first working version of `pipeline/hemisphere.py` called
  `subsolar_longitude_deg` and `np.searchsorted` once *per trigger* inside
  a Python loop, and that function runs once per Monte Carlo permutation —
  10,000 times per lag window. At the real direct-impact trigger count
  (580, measured against the dev database) that is **>11 million
  individual numpy calls per lag window**. Measured: it exceeded 5 minutes
  and tripped the verification client's own HTTP timeout before finishing
  — nowhere near the app's 120s IPC budget. Vectorizing the subsolar call
  alone (one call for all 580 triggers instead of 580 calls) wasn't
  enough; the fix had to also vectorize the window search
  (`np.searchsorted` accepts a vector of query points and returns a vector
  of results in one call) and the near/far classification, flattening
  every trigger's matched window into one `(target_index, trigger_index)`
  pair array via `np.repeat` rather than looping. Same "hoist the per-row
  work" lesson the IGRF field grid's `sampleFieldGrid` already
  demonstrates, applied here to a different kind of per-row cost (search +
  classification, not trigonometry) and a much larger multiplier (permutation
  count × trigger count, not grid cells). **Result: >5 minutes (timed out)
  → 17.4 seconds** on the real 92k-row catalogue and 580 real triggers,
  correctness unchanged (every existing pytest, including the planted-excess
  and determinism tests, passed before and after with identical values).
  **Any future hypothesis whose `statistic_fn` loops over triggers inside
  the Monte Carlo loop needs this same check before it's called done** —
  the pattern is invisible on the small synthetic test fixtures (tens of
  triggers) and only shows up at real data volume.
- **End-to-end verified against the real dev database**: 22,201 raw M5.0+
  events since 2014, 11,321 declustered, 580 direct-impact CME arrivals
  (matching an independent SQL/JS recomputation of the same
  `isDirectImpact` filter exactly). Another clean null (ratios 0.925–1.063,
  nothing rejected), consistent with H2b's own registered "low" mechanism
  plausibility. The near+far totals per window are close to what the
  catalogue's own declustered rate predicts by back-of-envelope (~1,427
  expected vs. 1,345 observed for the 24h window), which is the same kind
  of sanity check H4c's and H3b's verifications used.
- **The Analyze-mode hypothesis switch built for H3b needed zero changes**
  to support a third, structurally different hypothesis — `AnalyzeShell`
  already sourced its hypothesis list from the engine's own
  `/v1/hypotheses` and rendered whichever was selected generically. The one
  UI change was making `MethodInfo.baselineWindowDays` nullable (H2b has
  none) and rendering `spatialSplitDegrees` alongside it when present —
  the registered-parameters block already only shows fields that exist.
- **Next:** H1b's ingest is now built (see the GOES XRS entry below), so what
  remains for it is the engine module and its registration completion; H5
  shipped 2026-08-20 (the completeness map turned out to be unnecessary).

**Tabbed Analyze results — shipped (2026-08-19).** `useAnalysisStore` is now
keyed by hypothesis (`Record<HypothesisId, {result, running, error}>`) rather
than one shared slot, so switching the hypothesis tab strip no longer clears
whatever the previous tab had. The record is written out explicitly for all
three ids rather than built from an array, so widening `HypothesisId` — the
next candidate is H1b — fails to compile here until this record grows too,
the same forcing function `HYPOTHESIS_COPY` already relies on.

- **Switching tabs never cancels an in-flight run** — confirmed with the
  user rather than assumed, since the alternative (cancel-on-leave) was
  equally plausible and there's no cancel endpoint on the engine side
  anyway. A run left going lands in its own tab's slot whenever it
  resolves, whichever tab is on screen at the time.
- **Every `set()` in `run()` uses the functional form**, not a closed-over
  snapshot — two hypotheses running concurrently (start H4c, switch tabs,
  start H3b before H4c finishes) each write against the *latest* state, so
  neither can clobber the other's slot on completion.
- **Each tab shows its own running/error status as a small dot**, not text —
  pulsing cyan while that hypothesis's run is in flight, red on error —
  because a run left going in the background has no other visible trace
  once you've switched away from its tab. Unlike the collapsible-section
  disclosure state (deliberately neutral, no hue — see above), this *is*
  colour-coded: it's operational status, not a significance verdict.
- **Verified against the real engine and dev database**, not just unit
  tests: built the app, ran H4c to completion, confirmed switching to H3b's
  tab shows the empty "not run yet" state rather than H4c's result, started
  H3b and switched back to H4c mid-run to confirm its table is byte-identical
  and the H3b tab carries the running dot while inactive, then confirmed
  H3b's own result lands correctly and H4c's is still untouched after a full
  round trip.

**GOES XRS historical flare ingest — shipped (2026-08-19).** H1b's registered
source below 2017, and the last hypothesis that needed new ingest. Round 1 of
two: the engine's `h1b.py` and the registration completion are next.

- **Nothing ingested this before, and H1b would have run on a quarter of its
  data.** `solar_flares` had exactly one writer — the DONKI backfill, starting
  at 2010 — so a run today would have got **zero flares before 2010** and, per
  the coverage table already in `solar-events.ts`, **23-25% of M/X for
  2011-13**, against a registration claiming a validated record from 1996.
- **The parser was validated against numbers this repo already had.** Counting
  M/X per year reproduces `FLARE_COMPLETE_SINCE_YEAR`'s independently-measured
  table **exactly** across all six DONKI-overlap years (2011:119, 2012:130,
  2013:111, 2014:221, 2016:16). That table was measured when H1 was written, so
  it is a real cross-check rather than a tautology. Stored: **36,288 flares for
  1996-2016, 2,304 at M1.0+**; largest X28 at 2003-11-04T19:50Z in AR 10486,
  which is the largest ever recorded and lands where the record says.
- **The unexplained 2015 disagreement is explained, and NOAA had already fixed
  it.** `solar-events.ts` recorded GOES 106 M/X against DONKI's 126 for 2015 as
  "real and unexplained", guessing the GOES report was partial across a
  satellite transition. It was: NOAA publishes
  `goes-xrs-report_2015_modifiedreplacedmissingrows.txt` for that year alone,
  carrying **119**. The ingest takes it, and `HYPOTHESES.md` records the
  filename exception — it moves 13 real M/X flares into a solar-max year's
  trigger set, so it is not a detail to leave in code.
- **`querySolarFlares` now defaults to one catalogue per year, not to
  everything stored.** Both catalogues overlap across 2014-2016, so an
  unfiltered read returns the same flare twice — double-counted in H1b and
  drawn twice on the globe. `preferredFlareSourceFor` is the single definition
  (GOES ≤ 2016, DONKI above), shared by the query layer, the globe and the
  analysis, the same reasoning that makes `displayWindow` single. Verified
  through the app's own IPC: 2014-2016 returns **5,412 rows, all GOES**, with
  the 400 overlapping DONKI rows correctly excluded. `{ source: 'all' }` is the
  explicit opt-in that checking the join needs.
- **Duplicates are real here and DONKI's "no dedupe, deliberately" does not
  transfer.** 305 groups of rows share a flare identity across 1996-2016, **294
  of them byte-identical repeated lines**. The synthesised `goes:<peak>-<class>`
  id collapses them, which is what makes re-running the backfill an upsert. Of
  the 11 groups that genuinely differ, every one is the same flare re-reported
  with different completeness — `richerOf` keeps whichever says more, so line
  order doesn't decide. All 11 are C class or below, so none reaches a trigger.
  Confirmed after the real run: **16 peak instants carry two flares, and zero
  pairs share a class** — those are genuinely distinct overlapping flares from
  one active region, which NOAA lists separately and we keep separately.
- **242 rows genuinely cross midnight** (`2359 0008 0004`), 24 of them M/X.
  Reading the peak on the start date would put those triggers 24 hours early.
  Four further rows are anomalous — peak before start on an event that does not
  cross midnight — and are dropped rather than guessed at; all four are B/C.
- **Its own controller and chunks table, not DONKI's.** `donki_chunks.source`
  carries a CHECK that SQLite cannot alter, so reusing it would force a
  create-copy-drop-rename for no benefit. The controller is also strictly
  simpler: the range is **closed at 2016 and entirely in the past**, so every
  year is final and recordable and there is no current-year rule; and with no
  429 to handle, the `for(;;)` retry wrapper, the `'waiting'` state and
  `retryAtUtc` are all absent. No poller either — the reports will never gain a
  row.
- **Migration 11 is adds-only** — `source TEXT NOT NULL DEFAULT 'donki'` is
  correct for every existing row, so it backfills itself with no UPDATE.
  Verified against a copy of the real 219 MB database: **4.9 s**, all 314,548
  earthquake / 829,557 space-weather / 3,355 flare rows preserved, every
  pre-existing flare reading back as `donki`.
- Measured cost of the whole backfill: **16.5 s for 21 requests, ~2.7 MB**.
  Still user-triggered rather than automatic, like every other historical record
  here — fetching a thirty-year archive on someone's behalf at launch is not a
  thing to start doing quietly.
**H1b shipped the same day — the fourth hypothesis, and the one that needed a
real optimisation rather than more parameter reuse.** Solar flares (GOES
1996-2016 + DONKI 2017 onward) vs. declustered global M5.0+ rate. Clean null:
ratios 0.974–1.011, smallest raw p = 0.0872, all four adjusted to 1.0000 against
the 19-test matrix.

- **Its registration was completed before any code ran**, same rule and same day
  as H2b's. The baseline window's *width*, the null model and the tail were
  implied but never stated; the engine's contract requires all three, so it
  physically could not run until they existed. ±182.625 days / uniform-redraw /
  one-sided upper — H4c's and H3b's values, and this is the hypothesis whose own
  measured drift is the argument for them, so it is one mitigation applied to
  the case that motivated it rather than borrowed parameters.
- **Structurally it is h4c.py's statistic with h2b.py's trigger delivery**, which
  is why a third request family was needed rather than a nullable field.
  `series` is required and non-nullable on `LagWindowRunRequest` by design, and
  `TriggerParameters` describes a threshold crossing on a continuous series —
  there is no `series` literal that could name "M1.0+ flare peak times".
  `pipeline/triggers.py` is unused here entirely; the null pool is every hour in
  the span, as H2b's is, because a flare catalogue has no series whose gaps
  could disqualify an hour.
- **The performance problem was real and the obvious fix was not enough.**
  4,598 triggers against H4c's largest of 1,149. The per-row loop h4c.py uses
  would have taken ~110 s; batch-vectorising it across the permutation
  dimension gave **102 s against main's 120 s timeout** — inside the budget
  with no headroom worth having, because the fundamental work is unchanged when
  only numpy call overhead is removed.
- **What actually fixed it: both quantities the null needs are pure functions
  of the trigger instant, and the null draws from a fixed hourly pool.** So the
  baseline rate and the lag-window count are evaluated **once per eligible
  hour** (268,531 of them) and read by index, instead of four binary searches
  per drawn trigger per iteration. Because the pool is a uniform `arange`, a
  drawn time maps back to its index by exact integer arithmetic — no search at
  all. **102 s → 12.2 s, and every observed count, ratio and p-value is
  bit-identical.** ~4 MB for the two tables.
  - This is exact, not an approximation, and it is pinned that way:
    `test_h1b.py` asserts `np.array_equal` (not `allclose`) against a per-row
    reference built from the same pipeline functions, plus a separate test that
    the index arithmetic recovers the pool exactly — because a future change to
    how the eligible pool is built would break that silently and produce
    plausible wrong numbers rather than an error.
  - **The generalisable lesson, and it is not "vectorise":** it is that a
    statistic recomputed per Monte Carlo draw over a *finite, known* domain
    should be precomputed over that domain instead. h4c.py's own note says the
    per-row loop is "the first place to look"; the answer turned out to be one
    level up from that.
- **`flareCoverageComplete` is the guard round 1 flagged, and it is not a
  registered parameter.** The GOES record is a separate user-triggered
  download, so main reports whether it actually holds all 21 years and the
  engine leads its caveats with `INCOMPLETE TRIGGER SET` when it does not.
  Chosen over refusing to run: the same posture as the recurrence panel, which
  states what it can and says plainly what is missing.
- **Verified end-to-end against the real database and then in the running app**:
  4,598 triggers (2,302 GOES + 2,296 DONKI, matching an independent SQL
  recomputation of the same M1.0+ filter and the same registered join), 26,577
  declustered targets from 52,726 raw. Internal consistency: the 3–7d window's
  expected count is exactly 4.0000× the 24-hour windows', as it must be when
  expectation is rate × duration. The tab strip built earlier the same day took
  a fourth hypothesis with no change beyond the two `Record<HypothesisId, …>`
  forcing functions, which both failed the build until updated — as intended.
- **`HYPOTHESES.md` has drifted and it is worth fixing.** H4c, H3b and H2b were
  all run in earlier rounds and all returned clean nulls, but their `Status`
  fields still read "Not yet run". H1b's is now recorded properly; the other
  three are not, which means the pre-registration of record understates how much
  of the matrix has been tested.

**H5 shipped 2026-08-20 — the fifth hypothesis, the first with a genuinely
different statistic, and the one whose most useful output was a finding about
its own method.** Declustered M6.0+ mainshocks vs. the distance-to-antipode
distribution of declustered M5.0+ events in the following 0-72h. Clean null:
**KS D⁺ = 0.0016 against a null mean of 0.0024**, p = 0.6203 raw, 1.0000
adjusted. 17 of 19 unblocked tests are now run; only H4b's 2 remain, blocked on
magnetometer data.

- **The magnitude-of-completeness map it was blocked on for weeks turned out to
  be unnecessary, not merely deferred.** The registered null redraws *trigger
  instants only* — every target stays where the catalogue recorded it and every
  antipode stays where it is — so observed and null are built from the same
  detected events and **detection bias cancels instead of being estimated**. An
  Mc map would have added several free parameters (grid size, estimator, minimum
  events per cell) to approximate what the shuffle conditions on exactly, which
  under non-negotiable #3 is strictly worse. The four "blocked on the Mc map"
  notes across the docs are corrected rather than deleted, with the reasoning.
- **The registered test turned out to be insensitive to its own hypothesis, and
  that is the round's real result.** "No fixed radius" was chosen in 2026-07-24
  to avoid p-hacking a search radius, and that reasoning was sound. But a KS
  statistic puts its sensitivity where the probability *mass* is, and the
  near-antipode region holds **0.05% of it**. The two-sided D came out at 0.0442
  — 27× the D⁺ — driven entirely by the **far** tail: 5.56% of windowed events
  land within ~500 km of the *trigger* against 1.57% expected, which is residual
  near-trigger clustering surviving Gardner-Knopoff and has nothing to do with
  antipodes.
  - **The lesson generalises and is worth carrying into future registrations:**
    "avoid a free parameter by testing the whole distribution" is not
    automatically the conservative choice. It can trade a p-hacking hazard for a
    power failure. Ask what fraction of the distribution's mass lies in the
    region the hypothesis is about — **at registration time**.
  - The descriptive near-antipode comparison (2.2× within 250 km, ~24 events
    against ~11) is recorded in `HYPOTHESES.md` because hiding it would be
    worse, and fenced with what it is not: turning any row of it into a test
    means choosing a radius after seeing the data, which is what the original
    registration forbade.
- **The user's ~30°-from-antipode question was researched and deliberately not
  tested.** It has a real basis — antipodal focusing is strongest at 180° and
  falls off within a few degrees, while the **PKP caustic near 140° epicentral
  (40° from the antipode)** is a second documented convergence. It is recorded
  under Exploratory Observations *before* the run, with the condition that a
  band test needs a citable source and its own FDR slot. Registering one now, at
  whatever radius this run's distribution happens to bump, is precisely the trap.
- **`pipeline/ks.py` is the first new pipeline module since round 1**, which
  `engine/README.md` sanctions only for "a genuinely new kind of statistic" — a
  supremum-of-CDF-difference is one, and no amount of parameter reuse gets there.
  The reference CDF is the **exact all-pairs distribution** (every trigger
  antipode against every target), accumulated as a histogram in chunks because
  the real catalogue's pair matrix is 280M doubles. 51 s total, well inside the
  120 s budget; unlike H1b no optimisation was needed.
- **Three new nullable response fields, and they fix an existing wrong.**
  `TestResult` requires `observed`/`expected`/`ratio`, so every hypothesis puts
  *something* there — H2b's have been near/far hemisphere counts rendering under
  headers reading "Observed"/"Expected" since it shipped, which states something
  false about what the number is. `observedLabel`/`expectedLabel`/
  `statisticLabel` let the table headers follow the statistic; `MethodInfo`
  gains `completenessModel`, without which H5's results panel would have listed
  every registered parameter *except* the one the whole test turns on. All
  additive, so **`CONTRACT_VERSION` does not move** — its own rule is that it
  bumps when a field's *meaning* changes, not when one is added.
- **A degenerate run now announces itself.** Zero triggers, or zero targets in
  any window, produces D⁺ = 0 and p = 1 — arithmetically correct and
  indistinguishable from a genuine clean null. Both are unreachable on the real
  catalogue; the guard exists so that if one ever is reached it cannot be
  mistaken for a result.
- Registered self-exclusion is implemented as `side="right"` on the window's
  lower bound: an M6.0+ trigger is itself in the M5.0+ target set and sits at the
  antipodal maximum from its own antipode, so without it every trigger would
  contribute one artefact to the far tail. The null needs no equivalent and must
  not have one — its drawn instants are not real events.

## Non-negotiables

These are architectural decisions, not preferences. Do not quietly change them.

1. **Explore mode never displays significance claims.** No p-values, no
   correlation coefficients, no "this looks related." It shows data on shared
   axes and nothing more.
2. **Declustering happens before any statistical test.** Raw catalogs contain
   aftershock sequences that will masquerade as signal. Gardner-Knopoff
   minimum.
3. **No free parameters chosen after seeing results.** Search radii, lag
   windows, magnitude bins — all fixed in `HYPOTHESES.md` before the test
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

**Licences, redistribution and credentials live in `SOURCES.md`.** Two standing
rules come out of it and constrain what may be added:

1. **Never bundle bulk third-party data** into the repo or the installer — every
   install fetches its own. It is what keeps the non-commercial and
   no-bulk-distribution terms satisfiable.
2. **No source may require the user to create an account.** A layer that does
   nothing until someone registers with a third party is broken for everyone who
   doesn't. An optional *API key* with a working fallback is fine; a mandatory
   *account* is not.

**SuperMAG was evaluated and rejected on rule 2** despite being the best archive
source technically (~180 stations, uniform processing, baseline-subtracted). Its
rules also forbid redistribution outright, so no sample database could ever
ship. INTERMAGNET is the archive source instead: CC BY-NC 4.0, no credential,
138 stations, definitive through 2024. See `SOURCES.md` for the full comparison
and for what INTERMAGNET's attribution obliges.


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
`PROJECT_PLAN.md` rather than working around it silently. The plan is
meant to change; it is not meant to drift out of sync with the code.
