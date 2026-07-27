# HYPOTHESES.md — Pre-Registration Log

**Last updated:** 2026-07-24

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
| **Status** | Not yet run |
| **Statement** | Coronal hole high-speed stream arrivals are followed by an elevated global M5.0+ rate. |
| **Solar source** | SWPC solar wind speed (DSCOVR/ACE/IMAP); stream onset defined as sustained speed > 500 km/s for ≥ 6h |
| **Lag windows** | 0–24h, 24–48h, 48–72h, 3–5d (4 windows) |
| **Tests in family** | 4 |
| **Mechanism plausibility** | Low |
| **Result** | — |

### H4 — Global geomagnetic disturbance

| Field | Value |
|---|---|
| **Registered** | 2026-07-24 |
| **Status** | Not yet run |
| **Statement** | Elevated planetary geomagnetic activity is followed by an elevated global M5.0+ rate. |
| **Index source** | SWPC planetary Kp; Kyoto Dst |
| **Trigger threshold** | Kp ≥ 6 **or** Dst ≤ −100 nT (registered as two separate trigger definitions) |
| **Lag windows** | 0–24h, 24–48h, 48–72h (3 windows) |
| **Tests in family** | 6 (2 trigger definitions × 3 lags) |
| **Mechanism plausibility** | Low |
| **Result** | — |

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
| H3 | 4 |
| H4 | 6 |
| H4b | 2 |
| H5 | 1 |
| H6 | 2 |
| **Total** | **21** |

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
current M2.5 display floor, so lowering that floor is a prerequisite for even
seeing them.

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
