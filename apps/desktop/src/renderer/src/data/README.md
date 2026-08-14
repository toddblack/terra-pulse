# Vendored datasets

Static reference data bundled with the app rather than fetched at runtime.

Every file here is **derived** by a script in `scripts/`. Re-run the relevant
script to regenerate; don't hand-edit.

| File | Script | Upstream | Licence |
|---|---|---|---|
| `plate-boundaries.json` | `vendor-plate-data.mjs` | Bird (2003) PB2002 | ODC-BY |
| `subduction-trenches.json` | `vendor-slab2-trenches.mjs` | USGS Slab2 | CC0 |
| `active-faults.json` | `vendor-gem-faults.mjs` | GEM Global Active Faults | CC-BY-SA 4.0 |

The first two are separate sources on purpose — see "Why there is no
motion-arrow layer" below.

**Licence obligations differ and are not interchangeable.** ODC-BY and
CC-BY-SA both *require* attribution, so those two credits appear in the app's
legend as a condition of use. CC0 requires nothing; the Slab2 citation is there
because citing sources is right. CC-BY-SA additionally carries share-alike —
see part 3.

---

# 1. Plate boundaries — Bird (2003) PB2002

## Source

Peter Bird's PB2002 plate model, repackaged as GeoJSON.

| | |
|---|---|
| **Repository** | https://github.com/fraxen/tectonicplates |
| **File used** | `GeoJSON/PB2002_steps.json` (10 MB, 5,824 steps) |
| **Original data** | Bird, P. (2003), *An updated digital model of plate boundaries*, Geochemistry Geophysics Geosystems 4(3), 1027 |
| **Licence** | Open Data Commons Attribution License v1.0 (ODC-BY) |
| **Attribution** | Hugo Ahlenius, Nordpil; Peter Bird |
| **Retrieved** | 2026-07-28 |

ODC-BY requires attribution and permits modification. The credit is surfaced
in the app's legend — a licence condition, not a courtesy — and this file
records that the shipped data is derived rather than verbatim.

**Bundled rather than fetched** because PB2002 is a fixed 2003 publication that
will never change. A runtime fetch would buy nothing and cost both offline
capability and a CSP entry.

### The fields, in Bird's own words

From `original/PB2002_steps_desc.txt`:

- `VELOCITYLE` — *"Velocity of left plate with respect to right plate, mm/a"*
- `VELOCITYAZ` — *"Azimuth of velocity, degrees clockwise from North"*
- `VELOCITYDI` — *"Divergent component of relative velocity (convergence negative)"*
- `STEPCLASS` — one of `CCB, CTF, CRB, OSR, OTF, OCB, SUB`

The velocity is **relative**: how two plates move with respect to each other,
not how either moves over the mantle. Absolute motion would additionally
require Euler poles and a reference-frame choice.

### Why there is no motion-arrow layer

There was one; it was wrong and has been removed. Recording why, because the
fields above make it look like it should work.

"Left" and "right" are defined by the order Bird digitised each segment — not
by any property of the plates. For two *converging* plates, the velocity of
left with respect to right therefore points toward the right-hand side of the
line **by construction**. Measured on the shipped data, it does so for
**1,129 of 1,129 subduction steps — 100.0%**.

That number is a tautology, not a finding, and it's the whole problem:
`VELOCITYAZ` tells you the plates converge and how fast, and *nothing* about
which one dives beneath the other. Drawn as an arrow it renders digitisation
order. Checked against five trenches whose polarity is textbook, it matched
Peru–Chile, Japan and Cascadia, and pointed 180° wrong at Tonga and Sumatra —
3/5, which is a coin flip, which is what a signal-free method scores.

The same gap blocks **cartographic sawteeth**, the conventional way to show
subduction direction. Teeth encode polarity, and polarity is not in this
dataset at any resolution. **That is why Slab2 is vendored separately** —
see part 2 below. It is not redundancy; it is the only source here that knows
which plate goes under.

The velocity fields remain valid for **rate** questions ("how fast is this
boundary moving?"), which need no polarity. They are simply not vectors we can
point on a map.

---

## `plate-boundaries.json` — 185 KB, 1,683 polylines

Contiguous steps sharing a plate pair and step class, merged into runs.

```
[{ b: "AF-AN",      // plate pair
   c: "OSR",        // Bird's step class, retained for reference
   g: "divergent",  // kinematic group the app renders
   p: [lon, lat, lon, lat, …] }]
```

5,824 upstream steps collapse to 1,683 runs — 29% of the raw count, which
keeps entity count in the same range as the earthquake layer. Class varies
correctly *along* a boundary, which the simpler `PB2002_boundaries.json`
(241 features, `Type` populated only for subduction) could not express.

Bird's seven classes map to three kinematic groups:

| Group | Classes | Runs |
|---|---|---|
| convergent | SUB, OCB, CCB | 235 |
| divergent | OSR, CRB | 697 |
| transform | OTF, CTF | 751 |

**Three groups rather than seven** is a measured decision: the dataviz
palette validator passes three categorical colours on the all-pairs test and
cannot pass seven. The finer classes stay in the `c` field.

*(A `plate-motion.json` used to sit here. See "Why there is no motion-arrow
layer" above.)*

---

# 2. Subduction zones — USGS Slab2

## Source

| | |
|---|---|
| **Repository** | https://github.com/usgs/slab2 |
| **File used** | `slab2code/library/forplotting/trenches_usgs_2017.csv` (159 KB, 4,435 points) |
| **Original data** | Hayes, G. et al. (2018), *Slab2, a comprehensive subduction zone geometry model*, Science 362(6410), 58–61 |
| **Licence** | **CC0 1.0 Universal** — public domain dedication |
| **Retrieved** | 2026-07-28 |

CC0 imposes **no** attribution condition and no share-alike, and permits
commercial use. The citation in the app's legend is scientific courtesy, not a
licence term — unlike the Bird credit above, which is required.

Only this one small CSV is used. Slab2 also publishes netCDF grids of slab
depth, dip and thickness; those are far larger and answer a different question
(how deep) than the one this layer asks (which way).

### The columns

`lon, lat, az, bound, slab` — where `slab` is a region code (`sam`, `kur`,
`izu`, …; 21 of them) and `bound` is the plate pair.

**`az` is trench strike, not dip direction.** Measured against seven trenches
whose polarity is textbook, `az` matched strike 7/7 and dip 0/7. The strike is
oriented consistently, so:

> **dip direction = `az` + 90°**

Verified on 16 trenches: **15 correct, median offset 9°**. The two that carry
the argument are **Vanuatu** (dips east, while neighbouring Tonga dips west)
and **Manila** (dips east, while the Philippine trench alongside dips west).
Neighbouring arcs with opposite polarity are the discriminator — a method
using no real polarity information gets one of each pair wrong. The single
miss is the Lesser Antilles at 47°, where the arc is sharply curved and the
hand-entered "due west" expectation is the more suspect number.

That check is a **test**, not a note: see `layers/subduction-encoding.test.ts`.

## `subduction-trenches.json` — 78 KB

```
{ "t": [ { "s": "sam",      // Slab2 region code
           "b": "NZ/SA",    // plate pair
           "p": [lon, lat, …] } ],
  "k": [ { "lon": …, "lat": …,
           "d": 94 } ] }    // dip azimuth, deg clockwise from north
```

- **21 trench runs**, split on region change or a >150 km gap, covering
  **58,935 km**. Two single-point runs (one in the Sumatra file, one in the
  Solomon file) are dropped — a lone point can't be a polyline.
- **376 teeth** at 150 km spacing. Teeth are precomputed here rather than
  derived at render time, so the geometry is testable without a WebGL context.

---

# 3. Active faults — GEM Global Active Faults Database

## Source

| | |
|---|---|
| **Repository** | https://github.com/GEMScienceTools/gem-global-active-faults |
| **File used** | `geojson/gem_active_faults_harmonized.geojson` (10.1 MB, 13,696 faults) |
| **Original data** | Styron, R. & Pagani, M. (2020), *The GEM Global Active Faults Database*, Earthquake Spectra 36(1_suppl), 160–180 |
| **Licence** | **CC-BY-SA 4.0** |
| **Retrieved** | 2026-07-28 |

## What CC-BY-SA actually obligates

Worth stating precisely, because it's commonly misread — including once in
this project's own notes.

**It does not forbid commercial use.** That's CC-BY-**NC**, which this is not.
CC-BY-SA permits commercial use outright. The two obligations are:

1. **Attribution.** Required, and surfaced in the app's legend.
2. **Share-alike on *Adapted Material*** — derivatives *of the dataset*.
   `active-faults.json` is such a derivative, so it carries CC-BY-SA. The
   application source code is not: software that reads a dataset is not an
   adaptation of it, the same way shipping OpenStreetMap data doesn't
   relicense an app.

**The one genuinely unsettled point.** CC-BY-SA 4.0 has no explicit "Produced
Work" carve-out of the kind ODbL provides, under which a rendered map image is
expressly exempt from share-alike. So a screenshot or exported image
containing these fault lines is arguably Adapted Material too. If this project
ever distributes imagery commercially, that is the question to get answered
properly — GEM offers custom licensing for uses that don't fit the default
terms. (Not legal advice; this is the standard reading, not a ruling.)

## `active-faults.json` — 3.16 MB, 13,696 faults

```
[{ z: 0,                   // zoom tier: 0 long, 1 medium, 2 short
   p: [lon, lat, …],       // densified to a 50 km max chord
   n?: "San Andreas (Parkfield)",   // name — only 44.6% have one
   s?: 30.54,              // net slip rate, mm/yr (74.1% have one)
   sl?: 23.16, sh?: 43.26, // its lower/upper bounds, where GEM gives them
   t?: "Dextral",          // slip type / kinematics (97.7%)
   c?: "UCERF3" }]         // source catalogue the record came from
```

**Geometry, a zoom tier, and four attribute columns.** The upstream file carries
~23; the other ~19 (dip, rake, seismogenic depths, exposure quality, references)
stay dropped because nothing displays them and they are what would genuinely
bloat the file.

An earlier version of this note said keeping attributes would "more than
quadruple" it — that was about keeping *all* of them. These four measure at
**+59 bytes per feature, 2.39 MB → 3.16 MB (+32%)**.

**Every attribute key is optional and absence is normal**, which is the thing to
design around: 55% of faults have no name at all, and 26% no measured slip rate.
Code written against the well-populated examples looks broken in the field.

Read by the nearest-fault panel (`panels/NearestFault.tsx`), not by the fault
*layer* — that still uses only `z` and `p`.

**Two upstream traps, both found by measuring rather than reading the schema:**

- 263 `net_slip_rate` values are the literal string `"None"` — Python's `None`
  serialised as text rather than JSON null, and therefore truthy.
- Other rate columns carry free prose where a number belongs (`shortening_rate`
  has *"A huge range of rates from many studies; see Mohadjer (2017)…"*).

`parseMeasurement` in the vendor script rejects rather than coerces, because
`Number("None")` is NaN and a NaN slip rate reaches the panel as a blank where a
figure should be.

**This file is gitignored.** After pulling a change to the vendor script, re-run
it — an older JSON still parses and still draws, but every fault will silently
report as unnamed with no slip rate.

### Zoom tiers

664,447 km of fault across 13,696 features is unreadable all at once, so each
fault carries a tier derived from its length and the layer converts that to a
Cesium `DistanceDisplayCondition`:

| Tier | Length | Count | Drawn when |
|---|---|---|---|
| 0 | ≥ 100 km | 1,279 | always |
| 1 | 30–100 km | 5,712 | camera < 8,000 km |
| 2 | < 30 km | 6,705 | camera < 2,000 km |

The legend says "shorter faults appear as you zoom in", because otherwise a
sparse region reads as *no faults here* rather than *not close enough yet*.

### Geometry is pre-densified

The layer uses Cesium's `PolylineCollection` — necessary at this feature count,
since the Entity API allocates a primitive per feature — and that has no
`ArcType.GEODESIC`. Straight chords cut *through* the ellipsoid, so long ones
sink below the surface and clip at grazing view angles.

Upstream mapping is detailed (median segment 1.1 km) but the longest single
segment is **346 km**, which would sag **2.4 km** underground. The vendor
script splits any chord over **50 km** along the great circle, capping sag at
**49 m** for **+1.6% vertices**. The script throws if that ever stops working,
and a test asserts the 50 km cap against the shipped data.

---

## `igrf-coefficients.json` — 20 KB, 195 coefficients × 27 epochs

Earth's main magnetic field: the 14th generation International Geomagnetic
Reference Field, Schmidt semi-normalised Gauss coefficients to degree 13.

Written by `scripts/vendor-igrf.mjs`.

## Source

<https://www.ngdc.noaa.gov/IAGA/vmod/coeffs/igrf14coeffs.txt>

Produced by IAGA Working Group V-MOD and released January 2025. **Public
domain** — IGRF carries no licence conditions and no attribution requirement,
unlike the CC-BY-SA datasets above. It is cited here because it is the
definitive reference for the field, not because a licence compels it.

## Why the 2030 epoch is materialised at vendor time

Upstream ships 26 five-year epochs from 1900.0 to 2025.0 plus a final column of
**secular variation** in nT/year for 2025–2030. That last column is a rate, not
a value, so every consumer would otherwise need a branch: interpolate below
2025, extrapolate above it.

The script turns it into an ordinary epoch — `2025 + 5 × SV` — so the runtime
does plain linear interpolation across 27 epochs with nothing to get wrong.

This is not an invention. IAGA publish the same model in SHC format with 2030
already present, and the derived values match it **coefficient for coefficient,
worst discrepancy 2.8 × 10⁻¹⁴ nT** — floating-point noise. Verified against
`SHC_files/IGRF14.SHC` from IAGA's own `pyIGRF14` distribution. The plain-text
file is fetched instead because it is a stable URL rather than a zip member.

## Why nothing is truncated

All 13 degrees are kept. A degree-1 truncation is the textbook dipole and is
cheap, but the reason this layer is worth drawing at all is the regional
structure — the **South Atlantic Anomaly** above everything else — and that
lives entirely in the higher degrees. The whole model is smaller than one
basemap tile, so there is nothing to buy by cutting it.

## The date range is load-bearing

1900 to 2030, and **IGRF is definitive back to 1900** — the same year the deep
earthquake archive starts. That is what lets the field layer follow the
playhead across the entire record rather than being a snapshot of today.

Outside that span the model **clamps rather than extrapolates**, and says so
through `igrfCoverage`. Running secular variation forward for decades produces
confident nonsense, and before 1900 there is no trend to run.

## Validation

`igrf.test.ts` pins the implementation to **IAGA's own 12 published test
values** (from `tests/tests_igrf14.py` in the pyIGRF14 distribution), spanning
1900 to 2030. Agreement is within **0.01 nT**, which is the resolution of the
published values themselves — a relative error of 3 × 10⁻¹⁰ against a
~30,000 nT field.

The harmonic synthesis and Legendre recursion are a deliberate port of that
reference implementation rather than an independent derivation. A
spherical-harmonic expansion that is subtly wrong still produces a smooth,
entirely plausible-looking field, so matching the reference is worth more than
matching the mathematics from memory.
