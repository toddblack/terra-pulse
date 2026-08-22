# HYPOTHESES.md — Pre-Registration Log

**Last updated:** 2026-08-20

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
| Completeness correction | Required for spatial tests. A magnitude-of-completeness map is one way; **conditioning** — a null that reuses the same detected events, so detection bias cancels rather than being estimated — is another, and is what H5 uses. Either is acceptable; neither being present is not. |
| Time base | UTC throughout |

---

## Registered Hypotheses

### H1 — Solar flares and global seismicity rate

| Field | Value |
|---|---|
| **Registered** | 2026-07-24 |
| **Status** | **Superseded by H1b on 2026-08-17 - never run** |
| **Statement** | X- and M-class solar flare occurrence is followed by an elevated global M5.0+ earthquake rate. |
| **Solar source** | NOAA SWPC edited event reports + GOES X-ray flux |
| **Trigger set** | Flares classified M1.0 or above |
| **Target set** | Declustered M5.0+ global |
| **Lag windows** | 0–24h, 24–48h, 48–72h, 3–7d (4 windows) |
| **Test statistic** | Ratio of observed to Poisson-expected event count in each lag window |
| **Tests in family** | 4 |
| **Mechanism plausibility** | Low — no established coupling mechanism |
| **Result** | — |

**Withdrawn: two parameters it never registered turned out to decide the
result.** Every registered parameter above is left exactly as written, per rule 3
— only `Status` has moved. The replacement is H1b below, and its 4 tests replace
these rather than adding to the matrix. H1 was never run.

Its **source was right**, which is worth recording: "GOES X-ray flux" is both
correct and the more complete catalogue. A DONKI adapter was built for H2, and
substituting it here would have been a completeness downgrade disguised as an
ingest decision — DONKI captured 25% of M/X flares in 2011-13 against GOES's
full record.

### H1b — Solar flares and global seismicity rate (GOES, 1996 onward)

| Field | Value |
|---|---|
| **Registered** | 2026-08-17 |
| **Status** | **Run 2026-08-19 — not rejected** |
| **Supersedes** | H1, withdrawn unrun on the same date |
| **Statement** | X- and M-class solar flare occurrence is followed by an elevated global M5.0+ earthquake rate. |
| **Solar source** | **NOAA GOES XRS flare reports** for 1996-2016; **NASA DONKI** `/FLR` for 2017 onward. The join is validated on their 2014-2016 overlap, which agrees to 97-100%. |
| **Trigger set** | Flares classified M1.0 or above — **unchanged from H1** |
| **Target set** | Declustered M5.0+ global — **unchanged from H1** |
| **Time range** | **1996-01-01 onward** |
| **Baseline estimation** | Poisson expectation estimated **within a moving local window**, not pooled across the full record |
| **Baseline window** | Poisson expectation estimated within a moving window of ±182.625 days (one year total) centred on each trigger. |
| **Lag windows** | 0-24h, 24-48h, 48-72h, 3-7d (4 windows) |
| **Test statistic** | Ratio of observed to Poisson-expected event count in each lag window |
| **Null model** | Flare peak instants redrawn uniformly without replacement from every hour in the analysis span, keeping the same count as the real M1.0+ trigger set. |
| **Tail** | One-sided upper. |
| **Tests in family** | 4 (replacing H1's 4) |
| **Mechanism plausibility** | Low - no established coupling mechanism |
| **Result** | **Not rejected.** Ratios 0.974–1.011 across the four lag windows; smallest raw p = 0.0872 (3–7d), all four adjusted p = 1.0000 against the 19-test matrix. Nothing rejected at q = 0.05, before or after correction. |

**Result, in full (run 2026-08-19).** 52,726 raw M5.0+ events since 1996 →
**26,577 independent** after Gardner-Knopoff, against **4,598 M1.0+ flares**
(2,302 from GOES ≤2016, 2,296 from DONKI ≥2017). Engine time 12.0 s,
seed 2026081902, 10,000 iterations per window.

| lag window | observed | expected | ratio | p (raw) | p (adj., 19-test matrix) |
|---|---|---|---|---|---|
| 0–24h | 10,372 | 10,650.5 | 0.974 | 0.9937 | 1.0000 |
| 24–48h | 10,670 | 10,650.5 | 1.002 | 0.4354 | 1.0000 |
| 48–72h | 10,771 | 10,650.5 | 1.011 | 0.1496 | 1.0000 |
| 3–7d | 42,933 | 42,602.0 | 1.008 | 0.0872 | 1.0000 |

**A null result, reported with the same weight a rejection would get (rule 5).**
The largest deviation in either direction is 2.6%, and it is a *deficit* in the
window where a triggering mechanism would predict the strongest excess. Nothing
here is evidence of an effect, and nothing here is evidence of its absence
either — this is one test family against a catalogue whose own secular drift is
an order of magnitude larger than any signal it could resolve.

**The 3–7d window's p = 0.0872 is not a near-miss and must not be read as one.**
It is the smallest of four raw p-values from correlated tests; against the
registered 19-test matrix it adjusts to 1.0000. Reporting it as "trending" would
be exactly the free-parameter-after-the-fact that non-negotiable #3 and rule 3
exist to prevent. The four windows are also positively correlated (flares
cluster, so their windows overlap), which is recorded in the result's own
caveats.

**Sanity checks that passed before the result was believed.** The declustered
rate implies ~2.375 events/day over the span, and the 0–24h expectation of
10,650.5 over 4,598 triggers is 2.32/trigger-day — consistent to within the
local baseline's own variation. The 3–7d window's expected count is exactly
4.0000× the 24-hour windows', as it must be when expectation is rate × duration.
Trigger counts were reconciled against an independent SQL recomputation of the
same M1.0+ filter and the same GOES/DONKI join.

**Nothing here was chosen after seeing a result.** H1 was never run. Both new
parameters were forced by measuring the two catalogues before any test existed.

**Three more parameters, completed 2026-08-19 before the first run, by the same
rule as H4c's, H3b's and H2b's own completions.** The trigger set, target set,
lag windows, time range and the *fact* of a moving local baseline were all
registered; the baseline window's **width**, the null-draw scheme and the tail
were left implied, which rule 2 forbids. H1b has never been run — status is still
"Not yet run" — so this finishes the registration rather than amending a result.
The engine physically cannot run it until these exist, since its request contract
requires all three.

- **Baseline window and tail are identical to H4c's and H3b's**, and for the
  identical reason: the M5.0+ catalogue is not stationary (+36% per five decades,
  the table below), so a pooled baseline manufactures a trend-driven ratio. That
  argument is *this* hypothesis's own — the table below is H1b's, and H3b's
  completion cites it — so reusing the mitigation here is applying one registered
  fix to the case that motivated it, not importing another hypothesis's
  parameters. One-sided upper matches the statement's own direction ("elevated").
- **The null model is a plain uniform redraw over every hour in the span**, and
  this is where H1b differs from H4c and H3b rather than copying them. Those two
  derive triggers by thresholding a continuous series, so their eligible pool
  excludes hours where a qualifying window could not have started — an
  unmeasured-hours rule. A flare catalogue has no such structure: it is a list of
  discrete events, with no series behind it whose gaps could disqualify an hour.
  So the pool is every hour, exactly as **H2b** does for CME arrivals, which is
  the same shape of trigger. No gap-handling rule is registered here because
  there is nothing for one to act on.
- **No separate "effective span" note is needed.** 1996-01-01 already sits
  inside the M5.0+ catalogue's own 1970-onward completeness window, so unlike
  H4c's 1963 nothing truncates. The 1996 bound was chosen for a stricter,
  solar-side reason (the GOES 1-7 flux scaling correction, below) that clears the
  earthquake-side bound with room to spare — the same situation as H3b's 1995.

**The registered source is now fully ingested, and the trigger count is on the
record.** The GOES half shipped 2026-08-19: **36,288 classified flares for
1996-2016, 2,304 of them M1.0+**, with per-year M/X counts reproducing the
independently-measured comparison table below exactly across all six DONKI-overlap
years. Combined with DONKI from 2017, the registered trigger set is
**approximately 4,600 flares**. Recorded here before the run so the number cannot
later look like it was selected.

**Why 1996.** GOES XRS yearly reports reach back to 1975, but fluxes from
GOES 1-7 are documented as requiring a scaling correction — so "M1.0" before
1996 is not the same threshold as after. Applying that correction would mean
introducing a factor this project has not verified against a citable source,
which is exactly the free parameter non-negotiable #3 forbids. GOES-8 onward
avoids the question and still gives thirty years, against twelve from DONKI
alone. **Extending back to 1976 remains possible** and would roughly double the
record, but only once that correction is sourced and registered.

**Why the baseline estimation is registered, and why it is the important half.**
H1 specified the statistic as observed versus Poisson-expected without saying how
the expectation is estimated. That omission is decisive, because the target
catalogue is not stationary — measured on this app's own database, M5.0+ events
per year rise **36%** from the 1970s to the 2010s, which is network growth rather
than seismicity:

| decade | M5.0+ /yr | M5.5+ /yr |
|---|---|---|
| 1970s | 1,358 | 438 |
| 1980s | 1,603 | 438 |
| 1990s | 1,466 | 487 |
| 2000s | 1,723 | 516 |
| 2010s | 1,847 | 490 |
| 2020s | 1,803 | 465 |

With a pooled baseline, late-period windows show an excess and early ones a
deficit *for no seismic reason at all* — and because flares follow the solar
cycle rather than being spread evenly, a cycle-correlated sample of a rising
baseline manufactures a correlation. A locally estimated expectation removes this
without touching the magnitude floor.

**The floor stays at M5.0+ deliberately.** M5.5+ is the only floor flat since
1970 (12% drift against 36%), so raising it is the alternative fix — but with a
local baseline it would cost 3.7x the target events for no gain. **One of the two
fixes is mandatory; doing neither is the spurious-correlation path.**

**Still unverified, and it constrains any extension.** Whether "M1.0" means the
same thing across the whole 1996-present span has not been checked — GOES
instruments changed within that period too. Two good catalogues can differ at the
margin, and that uncertainty travels with any flare count reported here.

**The 2015 disagreement is resolved, and the fix is recorded here because it
changes the registered trigger set.** The 2014-2016 cross-check showed a 20%
disagreement in 2015 — GOES 106 M/X against DONKI's 126, with no duplicates on
either side — and the guess at the time was that GOES's report was partial across
a satellite transition. It was. NOAA publishes a corrected file for that year
alone, `goes-xrs-report_2015_modifiedreplacedmissingrows.txt`, carrying **119
M/X**. The ingest takes the corrected file for 2015 and the standard file for the
other twenty years.

This is a source-fidelity correction, not a parameter choice: the registration
already names "NOAA GOES XRS flare reports" and both files are that, one of them
incomplete. Recorded explicitly anyway, per rule 2, because it is a filename
exception a reader would otherwise have to find in the ingest code — and because
it moves 13 real M/X flares into a solar-max year's trigger set. Decided
2026-08-19, before H1b was run.

**Measured trigger counts, for the record.** The GOES half of the record yields
**36,288 classified flares for 1996-2016, 2,304 of them M1.0+**, with per-year
M/X counts reproducing the independently-measured table in
`packages/schema/src/solar-events.ts` exactly across all six DONKI-overlap years.
The largest is X28 on 2003-11-04, the largest ever recorded.

### H2 — Hemispheric asymmetry at CME arrival

| Field | Value |
|---|---|
| **Registered** | 2026-07-24 |
| **Status** | **Superseded by H2b on 2026-08-17 - never run** |
| **Statement** | Any H1 effect is stronger on the hemisphere facing the Sun at CME **arrival** time than on the far hemisphere. |
| **Solar source** | NASA DONKI, CMEs with modeled Earth-impact estimates |
| **Spatial split** | Subsolar longitude at arrival ±90° vs. complement |
| **Lag windows** | 0–24h, 24–48h from arrival (2 windows) |
| **Test statistic** | Rate ratio between hemispheres, against permuted arrival times |
| **Tests in family** | 2 - **withdrawn unrun**, see the matrix note |
| **Note** | Arrival, not emission. Earth rotates substantially during CME transit. |
| **Mechanism plausibility** | Low |
| **Result** | — |

**Withdrawn: its trigger set was underspecified in a way that decides the
answer.** Registered parameters are unchanged, per rule 3; only `Status` has
moved. H2b below replaces it, and its 2 tests transfer rather than adding to the
matrix. H2 was never run.

### H2b — Hemispheric asymmetry at CME arrival (direct impacts only)

| Field | Value |
|---|---|
| **Registered** | 2026-08-17 |
| **Status** | **Run 2026-08-19; reproduced 2026-08-20 — not rejected** |
| **Supersedes** | H2, withdrawn unrun on the same date |
| **Statement** | Any H1b effect is stronger on the hemisphere facing the Sun at CME **arrival** time than on the far hemisphere. |
| **Solar source** | NASA DONKI `/WSAEnlilSimulations`, using `estimatedShockArrivalTime` — the Earth-specific field |
| **Trigger set** | **Direct impacts only**: runs where `isEarthGB` and `isEarthMinorImpact` are both false |
| **Time range** | **2014-01-01 onward** |
| **Spatial split** | Subsolar longitude at arrival ±90° vs. complement — **unchanged from H2** |
| **Lag windows** | 0-24h, 24-48h from arrival (2 windows) |
| **Test statistic** | Rate ratio between hemispheres, against permuted arrival times |
| **Null model** | Arrival instants redrawn uniformly without replacement from all hours within the analysis span, keeping the same count as the real direct-impact trigger set. |
| **Tail** | One-sided upper. |
| **Target set** | Declustered M5.0+ global — inherited from H1b by direct reference in this hypothesis's own statement ("any H1b effect"), not independently registered. |
| **Tests in family** | 2 (replacing H2's 2) |
| **Mechanism plausibility** | Low |
| **Result** | **Not rejected.** Near/far ratios 1.063 (0-24h) and 0.925 (24-48h); smallest raw p = 0.1606, both adjusted p = 1.0000 against the 19-test matrix. |

**Four more parameters, completed 2026-08-19 before the first run, for the
same reason and by the same rule as H4c's and H3b's own completions:** the
trigger set, spatial split, lag windows and time range were registered, but
the null-draw scheme, the tail, and the target set's magnitude floor were
left implied. H2b has never been run — status is still "Not yet run" — so
this finishes the registration rather than amending a result.

- **"Subsolar longitude ±90°" is a longitude band, not a 3D angular
  distance from the subsolar point.** The classification compares only the
  target event's longitude to the subsolar longitude at arrival — latitude
  never enters it. This is the literal reading of "subsolar **longitude**",
  it always splits the globe exactly in half regardless of season (a
  longitude band spans a fixed 180° by construction, where a true angular
  cap from the subsolar *point* would shrink and grow with solar
  declination), and it matches how the day/night terminator is
  conventionally approximated for exactly this kind of test.
- **Null model, spelled out:** redraw N arrival instants (N = the real
  direct-impact count) uniformly without replacement from every hour in the
  analysis span, recompute the subsolar longitude and the near/far split for
  each redrawn instant, and recompute the ratio. This is what "permuted
  arrival times" means operationally — matching H2's own already-registered
  wording ("against permuted arrival times") and the same uniform-redraw
  scheme H4c and H3b use, extended to a discrete trigger set rather than a
  thresholded continuous series (there is no threshold or gap-handling rule
  here, so unlike H4c/H3b's eligible-hours pool, every hour in the span is
  an equally valid hypothetical arrival instant).
- **Tail: one-sided upper**, matching the statement's own direction
  ("stronger... than"), consistent with H4c's and H3b's identical framing.
- **No Poisson baseline.** Unlike H4c/H3b, this test has no baseline-rate
  model at all — the null comes entirely from permuting arrival times, per
  the registered test statistic. Nothing was dropped in completing this
  entry; there was never one to specify.
- **The target floor is M5.0+, inherited rather than restated.** H2b's
  statement is conditioned on "any H1b effect", and H1b's own registration
  specifies "Declustered M5.0+ global" as its target set. Recording the
  inheritance explicitly here, rather than leaving a reader to infer it, is
  what rule 2 ("all parameters explicit") asks for even when a parameter's
  *source* is another entry.

**Why arrivals come from the model runs at all.** The CME records carry no
arrival estimate — measured, `/CMEAnalysis` returns no `enlilList` and no arrival
times whatsoever. Only the WSA-ENLIL runs do. And only a minority reach Earth: 79
of 325 runs over ten weeks, because most modelled CMEs miss. Several carry
arrivals at *other spacecraft* in their `impactList`, so filtering on "has an
arrival time" is not the same as filtering on "arrives at Earth".

**Why glancing blows are excluded.** DONKI distinguishes a direct impact from a
glancing blow and a minor impact. Measured across seven years:

| year | Earth arrivals | direct | glancing/minor |
|---|---|---|---|
| 2015 | 61 | 30 | 31 |
| 2017 | 21 | 7 | 14 |
| 2019 | 9 | 6 | 3 |
| 2021 | 70 | 27 | 43 |
| 2023 | 163 | 85 | 78 |
| 2024 | 296 | 161 | 135 |
| 2025 | 225 | 94 | 131 |
| **total** | **845** | **410 (49%)** | 435 |

A graze can carry a predicted Kp of 2 — barely geoeffective — and cannot produce
the physical condition this hypothesis posits. Pooling them dilutes the trigger
set with events that were never going to do anything, biasing toward the null.
410 events across seven years is a comfortable sample: roughly 200 per lag window
before the hemispheric split. The 49% ratio is stable across cycle phase, so it is
not an artefact of activity level.

**Deliberately not registered as two tests.** Running direct and glancing
separately would take this family from 2 to 4, and the FDR denominator is shared
— every other hypothesis in this file would become harder to pass so that H2b
could hedge. Choosing the physically motivated set in advance is what
pre-registration is for.

**The time range is proposed by analogy and is the weakest claim here.** DONKI's
flare record was checked against GOES and found complete from 2014; **its
WSA-ENLIL coverage has not been independently verified**, because these are model
runs with no obvious external catalogue to check against. 2014 is inherited from
the flare finding rather than measured. If a comparable check becomes possible it
should be done, and this entry amended if it disagrees.

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
| **Status** | **Run 2026-08-19; reproduced 2026-08-20 — not rejected** |
| **Supersedes** | H3, withdrawn unrun on the same date |
| **Statement** | Coronal hole high-speed stream arrivals are followed by an elevated global M5.0+ rate. |
| **Solar source** | **NASA OMNI2** hourly solar wind speed for the history; **SWPC's propagated real-time product** for the recent tail. Both are referenced to the bow shock nose. |
| **Trigger definition** | Stream onset = sustained speed > 500 km/s for ≥ 6h — **unchanged from H3** |
| **Time range** | **1995-01-01 onward** |
| **Gap handling** | An onset requires 6 consecutive hours *each carrying a measured speed*; an unmeasured hour breaks the run. Exposure counts only hours where a full 6-hour window was measured. |
| **Lag windows** | 0–24h, 24–48h, 48–72h, 3–5d (4 windows) |
| **Baseline window** | Poisson expectation estimated within a moving window of ±182.625 days (one year total) centred on each trigger, not pooled across the record. |
| **Null model** | Trigger onsets redrawn uniformly without replacement from eligible hours (hours where a full 6-hour window could have started, per the gap-handling rule above) within the analysis span. |
| **Tail** | One-sided upper. |
| **Tests in family** | 4 (replacing H3's 4) |
| **Mechanism plausibility** | Low |
| **Result** | **Not rejected.** Ratios 0.986-1.021 across the four lag windows; smallest raw p = 0.1423 (0-24h), all four adjusted p = 1.0000 against the 19-test matrix. |

**Nothing here was chosen after seeing a result.** H3 was never run. Both changes
were forced by measuring the ingested data, and both were settled before any test
was written.

**Three more parameters, completed 2026-08-19 before the first run, for the
same reason and by the same rule as H4c's own completion the day before:**
the trigger, the lag windows and the time range were registered, but the
baseline window's width, the null-draw scheme and the tail were left implied,
which rule 2 forbids. H3b has never been run — status is still "Not yet
run" — so this finishes the registration rather than amending a result.

- **Baseline window and null model are identical to H4c's**, and for the
  identical reason: this app's own M5.0+ catalogue is not stationary
  (+36% per five decades since 1970, see H1b above), so a pooled baseline
  would manufacture a trend-driven ratio here exactly as it would there. A
  moving ±182.625-day window and a uniform redraw from eligible hours are
  the same registered mitigation, reused rather than reinvented — unlike
  H4c's trigger *count*, which is a genuinely different quantity (a 500 km/s
  wind-speed threshold, not a Kp/Dst index level), so this is one mitigation
  applied twice, not one hypothesis's parameters leaking into another's.
- **No separate "effective span" note is needed the way H4c required one.**
  H3b's registered start, 1995-01-01, already sits inside the M5.0+
  catalogue's own 1970-onward completeness window — the constraint that
  forced H4c's registered 1963 down to an *effective* 1970 doesn't bind here,
  because 1995 was already chosen for a stricter reason (measured six-hour
  window intactness, see below) that happens to clear the earthquake-side
  bound with room to spare.
- **Tail.** One-sided upper — framed as "elevated" rate, matching H4c's
  identical reasoning.

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
| **Status** | **Run 2026-08-18; reproduced 2026-08-20 — not rejected** |
| **Supersedes** | H4, withdrawn unrun on the same date |
| **Statement** | Elevated planetary geomagnetic activity is followed by an elevated global M5.0+ rate. |
| **Index source** | **GFZ Potsdam planetary Kp** (the definitive IAGA index); Kyoto Dst via NASA OMNI2 |
| **Trigger threshold** | Kp ≥ 6 **or** Dst ≤ −100 nT (registered as two separate trigger definitions) |
| **Lag windows** | 0–24h, 24–48h, 48–72h (3 windows) |
| **Time range** | 1963-01-01 onward — the span where *both* indices exist |
| **Episode definition** | A trigger is the first hour of a maximal run of consecutive hours meeting a threshold (Kp ≥ 6, or Dst ≤ −100 nT — each its own run); a missing or null hour ends the run. |
| **Baseline window** | Poisson expectation estimated within a moving window of ±182.625 days (one year total) centred on each trigger, not pooled across the record. |
| **Null model** | Trigger onsets redrawn uniformly without replacement from eligible hours (hours where a full-duration window could have started) within the analysis span. |
| **Tail** | One-sided upper. |
| **Effective span** | 1970-01-01 onward in practice — see below. |
| **Tests in family** | 6 (2 trigger definitions × 3 lags) |
| **Mechanism plausibility** | Low |
| **Result** | **Not rejected.** Ratios 0.974-1.013 across the six tests; smallest raw p = 0.3329 (Dst<=-100, 48-72h), all six adjusted p = 1.0000 against the 19-test matrix. |

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

**Five more parameters, completed 2026-08-18 before the first run.** The entry
above specified the trigger, the lag windows and the time range, but left how a
run of qualifying hours becomes one *trigger instant*, how wide the moving
baseline window is, how the null is drawn, and which tail is tested — all
implied rather than explicit, which rule 2 forbids. Nothing below was chosen
after seeing a result: H4c has never been run, its status is still "Not yet
run", so this completes the registration rather than amending it (rule 3 exists
to stop edits *after* a result is known; there is no result here to protect).

- **Episode definition.** A maximal run of consecutive hours meeting the
  threshold becomes one trigger, dated to its first hour; Kp and Dst are swept
  independently. A missing or null hour ends the run rather than being treated
  as passing through it — the same rule H3b already registers for its own
  measured-hours requirement, applied here for the same reason.
- **Baseline window.** ±182.625 days (one year total), centred on each trigger,
  not pooled across the record — H1b's own registered mitigation for the same
  measured problem: M5.0+ events per decade rise 36% from the 1970s to the
  2010s (see H1b above), which is network growth, not seismicity. A pooled
  baseline would let late-record windows show a manufactured excess and
  early ones a manufactured deficit. One year is chosen a priori as the
  shortest window that still averages over a full annual cycle.
- **Null model.** Trigger onsets are redrawn uniformly without replacement
  from eligible hours (hours where a full-duration episode could have started)
  within the analysis span — matching H2b's registered wording, "against
  permuted arrival times". A circular time-shift null, which preserves
  trigger clustering, is a defensible alternative but is a *different* null
  and would need its own registered entry.
- **Tail.** One-sided upper — the statement is framed as an elevated rate, not
  a changed one.
- **Effective span.** Registered as 1963-01-01 onward, because that is where
  Kp and Dst both exist. But the *target* set is declustered global M5.0+, and
  this app's M5.0+ catalogue is only global-complete from **1970-01-01** — the
  same boundary the earthquake archive's own Tier 1 backfill uses. The deep
  tier reaches back to 1900, but deliberately only for M7.5+: that floor is
  rare and large enough to survive sparse historical records (USGS lists 0–3
  M7.5+ events per decade through the 1890s, jumping to 40 once instrumental
  seismology arrives in 1900–10 — see the deep-archive-tier entry in
  `CLAUDE.md`). M5.0+ is thousands of events a year with no comparable
  pre-1970 record; extending it back the way the M7.5+ tier was would mean
  counting an era that mostly wasn't detected, not a sparse-but-real one. The
  run therefore covers 1970–present, not 1963–present, and reports the
  truncation explicitly rather than absorbing it silently.

### H4b — Local magnetometer disturbance and local seismicity

| Field | Value |
|---|---|
| **Registered** | 2026-07-24 |
| **Status** | **Withdrawn unrun 2026-08-20 — not replaced** |
| **Statement** | Disturbance measured at an individual ground magnetometer station is followed by an elevated M5.0+ rate **within 500 km of that station**. |
| **Data source** | INTERMAGNET / SuperMAG 1-minute vector data |
| **Trigger definition** | Station-level dB/dt exceeding the 99th percentile of that station's own distribution |
| **Spatial window** | 500 km radius of station |
| **Lag windows** | 0–24h, 24–72h (2 windows) |
| **Completeness correction** | Required — station distribution is geographically biased toward instrumented regions |
| **Tests in family** | 2 — **withdrawn unrun**, see the matrix note |
| **Mechanism plausibility** | Low, but spatially specific — a materially stronger test than H4, since it does not average over the whole planet |
| **Result** | — (never run) |

**Withdrawn on measurement, not on effort.** Unlike H1→H1b, H2→H2b, H3→H3b and
H4→H4c, this one is **not replaced by a corrected entry**. The registered
parameters above are left exactly as written per rule 3; only `Status` moved.

The decision rests on three things measured on 2026-08-20, before any ingest was
built. Each is recorded here because "we didn't get round to it" and "we checked
and it wasn't worth it" are very different claims, and only the second is true.

**1. Its distinguishing premise is about half true.** The entry claims H4b is "a
materially stronger test than H4, since it does not average over the whole
planet." Measured at Kakioka across 2003, 2011 and 2015 — 26,280 station-hours
of INTERMAGNET 1-minute data, joined to the Kp already stored here:

| | H4b trigger hours (dB/dt ≥ p99) | all hours |
|---|---|---|
| Kp ≥ 5 | **72.0%** | 5.4% |
| Kp ≥ 6 | **52.7%** | 1.5% |

Spearman rank correlation between hourly max dB/dt and planetary Kp: **0.736**.

So **over half of H4b's local triggers are literally H4c trigger hours**, and
H4c returned six clean nulls with ratios inside 2.5% of 1.0. It is not a pure
duplicate — only 35.9% of Kp ≥ 6 hours clear Kakioka's own p99, and ~47% of
local triggers occur below Kp 6 — but the independent fraction is modest, and it
is the fraction where local conditions diverge from planetary, which is the
noisiest part of the record rather than the most diagnostic.

**2. Power barely responds to scope, so there is no "do it properly" version
worth the cost.** Of 138 open INTERMAGNET observatories, measured against this
app's own catalogue (M5.0+ within 500 km, 1991 onward), **31 have zero nearby
events ever** and the distribution is brutally concentrated — 23 stations hold
87% of all station-event pairs, 9 hold 71%. Because power goes as √n:

| stations | share of targets | download | min. detectable rate excess |
|---|---|---|---|
| 5 | 57% | ~525 MB | ~12% |
| 9 | 71% | ~945 MB | ~11% |
| 23 | 87% | ~2.4 GB | ~10% |
| 41 | 96% | ~4.3 GB | ~9.5% |
| 138 | 100% | ~14 GB | ~9.4% |

Eight times the download buys 12% → 9.5%. And **nothing anywhere in this matrix
has deviated more than 7% from 1.0**, so a test that cannot see below ~10% is
unlikely to resolve whatever is or is not there.

**3. The cost is paid by every install, and it is not ours to redistribute.**
INTERMAGNET is CC BY-NC 4.0 with bulk distribution to third parties requiring
written permission from each operating institute, so standing rule 1 in
`SOURCES.md` applies: every install fetches its own copy. That makes the smallest
credible version a ~1 GB, ~1-hour download on every machine that wants the test,
against a hypothesis whose own registered mechanism plausibility is "low".

**What this costs the matrix: nothing that was ever computed.** No p-value was
ever produced under H4b, so rule 5 does not apply and its 2 tests leave the
denominator, exactly as H1's, H2's, H3's and H4's did. The unblocked matrix goes
**19 → 17**. No recorded result changes: the smallest raw p-value anywhere is
H1b's 0.0872, and 0.0872 × 17 still exceeds 1, so every adjusted value stays
1.0000 under either denominator. The five completed runs did **not** need
re-running, and were not re-run.

**What it does not settle.** This is a judgement that the test is not worth its
price, not a finding that local magnetometer disturbance is unrelated to local
seismicity. Nothing here measures that. If it is ever revisited, the honest form
is the 9-station version above, and it needs a **new entry** with its own
registration — the parameters in the table above were written against an
unqueried source and are underspecified in six places (no time range at all, no
episode definition, no baseline window, no null model, no tail, and "the 99th
percentile of that station's own distribution" never says of *what* — 1-minute
values or hourly maxima, per year or per record).

**The recon it produced is kept, because it was the expensive part.** See
`SOURCES.md` for INTERMAGNET's real service shape, and the note below on the
null-arithmetic trap.

#### The trap that would have defined the trigger set out of telemetry gaps

Recorded because it is not specific to H4b and will recur in any dB/dt work.
INTERMAGNET's JSON reports data gaps as `null`. In JavaScript `null` fails
`Number.isFinite`, but **`null - 21585.5` evaluates to `-21585.5`, which passes
it** — so validating the *difference* rather than the *operands* turns every gap
edge into a spike the size of the field itself.

Measured at Paratunka in 2011: 1,400 null samples produced 362 false jumps above
100 nT/min and pushed the station's 99th percentile from a real **7.36 nT/min**
to **21,675 nT/min**. At that threshold the trigger set would have been composed
almost entirely of telemetry dropouts, and it would have looked entirely healthy
— a plausible count of triggers, at plausible times, with no error anywhere.

Same family as OMNI's 99999 sentinel already documented in `CLAUDE.md`, but
worse: `null` looks like the safe representation, and the check that catches a
sentinel is the one that misses this.

With the operands validated instead, the corrected figures are physical and the
top days at each station are recognisable storms — Kakioka 2015 peaks on 22 June
and 17 March (St Patrick's Day), Paratunka 2011 on 26 September and 5 August.

### H5 — Antipodal triggering

| Field | Value |
|---|---|
| **Registered** | 2026-07-24 |
| **Status** | **Run 2026-08-20 — not rejected** |
| **Statement** | M6.0+ earthquakes are followed by an excess of M5.0+ events at short distances from the mainshock's antipode. |
| **Trigger set** | Declustered M6.0+ global |
| **Target set** | Declustered M5.0+ global |
| **Time window** | 0–72h following the trigger |
| **Distance treatment** | **No fixed radius.** Record distance-to-antipode for every target event and test the full distribution against the background-rate prediction. Rings at 250/500/1000 km are visualization only and carry no statistical meaning. |
| **Test statistic** | Kolmogorov–Smirnov against the completeness-weighted null distance distribution |
| **Completeness correction** | **Mandatory.** Only ~4% of Earth's land is antipodal to other land; most land antipodes fall in ocean where seismometer coverage is sparse. Uncorrected, this measures the instrument network rather than the Earth. |
| **Time range** | **1970-01-01 onward** |
| **Null model** | Trigger instants redrawn uniformly without replacement from every hour in the analysis span, keeping the same count as the real declustered M6.0+ trigger set. **Trigger locations and the target catalogue are both held fixed** — only the temporal coincidence is broken. |
| **Test statistic, precisely** | One-sided KS **D⁺**: the maximum amount by which the observed distance-to-antipode ECDF **exceeds** the null reference ECDF (i.e. an excess at short distances). |
| **Tail** | Upper — a larger D⁺ is more extreme. |
| **Self-exclusion** | A trigger is excluded from its own 0–72h window. |
| **Seed** | 2026082001 |
| **Tests in family** | 1 |
| **Mechanism plausibility** | Moderate — antipodal focusing of seismic waves is a real, documented wave phenomenon |
| **Result** | **Not rejected.** KS D⁺ = 0.0016 against a null mean of 0.0024 (sd 0.0016); p = 0.6203 raw, 1.0000 adjusted against the 19-test matrix. The observed directional excess is *below* what the null produces by chance. |

**Result, in full (run 2026-08-20).** 92,119 raw M5.0+ events since 1970 →
**48,382 independent** after one Gardner-Knopoff pass, of which **5,777** are
M6.0+ and serve as triggers. 42,557 target events fell inside a trigger's 0–72h
window. Engine time 51 s, seed 2026082001, 10,000 permutations.

| quantity | value |
|---|---|
| KS D⁺ (the registered statistic) | 0.0016 |
| null mean D⁺ | 0.0024 (sd 0.0016; p95 0.0055, p99 0.0070) |
| p (raw) | 0.6203 |
| p (adjusted, 19-test matrix) | 1.0000 |
| two-sided D (descriptive only) | 0.0442 |

**A null result, and one whose direction is worth stating plainly:** the observed
D⁺ sits *below* the null mean. There is less directional excess at short
distances than random redraws of the trigger times produce. This is not evidence
that antipodal triggering does not occur — see the power limitation registered
above — but it is not a near-miss in the other direction either.

### The registered test turned out to be insensitive to its own hypothesis

This is the most useful thing the run produced, and it is a finding about the
**method**, not about the Earth.

The two-sided D is 0.0442 — 27× the D⁺ — so the observed distance distribution
does differ substantially from the null reference. It differs in the **far**
tail. Measured descriptively after the run:

| distance from antipode | observed | reference |
|---|---|---|
| beyond 19,500 km (i.e. within ~500 km of the *trigger*) | 5.56% | 1.57% |
| beyond 19,000 km | 7.87% | 3.48% |

That is residual near-trigger clustering surviving declustering — aftershock-like
structure that Gardner-Knopoff did not remove — and it has nothing to do with
antipodes. It dominates the two-sided statistic entirely.

**Why that matters for the registered design.** "No fixed radius" was chosen in
2026-07-24 to avoid the p-hacking hazard of picking a search radius, and that
reasoning was sound. But a KS statistic on the full distribution puts its
sensitivity where the probability *mass* is, and the near-antipode region holds
**0.05% of it**. A KS test on this distribution is therefore structurally
dominated by the bulk and the far tail, and can barely see the region the
hypothesis is actually about. The registered test avoided one methodological
error by adopting another.

**What must not be done with this.** The descriptive comparison below is
recorded because hiding it would be worse, and it is **not a result**:

| within | observed | reference | ratio |
|---|---|---|---|
| 250 km | 0.056% (~24 events) | 0.025% (~11) | 2.2× |
| 500 km | 0.160% | 0.100% | 1.6× |
| 1000 km | 0.515% | 0.461% | 1.1× |
| 2000 km | 2.124% | 2.090% | 1.0× |

Turning any row of that table into a test would be choosing a radius **after
seeing the data** — exactly what the original registration forbade, and what the
"rings carry no statistical meaning" note has said since the Explore panel was
built. The counts are also small (≈24 against ≈11 expected is about two
standard deviations on Poisson noise), and the registered test, which is the one
that was actually run, does not distinguish it from chance.

A radius-based or annulus-based test of antipodal triggering is defensible
*a priori* — but it has to be registered as its own hypothesis, with its radius
fixed from physics rather than from this table, tested against data not used
here where possible (rule 6), and paid for in the FDR denominator. See the
antipodal-ring note under Exploratory Observations, which was written **before**
this run for exactly this reason.

**The lesson for future registrations:** "avoid a free parameter by testing the
whole distribution" is not automatically the conservative choice. It can trade a
p-hacking hazard for a power failure, and the trade should be measured — by
asking what fraction of the distribution's mass lies in the region the
hypothesis is about — *at registration time*, not discovered afterwards.

**Five parameters completed 2026-08-20 before the first run**, by the same rule
as H4c's, H3b's, H2b's and H1b's own completions: the trigger set, target set,
time window, distance treatment and the *fact* of a completeness correction were
registered, but the null model, the precise statistic, the tail, the time range
and the seed were left implied — which rule 2 forbids. H5 has never been run, so
this finishes the registration rather than amending a result. `CircularShift` in
`engine/terra_pulse_engine/pipeline/monte_carlo.py` states the same rule from the
code side: a null model without its own registered entry cannot produce a real
result.

**The completeness correction is satisfied by conditioning, not by an Mc map,
and this is the substantive decision here.** `PROJECT_PLAN.md` §5.3 specified a
magnitude-of-completeness map, and H5 was marked "blocked" on it for weeks. The
time-shuffled null makes that map **unnecessary rather than deferred**:

- The null keeps every target event exactly where the catalogue recorded it, and
  keeps every trigger's antipode exactly where it is. Only the *timing* is
  randomised.
- So the observed and null distributions live in the same instrument-biased
  world, and detection bias **cancels** instead of needing to be estimated. "No
  quake detected near this antipode" suppresses the observed and the null
  identically.
- An Mc map would introduce several new free parameters — grid size, Mc
  estimator, minimum events per cell — in order to *estimate* what the shuffle
  *conditions on* exactly. Under non-negotiable #3 that is strictly worse.

This is why the entry above says "completeness-weighted" is met while no Mc map
exists. **It is not a weakening of the requirement**; the requirement was that
absence near an antipode must not be read as evidence, and conditioning enforces
that more strictly than weighting would.

**Registered in advance: this test is underpowered, and a null result will not
mean the effect is absent.** Measured over the whole 1970– record before any
statistic was computed:

| radius | M6.0+ antipodes with *zero* M5.0+ ever recorded |
|---|---|
| 250 km | **63.3%** (5,010 of 7,916) |
| 500 km | **35.6%** (2,818 of 7,916) |
| 1000 km | 9.4% (743 of 7,916) |

The median antipode has recorded **2 events in 57 years**. Seismicity is also
extremely concentrated — 15 of 648 ten-degree cells hold half of all M5.0+
events — which is why a uniform-on-sphere null was never an option. Stating this
*before* the run is the point: afterwards, "no excess found" could be dressed up
as evidence of absence, and it will not be that.

**Why the whole distribution and not a radius.** Kept exactly as registered in
2026-07-24. Antipodal focusing is documented to be strongest at 180° and to fall
off within a few degrees, so a near-antipode excess is the directional
prediction — but choosing a radius after seeing the data is the p-hacking hazard
the original entry already named. The full-distribution KS avoids it. The
empirical distance CDF is reported alongside the test as a *description*, not as
a family of implicit radius tests.

### H6 — Lunisolar tidal stress

| Field | Value |
|---|---|
| **Registered** | 2026-07-24 |
| **Completed** | **2026-08-21** — the ★ fields below were implied but never stated. Filled in before any code ran, per rule 2. See "Why this is a completion" below. |
| **Status** | Not yet run (Phase 5) |
| **Statement** | Declustered M5.5+ earthquake occurrence is not uniformly distributed in lunisolar tidal phase, where phase is measured on the tidal shear stress resolved onto the event's own focal-mechanism fault plane. |
| **Ephemeris** | JPL DE440 via Skyfield — kernel `de440s.bsp` (32.7 MB, covering 1849-2150) ★ |
| **Orientation source** ★ | **Global CMT**, `jan76_dec25.ndk` plus `NEW_MONTHLY/`. Joined to each USGS event by origin time and hypocentre: the nearest CMT event within **±60 s and ≤100 km**. Events with no match are excluded, and the excluded fraction is reported per era. |
| **Target set** ★ | Declustered **M5.5+** global (Gardner-Knopoff), restricted to events carrying a CMT orientation. See "Why M5.5+" below — this overrides the shared M4.5+ and the M5.0+ used by H1b/H2b/H3b/H4c/H5. |
| **Effective span** ★ | **1976-01-01 onward.** The shared catalogue starts 1970, but Global CMT starts 1976 and it is the only orientation source. The engine truncates and reports the truncation rather than absorbing it. |
| **Stress quantity** ★ | Tidal **shear stress** resolved onto nodal plane 1 in its slip direction. **Not Coulomb and not normal stress** — see "Why shear" below. |
| **Stress computation** | Full lunisolar tidal stress tensor at hypocenter location and origin time, resolved onto the focal mechanism nodal plane |
| **Tidal phase angle** ★ | 0° at each local **maximum** of the computed shear-stress time series at that hypocentre, ±180° at the minima, linear in time between successive extrema. Referenced to the event's own computed series, so no tidal constituent has to be named. |
| **Binning** | Tidal phase in 12 bins across the tidal cycle — 30° windows, **for presentation and the sinusoidal fit only**. The test statistic below is unbinned. ★ |
| **Test statistic** ★ | **Schuster's test.** Each event is a unit vector at its tidal phase angle; the statistic is the resultant length R over N events. |
| **Null model** ★ | Origin instants redrawn uniformly without replacement from every hour in the analysis span, keeping the same count and the **same hypocentres and mechanisms**, with phase recomputed. 10,000 iterations. |
| **Tail** ★ | One-sided upper — excess concentration at some phase. |
| **Subsets** | All events; subduction-zone events only (2 subsets). ★ **"Subduction-zone" is defined as a hypocentre within 300 km of a Slab2 trench line**, using the 21 trench lines already vendored here. |
| **Tests in family** | 2 |
| **Mechanism plausibility** | **Highest of any hypothesis here.** Established physical mechanism, existing peer-reviewed literature finding weak but detectable tidal triggering. Starting references: Tanaka; Cochran, Vidale & Tanaka. |
| **Result** | — |

**Why this is a completion and not a fifth supersession.** The matrix section
below warns that a fifth supersession would mean the "measure the source first"
rule is being ignored. It is not being ignored here — **it is the reason these
values exist.** Global CMT was fetched and measured in full before a line of H6
code was written, and the results are in `SOURCES.md`.

H1-H4 each named a *specific source* that turned out to be wrong, which is why
each needed a new entry. H6 named no orientation source at all; it said "focal
mechanism nodal planes" and left the rest implied. Naming one is filling a hole,
not correcting a claim. The one substantive narrowing — M5.0+ → M5.5+ — is
structurally identical to **H4c's "Effective span"**, which was also a narrowing
of the usable data forced by measuring the source, and was also done in place.
The condition both rest on is the same and is not weaker here: **H6 has never
been run.** No p-value exists under it to protect.

**Why M5.5+, when every other hypothesis here uses M5.0+.** The binding limit is
not Global CMT's own completeness — it is **what fraction of the target set can
be given an orientation at all**, which nobody had measured. Joined to this app's
catalogue:

| floor | 1977-89 | 2000-03 | 2013-25 | swing |
|---|---|---|---|---|
| M5.0+ | 39.5% | 74.6% | 80.6% | **2.0×** |
| M5.5+ | 84.3% | 95.1% | 94.0% | 1.13× |
| M6.0+ | 93.3% | 97.8% | 97.7% | 1.05× |

At M5.0+ the *orientable* catalogue doubles across the record, so the target set
would be "the subset that happened to get a CMT" rather than "M5.0+ events".
M5.5 is where that stops moving — the same floor this project already uses for
rate claims, reached here from an unrelated measurement. It is also the floor
Tanaka, Ohtake & Sato (2002) used against this same catalogue.

**The drift would probably not have invalidated M5.0+, and that is worth saying
rather than leaning on a rule.** A secular drift sank the *rate* tests because
they correlate a drifting catalogue against a driver that also varies over the
record. A phase test is different: every era samples tidal phase uniformly, so an
aperiodic drift reweights the eras without biasing the null. What *would* be
fatal is a detection bias periodic at a tidal frequency — and there is exactly
one candidate, **S2, the solar semidiurnal tide, whose 12.000 h period is locked
to solar time and never averages out** (M2 at 12.42 h beats against the solar day
every 14.77 days and does). Measured by Rayleigh on local solar time, the S2
amplitude is **0.19% at M5.0+ and 0.17% at M5.5+, p > 0.95** — every resultant at
its noise floor. So M5.5+ is chosen for the cleaner claim, not because M5.0+ was
shown to be broken.

**Why shear stress, and why the fault-plane ambiguity therefore does not exist.**
A focal mechanism gives two nodal planes and neither is knowably the fault.
That ambiguity is fatal to a **Coulomb** or **normal-stress** formulation —
verified here, the two planes' normal stress differs on **98.5%** of the 70,044
real GCMT mechanisms. Choosing a plane per event would be a free parameter with
no evidence behind it, which non-negotiable #3 forbids.

**Shear stress has no such problem, because it is identical on both planes.**
For conjugate planes n₂ = u₁ and u₂ = n₁, so the resolved shear is n₁·σ·u₁
against u₁·σ·n₁ — equal for any symmetric σ. Verified numerically against all
70,044 published mechanisms: **worst difference 3.3 × 10⁻¹⁶**, machine precision.
Tanaka et al. (2002) made the same choice for the same reason, and their positive
result was on tidal shear stress.

- **Read nodal plane 1 only; never consult plane 2.** It is redundant by the
  identity above, and GCMT publishes both rounded to whole degrees, so the two
  listed planes disagree in resolved shear by **1.3% at the median and 9.6% at
  p90**. That disagreement is publication precision, not physics, and an
  implementation that compares the planes will read it as a real difference and
  be tempted to "pick the right one".

**Why 300 km of a Slab2 trench, over the alternatives.** It is the literal
reading of "subduction-zone events", it uses geometry already vendored here, and
it has the best power of the options: **12,419 raw M5.5+ → roughly 5,900 after
the join and declustering**, which lets Schuster resolve about a 2.6% modulation.
It cross-checks well — PB2002's 71 `SUB` segments at the same radius select
12,283 events, agreeing to 1%. The alternative considered and rejected was the
literature's own subset (shallow thrust: rake 45-135°, depth ≤ 70 km, 6,392
events), which needs no radius but is a *mechanism* filter rather than a zone
filter and sweeps in continental collision thrusts.

**The 300 km is a free parameter and is declared as one.** It is fixed here,
before any result exists, which is what non-negotiable #3 requires — the hazard
that rule guards against is a radius chosen *after* seeing the distribution,
which is exactly what H5's own post-run note records. It must not be adjusted
once a result is known.

**Running H6 returns the FDR denominator to 19.** Its 2 tests are currently
counted in the 19-test total but excluded from the 17 *unblocked*. No recorded
result changes: the smallest raw p-value anywhere in this file is 0.0872, and
0.0872 × 19 still exceeds 1, so every adjusted value stays 1.0000. Every
already-run family was reported against 19 before H4b's withdrawal anyway.

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
| ~~H1~~ | 0 - withdrawn unrun 2026-08-17, replaced by H1b |
| H1b | 4 |
| ~~H2~~ | 0 - withdrawn unrun 2026-08-17, replaced by H2b |
| H2b | 2 |
| ~~H3~~ | 0 — withdrawn unrun 2026-08-15, replaced by H3b |
| H3b | 4 |
| ~~H4~~ | 0 — withdrawn unrun 2026-08-14, replaced by H4c |
| H4c | 6 |
| ~~H4b~~ | 0 — withdrawn unrun 2026-08-20, **not** replaced |
| H5 | 1 |
| H6 | 2 |
| **Total** | **19** |

**H4b is the one withdrawal that is not a supersession**, and it is accounted
for differently on purpose. The four above it each transferred their tests to a
replacement, so the total never moved. H4b has no replacement, so its 2 tests
leave the matrix outright: **21 → 19 total, 19 → 17 unblocked.**

That is legitimate on the same condition as the others and no weaker one:
**H4b was never run.** No p-value was computed under it, so nothing is being
removed from the correction — there is no result, not a discarded one. A family
that *has* been run keeps its tests in the denominator forever whatever happens
to it afterwards; that is rule 5, and it is not what happened here.

The check that keeps this honest is that **shrinking the denominator made no
result easier to pass.** Every adjusted p-value in the file was already 1.0000
at 19, and the smallest raw p-value anywhere is 0.0872 — which stays 1.0000 at
17. Had any result been near the threshold, dropping a denominator would be the
one move to be most suspicious of, and it would have needed to happen *before*
that result existed or not at all.

**Why the total did not move when H1b, H2b, H3b and H4c were added.** None is a
new question — each is its predecessor with a corrected data source or a
parameter that was never specified, registered separately because rule 3 forbids
editing a registered one. Counting every pair would put **37** in the
denominator and make **every other hypothesis in this file harder to pass** in
exchange for four provenance fixes, which is a real cost paid for nothing.

The condition that makes this legitimate, and the one to check before ever doing
it again: **none of H1, H2, H3 or H4 was ever run.** No p-value was computed
under any of them, so nothing is being dropped from the correction — there is no
result, not a discarded one. A family that *has* been run keeps its tests in the
denominator forever, whatever happens to it afterwards; that is rule 5, and it is
not what happened here.

**Four supersessions in four days is the pattern, and the diagnosis is the
registration practice rather than the individual entries.** H1 through H4 were
all registered on 2026-07-24, against sources nobody had queried. Every one of
them then failed on contact with the data — an incomplete catalogue, a source
that could not supply the history, a trigger set that was underspecified, a
baseline that was never defined. That is four for four.

**The rule this establishes: do not register a hypothesis against a source until
the source has been ingested and its completeness measured.** Writing an entry is
cheap and feels like rigour; it is only rigour if the parameters in it can
survive the data. A fifth supersession means this rule is being ignored, not that
the data was surprising again.

**H6's completion on 2026-08-21 is not that fifth supersession, and the
distinction is the rule itself.** Global CMT was measured in full *before* any H6
code existed, and the parameters were written against those measurements rather
than ahead of them. H1-H4 each named a specific source that failed on contact;
H6 named no orientation source at all, so naming one fills a hole rather than
correcting a claim. Its one substantive narrowing — M5.0+ → M5.5+ — matches
**H4c's "Effective span"** precedent exactly: a narrowing of usable data forced
by measuring the source, completed in place because the entry had never been run.
Full reasoning is in H6's own entry.

**H4b is the fifth entry that failed on contact with its source, and it is the
first one the rule actually caught.** It was registered the same day as H1-H4,
against a source nobody had queried, and when INTERMAGNET was finally measured
on 2026-08-20 the entry turned out to be underspecified in six places and to
rest on a premise the data contradicts. The difference is what happened next: it
was checked **before** an ingest was built rather than after, and the answer was
to withdraw rather than to write H4d. That is the rule working — the outcome it
is supposed to produce is sometimes "don't run this", not "register it again
more carefully."

## Progress against the matrix (2026-08-20)

**All 17 unblocked tests have been run. None was rejected.** Nothing remains
blocked. H6's 2 were deferred to Phase 5 by its own registration when this was
written; **that stopped being true on 2026-08-21** — see the note under the
table.

| Family | Tests | Run | Outcome |
|---|---|---|---|
| H1b | 4 | 2026-08-19 | Not rejected — ratios 0.974-1.011 |
| H2b | 2 | 2026-08-19 | Not rejected — ratios 0.925-1.063 |
| H3b | 4 | 2026-08-19 | Not rejected — ratios 0.986-1.021 |
| H4c | 6 | 2026-08-18 | Not rejected — ratios 0.974-1.013 |
| H5 | 1 | 2026-08-20 | Not rejected — KS D⁺ 0.0016, below the null mean |
| ~~H4b~~ | 0 | — | **Withdrawn unrun 2026-08-20** — see its entry |
| H6 | 2 | — | **Registration completed 2026-08-21; unblocked, not yet run** |

**H5 is no longer blocked on a magnitude-of-completeness map**, and that map is
not merely deferred — the registered null makes it unnecessary. See H5's entry.

**H6 is no longer deferred, as of 2026-08-21.** Global CMT was fetched and
measured in full — 70,044 events, 1976-2025, every one carrying both nodal
planes — and the parameters H6 left implied were completed in its entry against
those measurements. Nothing about it is blocked any more; it is unbuilt.

**When it runs, the unblocked denominator returns to 19** and the summary above
becomes "17 of 19". No recorded value changes: 0.0872 × 19 still exceeds 1, and
the five runs below were executed against a 19-test denominator to begin with.

**Not one test in five families produced a deviation larger than 7%, and the
smallest raw p-value anywhere is 0.0872.** After correction against the
unblocked matrix, every adjusted p-value in every family is 1.0000. That is the
honest summary of Phase 4 so far, and rule 5 says it gets recorded exactly as
prominently as a rejection would have been.

The five runs recorded above were executed against a **19**-test denominator,
before H4b was withdrawn; the denominator is **17** from 2026-08-20. Neither
figure changes any recorded value — 0.0872 × 17 already exceeds 1 — so nothing
was re-run on account of the withdrawal, and this note exists so that the
mismatch between the runs' own reported denominator and the current one is a
recorded fact rather than a discrepancy someone finds later.

**All four were re-run on 2026-08-20 and reproduced.** The `Status` and
`Result` fields had drifted — they still read "Not yet run" for H4c, H3b and
H2b, which had all in fact been executed days earlier. Rather than transcribe
the ratio ranges that were recorded elsewhere, each was re-run against the live
database with its own registered seed and parameters. The ratio ranges match
what was originally reported to three decimals; the raw counts differ by
10-20 events per family, because the earthquake catalogue has kept growing
since. Those re-runs are the numbers now recorded above.

**This is reproduction, not re-testing, and the distinction matters.** Every
seed is registered and fixed, so a re-run is deterministic given the same
catalogue; nothing was re-parameterised, and no result changed direction. Had a
re-run disagreed with what was recorded, the discrepancy would belong in this
file rather than being resolved in favour of whichever was more convenient.

Every run reports adjusted p-values against the full unblocked matrix — **17**
tests from 2026-08-20, 19 before that — not against the handful executed in one
session, so no result has been compared against a conveniently small
denominator.

At an uncorrected threshold of p < 0.05, roughly **1 false positive is expected
from noise alone** across this matrix. FDR correction is applied across all 19
registered tests, H6's deferred pair included.

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
| 2026-08-20 | Whether antipodal triggering, if it exists, concentrates in a **ring some tens of degrees from the antipode** rather than at the antipode itself. Raised from a half-remembered secondary source, before H5 was run and before any distance distribution had been computed. | Not registered — see the note below |

### Notes on the antipodal-ring idea (2026-08-20)

Recorded before H5's first run, so the date is the guarantee that it was not
suggested by H5's output.

**There is a real physical basis, and it is not at 30°.** Antipodal focusing at
exactly 180° is well documented — body-wave phases (PKP, PP, PPP, SS and others)
converge there and amplify by up to an order of magnitude, with the effect
falling off within a few degrees. Separately, a **second convergence exists at
the PKP caustic near 140° epicentral distance**, where core-refracted waves focus
strongly enough that small events become detectable on the far side of the
Earth. 140° epicentral is **40° from the antipode**, which is the likeliest
origin of the recollection.

**Why it is not being tested now, and what would license testing it.** H5's
registered statistic is the *full* distance distribution, so caustic structure
would appear as a deviation and will be visible in the reported CDF. That does
**not** license claiming a caustic result afterwards. Registering a directed
band test once H5's distribution has been seen — at whatever radius the bump
happens to be — is precisely the free-parameter-after-the-fact non-negotiable #3
forbids, and it is the specific trap this file's own
`ANTIPODAL_WINDOW_HOURS` note already warns about in another form.

To become a hypothesis it needs, fixed in advance and before consulting H5's
output: a band derived from a **citable** source rather than from a remembered
figure, its own entry, and its own slot in the FDR denominator (21 → 22, which
makes every other hypothesis here harder to pass). That cost is the reason to be
sure of the mechanism first.

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
