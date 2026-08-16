# HYPOTHESES.md — Pre-Registration Log

**Last updated:** 2026-08-15

---

## Purpose

This file exists to enforce non-negotiable #3: *no free parameters chosen after
seeing results.*

Every hypothesis is written here — with all parameters fixed and a registration
date — **before** the analysis runs. This is what separates a discovery from
the multiple-comparisons trap, where testing enough parameter combinations
guarantees a "significant" result from pure noise.

If a test has been run and the result is uninteresting, that stays in the log.
Deleting failed tests is exactly the behavior this file prevents.

---

## Rules

1. **Register before running.** Add the entry, commit it, then run the analysis.
   Git history is the timestamp.
2. **All parameters explicit.** Magnitude thresholds, lag windows, distances,
   spatial bounds, time ranges, declustering method. No defaults left implied.
3. **Amendments are new entries.** If a parameter turns out to be wrong, do not
   edit the original — register H*n*b with the change and a written reason.
   Both entries stay.
4. **Report the denominator.** Every result states how many tests were run in
   its family. FDR correction (Benjamini-Hochberg, q = 0.05) applied across the
   full matrix, not per-test.
5. **Null results are results.** Record and report them with the same weight as
   positive findings.
6. **Exploratory observations are not hypotheses.** Anything noticed in Explore
   mode goes to §Exploratory Observations below. It becomes a hypothesis only
   when formally registered with parameters — and it must then be tested
   against data that was not used to generate it, where possible.

---

## Shared Parameters

Applied to all hypotheses unless an entry overrides them.

| Parameter | Value |
|---|---|
| Seismic catalog | USGS FDSN, M4.5+ global, 1970-01-01 → present |
| Declustering | Gardner-Knopoff windowing |
| Background model | Poisson, binned by region and magnitude |
| Null distribution | Monte Carlo permutation, 10,000 iterations |
| Multiple-comparison correction | Benjamini-Hochberg FDR, q = 0.05 |
| Completeness correction | Magnitude-of-completeness map (required for spatial tests) |
| Time base | UTC throughout |

---

## Registered Hypotheses

### H1 — Solar flares and global seismicity rate

| Field | Value |
|---|---|
| **Registered** | 2026-07-24 |
| **Status** | Not yet run |
| **Statement** | X- and M-class solar flare occurrence is followed by an elevated global M5.0+ earthquake rate. |
| **Solar source** | NOAA SWPC edited event reports + GOES X-ray flux |
| **Trigger set** | Flares classified M1.0 or above |
| **Target set** | Declustered M5.0+ global |
| **Lag windows** | 0–24h, 24–48h, 48–72h, 3–7d (4 windows) |
| **Test statistic** | Ratio of observed to Poisson-expected event count in each lag window |
| **Tests in family** | 4 |
| **Mechanism plausibility** | Low — no established coupling mechanism |
| **Result** | — |

### H2 — Hemispheric asymmetry at CME arrival

| Field | Value |
|---|---|
| **Registered** | 2026-07-24 |
| **Status** | Not yet run |
| **Statement** | Any H1 effect is stronger on the hemisphere facing the Sun at CME **arrival** time than on the far hemisphere. |
| **Solar source** | NASA DONKI, CMEs with modeled Earth-impact estimates |
| **Spatial split** | Subsolar longitude at arrival ±90° vs. complement |
| **Lag windows** | 0–24h, 24–48h from arrival (2 windows) |
| **Test statistic** | Rate ratio between hemispheres, against permuted arrival times |
| **Tests in family** | 2 |
| **Note** | Arrival, not emission. Earth rotates substantially during CME transit. |
| **Mechanism plausibility** | Low |
| **Result** | — |

### H3 — Coronal hole high-speed streams

| Field | Value |
|---|---|
| **Registered** | 2026-07-24 |
| **Status** | **Superseded by H3b on 2026-08-15 — never run** |
| **Statement** | Coronal hole high-speed stream arrivals are followed by an elevated global M5.0+ rate. |
| **Solar source** | SWPC solar wind speed (DSCOVR/ACE/IMAP); stream onset defined as sustained speed > 500 km/s for ≥ 6h |
| **Lag windows** | 0–24h, 24–48h, 48–72h, 3–5d (4 windows) |
| **Tests in family** | 4 — **withdrawn unrun**, see the matrix note |
| **Mechanism plausibility** | Low |
| **Result** | — (never run) |

**Withdrawn: it named a source that cannot supply the history, and left the time
range implied when the data does not permit one.** Every registered parameter
above is left exactly as written, per rule 3 — only `Status`, which tracks
lifecycle rather than being a registered parameter, has moved. The replacement is
H3b immediately below, and its 4 tests replace these rather than adding to the
matrix. No result exists to hide: H3 was never run.

### H3b — Coronal hole high-speed streams (OMNI, 1995 onward)

| Field | Value |
|---|---|
| **Registered** | 2026-08-15 |
| **Status** | Not yet run |
| **Supersedes** | H3, withdrawn unrun on the same date |
| **Statement** | Coronal hole high-speed stream arrivals are followed by an elevated global M5.0+ rate. |
| **Solar source** | **NASA OMNI2** hourly solar wind speed for the history; **SWPC's propagated real-time product** for the recent tail. Both are referenced to the bow shock nose. |
| **Trigger definition** | Stream onset = sustained speed > 500 km/s for ≥ 6h — **unchanged from H3** |
| **Time range** | **1995-01-01 onward** |
| **Gap handling** | An onset requires 6 consecutive hours *each carrying a measured speed*; an unmeasured hour breaks the run. Exposure counts only hours where a full 6-hour window was measured. |
| **Lag windows** | 0–24h, 24–48h, 48–72h, 3–5d (4 windows) |
| **Tests in family** | 4 (replacing H3's 4) |
| **Mechanism plausibility** | Low |
| **Result** | — |

**Nothing here was chosen after seeing a result.** H3 was never run. Both changes
were forced by measuring the ingested data, and both were settled before any test
was written.

**Why the source changed.** H3 named "SWPC solar wind speed (DSCOVR/ACE/IMAP)".
SWPC serves only the last seven days, so the history has to come from NASA's
OMNI2 — the same spacecraft, cross-normalised and time-shifted to the bow shock
nose. This is a weaker change than H4 → H4c, where the *quantity* differed;
here it is the same measurements aggregated by a different body. It is
re-registered rather than clarified in place because H3 named a publisher, and
rule 3 does not distinguish between kinds of parameter.

The live tail deliberately uses SWPC's **propagated** product rather than its raw
L1 stream, so both halves of the series mean the same thing. The propagation
shift is not negligible — measured at 59.4 minutes on a 362 km/s wind, and it
scales inversely with speed.

**Why 1995.** The trigger needs *six unbroken hours*, so what governs is not
average coverage but the fraction of six-hour windows with no gap:

| year | speed coverage | 6h windows intact |
|---|---|---|
| 1993 | 33% | **16.9%** |
| 1994 | 42% | 24.8% |
| **1995** | 98.5% | **97.6%** |

A 5.8x swing in whether the test can run at all, driven by whether a spacecraft
sat at L1. Coverage is also **not monotonic** — 92% in 1980, collapsing to 32-42%
across 1985-1994 after ISEE-3 left for comet Giacobini-Zinner, recovering from
1995 with WIND and then ACE. Over the full record H3 would have found far more
onsets after 1995 for purely instrumental reasons, which against any driver that
trends across the period is a manufactured correlation — the same trap as running
a decade-scale test on M4.5+ earthquakes.

**Why gap handling is registered rather than left to the implementation.** It
changes what the test counts, so rule 2 requires it stated. Two decisions, and
they must be paired:

- A missing hour **breaks** a candidate run. "Sustained above threshold" cannot
  be claimed across an hour nobody measured.
- Exposure is therefore restricted to hours where a full detection window *was*
  measured. Breaking runs without also shrinking the denominator would count
  unobservable time as observed and depress the rate.

**The remaining bias, which no parameter fixes.** Missing wind is not
missing-at-random: it is biased toward the largest events. Around the 2003
Halloween storm, 2003-10-29 and 10-30 carry **no speed at all** for 48 straight
hours while Dst reads -350 and -383 — and **82% of that year's missing hours are
those four days**. ACE's plasma instrument saturates on solar energetic particles
exactly when the wind is most extreme; ground magnetometers do not.

The gap-handling rule above stops this producing a *false positive*: those hours
leave the sample entirely rather than counting as "no stream". What it cannot do
is recover the events themselves, so **H3b systematically under-samples the
strongest streams and its power is lower than the raw hour count suggests.** The
error runs against finding an effect, which is the safe direction, but a null
result must be reported with this stated rather than as a clean null. Dst and Kp
remain present through these hours and can distinguish a quiet spell from a
blinded sensor; using them to *impute* a stream would be a new hypothesis, not
this one.

### H4 — Global geomagnetic disturbance

| Field | Value |
|---|---|
| **Registered** | 2026-07-24 |
| **Status** | **Superseded by H4c on 2026-08-14 — never run** |
| **Statement** | Elevated planetary geomagnetic activity is followed by an elevated global M5.0+ rate. |
| **Index source** | SWPC planetary Kp; Kyoto Dst |
| **Trigger threshold** | Kp ≥ 6 **or** Dst ≤ −100 nT (registered as two separate trigger definitions) |
| **Lag windows** | 0–24h, 24–48h, 48–72h (3 windows) |
| **Tests in family** | 6 — **withdrawn unrun**, see the matrix note |
| **Mechanism plausibility** | Low |
| **Result** | — (never run) |

**Withdrawn because its named data source is no longer what the app stores.**
Every registered parameter above is left exactly as written, per rule 3 — only
`Status`, which is the field that tracks lifecycle rather than a registered
parameter, has moved. The replacement is H4c immediately below.

There is **no result here to hide**: H4 was never run, so rule 5 is not in play.
Its 6 tests transfer to H4c rather than adding to the matrix; see the note under
the Total Test Matrix for why that is not a way of quietly shrinking the
denominator.

### H4c — Global geomagnetic disturbance (GFZ Kp)

| Field | Value |
|---|---|
| **Registered** | 2026-08-14 |
| **Status** | Not yet run |
| **Supersedes** | H4, withdrawn unrun on the same date |
| **Statement** | Elevated planetary geomagnetic activity is followed by an elevated global M5.0+ rate. |
| **Index source** | **GFZ Potsdam planetary Kp** (the definitive IAGA index); Kyoto Dst via NASA OMNI2 |
| **Trigger threshold** | Kp ≥ 6 **or** Dst ≤ −100 nT (registered as two separate trigger definitions) |
| **Lag windows** | 0–24h, 24–48h, 48–72h (3 windows) |
| **Time range** | 1963-01-01 onward — the span where *both* indices exist |
| **Tests in family** | 6 (2 trigger definitions × 3 lags) |
| **Mechanism plausibility** | Low |
| **Result** | — |

**Why this exists.** H4 named "SWPC planetary Kp", which is NOAA's *estimated*
index from eight stations. The app now stores the definitive IAGA index from GFZ
Potsdam, published from thirteen observatories and the source SWPC and OMNI both
ultimately derive from. Same registered quantity, better provenance — but the
original wording named a publisher, so it is replaced rather than edited.

**Nothing here was chosen after seeing a result.** H4 was never run. The change
was forced by an ingest decision (GFZ became reachable, and mixing an estimate
into a definitive series is the same trap that keeps SWPC's modelled Dst out of
this app), not by anything the data showed.

Three parameters worth stating explicitly, since rule 2 requires it:

- **The trigger cannot have moved.** GFZ writes Kp in thirds (`5.667`) where
  OMNI wrote rounded tenths (`5.7`). The two differ by at most 0.033 and agree
  *exactly* on the integers — and the trigger is Kp ≥ 6, an integer. No hour in
  the record can change classification between the two encodings. Verified
  against the stored series: 28 distinct Kp values, all on the GFZ scale.
- **The time range is 1963 onward, and is registered here rather than left
  implied.** GFZ carries Kp back to 1932, but Dst begins in 1963, and one of the
  two trigger definitions needs Dst. Running the Kp arm over a longer span than
  the Dst arm would make the two arms answer over different epochs while sharing
  a denominator.
- **The pre-1963 Kp span is deliberately not claimed.** Using it would need its
  own entry with its own completeness handling: the earthquake catalogue's M4.5
  completeness begins in 1970 and M5.5 is the only floor flat since then, so a
  longer Kp axis does not by itself buy testable overlap.

### H4b — Local magnetometer disturbance and local seismicity

| Field | Value |
|---|---|
| **Registered** | 2026-07-24 |
| **Status** | Not yet run |
| **Statement** | Disturbance measured at an individual ground magnetometer station is followed by an elevated M5.0+ rate **within 500 km of that station**. |
| **Data source** | INTERMAGNET / SuperMAG 1-minute vector data |
| **Trigger definition** | Station-level dB/dt exceeding the 99th percentile of that station's own distribution |
| **Spatial window** | 500 km radius of station |
| **Lag windows** | 0–24h, 24–72h (2 windows) |
| **Completeness correction** | Required — station distribution is geographically biased toward instrumented regions |
| **Tests in family** | 2 |
| **Mechanism plausibility** | Low, but spatially specific — a materially stronger test than H4, since it does not average over the whole planet |
| **Result** | — |

### H5 — Antipodal triggering

| Field | Value |
|---|---|
| **Registered** | 2026-07-24 |
| **Status** | Not yet run |
| **Statement** | M6.0+ earthquakes are followed by an excess of M5.0+ events at short distances from the mainshock's antipode. |
| **Trigger set** | Declustered M6.0+ global |
| **Target set** | Declustered M5.0+ global |
| **Time window** | 0–72h following the trigger |
| **Distance treatment** | **No fixed radius.** Record distance-to-antipode for every target event and test the full distribution against the background-rate prediction. Rings at 250/500/1000 km are visualization only and carry no statistical meaning. |
| **Test statistic** | Kolmogorov–Smirnov against the completeness-weighted null distance distribution |
| **Completeness correction** | **Mandatory.** Only ~4% of Earth's land is antipodal to other land; most land antipodes fall in ocean where seismometer coverage is sparse. Uncorrected, this measures the instrument network rather than the Earth. |
| **Tests in family** | 1 |
| **Mechanism plausibility** | Moderate — antipodal focusing of seismic waves is a real, documented wave phenomenon |
| **Result** | — |

### H6 — Lunisolar tidal stress

| Field | Value |
|---|---|
| **Registered** | 2026-07-24 |
| **Status** | Not yet run (Phase 5) |
| **Statement** | M5.0+ earthquake occurrence is elevated at times of peak lunisolar tidal stress resolved onto the local fault geometry. |
| **Ephemeris** | JPL DE440 via Skyfield |
| **Stress computation** | Full lunisolar tidal stress tensor at hypocenter location and origin time, resolved onto mapped fault plane orientation where available; otherwise onto the focal mechanism nodal planes |
| **Binning** | Tidal phase in 12 bins across the tidal cycle |
| **Subsets** | All events; subduction-zone events only (registered as 2 subsets) |
| **Tests in family** | 2 |
| **Mechanism plausibility** | **Highest of any hypothesis here.** Established physical mechanism, existing peer-reviewed literature finding weak but detectable tidal triggering. Starting references: Tanaka; Cochran, Vidale & Tanaka. |
| **Result** | — |

---

## Explicitly Not Tested

**Planetary alignment as a causal factor.** Planetary tidal forces on Earth are
physically negligible — Jupiter at closest approach exerts on the order of one
ten-millionth of the Moon's tidal influence, and alignments do not meaningfully
accumulate. No mechanism exists at the required scale. Planets and moons appear
in the visualization for their own sake and are labeled decorative in the UI.

Any apparent correlation found between planetary configuration and seismicity
should be treated as a diagnostic that something is wrong with the pipeline,
not as a discovery.

---

## Total Test Matrix

| Family | Tests |
|---|---|
| H1 | 4 |
| H2 | 2 |
| ~~H3~~ | 0 — withdrawn unrun 2026-08-15, replaced by H3b |
| H3b | 4 |
| ~~H4~~ | 0 — withdrawn unrun 2026-08-14, replaced by H4c |
| H4c | 6 |
| H4b | 2 |
| H5 | 1 |
| H6 | 2 |
| **Total** | **21** |

**Why the total did not move when H3b and H4c were added.** Neither is a new
question — each is its predecessor with a corrected data source, registered
because rule 3 forbids editing a registered parameter. Counting both pairs would
put 31 in the denominator and make **every other hypothesis in this file harder
to pass** in exchange for two provenance fixes, which is a real cost paid for
nothing.

The condition that makes this legitimate, and the one to check before ever doing
it again: **neither H3 nor H4 was ever run.** No p-value was computed under
either, so nothing is being dropped from the correction — there is no result, not
a discarded one. A family that *has* been run keeps its tests in the denominator
forever, whatever happens to it afterwards; that is rule 5, and it is not what
happened here.

**This is now a pattern, so it needs a limit.** Two supersessions in two days is
what a new data source does to hypotheses registered before that source existed —
it is not licence to keep re-registering. Any *third* one should prompt the
question of whether the entries are being written too early, before the data they
name has been looked at.

At an uncorrected threshold of p < 0.05, roughly **1 false positive is expected
from noise alone** across this matrix. FDR correction is applied across all 21.

Any hypothesis registered later increases this denominator and requires
recomputing the correction. Do not compare a newly-added test against the old
matrix size.

---

## Exploratory Observations

Things noticed in Explore mode that are **not yet hypotheses**. Moving an entry
up into Registered Hypotheses requires fixing every parameter and, where
possible, testing against data not used to generate the observation.

| Date | Observation | Registered as |
|---|---|---|
| 2026-07-27 | Interest in whether **slow slip events and earthquake swarms act as precursors** to larger events. Raised before any swarm data had been looked at in this app — nothing here was prompted by an observed pattern. | Not registered |

### Notes on the slow-slip / swarm idea (2026-07-27)

Recorded now, ahead of looking at anything, so the reasoning is dated.

**Slow slip is not observable with the current data source.** SSEs release
M6–7 equivalent energy over days to months without seismic shaking, so they
produce no located events in a seismometer catalogue. Detecting them needs
GNSS displacement time series, tectonic tremor catalogues, borehole
strainmeters, or InSAR — none of which this app ingests. No filtering of USGS
FDSN data can surface one.

**Swarms are observable**, and in subduction zones sometimes accompany slow
slip. They are a related but distinct signal. Most swarm events fall below the
display floor, so lowering that floor is a prerequisite for even seeing them.
The globe now offers M1+ and ingests to M1.0 from USGS and EMSC combined.

**The base-rate problem is the hard part.** Cascadia produces episodic tremor
and slip roughly every 14 months and almost none precede a great earthquake.
Slow slip and migrating foreshocks were documented before Tohoku (2011) and
Iquique (2014), but retrospective identification is not prediction. Any
registered test has to survive that denominator.

**Conflict with non-negotiable #2.** Declustering (Gardner-Knopoff) exists to
strip clustered sequences as aftershock contamination — which is precisely
what a swarm is. If swarms are the signal, the project's mandatory
declustering step would delete it. Any hypothesis registered from this must
state explicitly how it handles that, rather than silently inheriting the
shared declustering parameter.

---

## Template

```markdown
### H— — [short name]

| Field | Value |
|---|---|
| **Registered** | YYYY-MM-DD |
| **Status** | Not yet run / Running / Complete |
| **Statement** | |
| **Trigger set** | |
| **Target set** | |
| **Lag windows** | |
| **Spatial window** | |
| **Test statistic** | |
| **Completeness correction** | |
| **Tests in family** | |
| **Mechanism plausibility** | |
| **Result** | |
```
