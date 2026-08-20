"""H1b — solar flares (GOES XRS 1996-2016 + DONKI 2017 onward) vs. declustered
global M5.0+ seismicity rate.

Assembly only, same posture as the other three. Structurally it is **h4c.py's
statistic with h2b.py's trigger delivery**: the moving-window Poisson baseline
and lag-window ratio are H4c's exactly, but the triggers arrive as a list of
instants rather than being extracted from a thresholded hourly series, because
a flare catalogue is a list of discrete events with no series behind it. So
`pipeline.triggers` is not used here at all, and the null-draw pool is every
hour in the span (h2b.py's `np.arange`) rather than an eligibility mask.

The M1.0+ filter is applied by main before the request is built — this module
receives peak instants, not flare classes to re-derive the registered threshold
from a second time. Same rule as H2b's `isDirectImpact`.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

import numpy as np

from terra_pulse_engine.api.contracts import (
    AnalysisResult,
    CatalogInfo,
    CorrectionInfo,
    DiscreteTriggerRunRequest,
    MethodInfo,
    NullHistogram,
    NullInfo,
    SpanInfo,
    TestResult,
    TriggerInfo,
)
from terra_pulse_engine.pipeline.baseline import HOUR_MS, local_rate_per_hour
from terra_pulse_engine.pipeline.decluster import decluster_gardner_knopoff
from terra_pulse_engine.pipeline.lag_windows import lag_window_statistic
from terra_pulse_engine.pipeline.monte_carlo import UniformRedraw, permutation_null
from terra_pulse_engine.pipeline.multiple_comparisons import benjamini_hochberg
from terra_pulse_engine.version import ENGINE_VERSION

# HYPOTHESES.md H1b: "Time range: 1996-01-01 onward." Already inside the M5.0+
# catalogue's own 1970-onward completeness window, so unlike H4c's 1963 nothing
# truncates — the 1996 bound is a solar-side constraint (the GOES 1-7 flux
# scaling correction) that clears the earthquake-side one with room to spare.
EFFECTIVE_START_MS = int(datetime(1996, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)

DEFERRED_TESTS = 2
# Zero since 2026-08-20, when H4b was withdrawn unrun. It was 2 while H4b sat
# blocked on a magnetometer archive that was never built; a withdrawn-unrun
# family is not "blocked", it is gone, and its tests left the denominator with
# it (see HYPOTHESES.md H4b and REGISTERED_MATRIX_TESTS in packages/schema).
BLOCKED_TESTS = 0

# One trigger *definition* — "a flare of class M1.0 or above" — so a single
# fixed id, like h2b.py's, rather than h4c.py's loop over two indices.
TRIGGER_ID = "flare>=M1.0"


def _iso(ms: int) -> str:
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def run_h1b(request: DiscreteTriggerRunRequest) -> AnalysisResult:
    start_time = time.monotonic()
    params = request.parameters

    catalog_time = np.asarray(request.catalog.time_ms, dtype=np.int64)
    catalog_lat = np.asarray(request.catalog.latitude, dtype=float)
    catalog_lon = np.asarray(request.catalog.longitude, dtype=float)
    catalog_mag = np.asarray(request.catalog.magnitude, dtype=float)

    # Decluster over everything sent, then restrict to the registered start —
    # same reasoning as h4c.py's EFFECTIVE_START_MS: a pre-1996 mainshock can
    # still correctly claim a post-1996 aftershock, so the declustering wants
    # full context even though the target set does not.
    independent_mask = decluster_gardner_knopoff(catalog_time, catalog_lat, catalog_lon, catalog_mag)
    target_time_all = np.sort(catalog_time[independent_mask])
    target_time = target_time_all[target_time_all >= EFFECTIVE_START_MS]

    raw_count = int(np.sum(catalog_time >= EFFECTIVE_START_MS))
    declustered_count = int(target_time.shape[0])

    trigger_times = np.asarray(request.flare_peak_times_ms, dtype=np.int64)
    trigger_times.sort()
    trigger_times = trigger_times[trigger_times >= EFFECTIVE_START_MS]

    span_end_ms = int(trigger_times[-1]) if trigger_times.size > 0 else EFFECTIVE_START_MS
    span_end_ms = max(
        span_end_ms, int(target_time[-1]) if target_time.size > 0 else EFFECTIVE_START_MS
    )

    # Every hour in the span is an equally valid hypothetical flare instant —
    # there is no threshold series whose gaps could disqualify one, which is
    # what h4c.py/h3b.py's eligibility mask encodes and why H1b registers no
    # gap-handling rule. Same construction as h2b.py.
    eligible_times_ms = np.arange(EFFECTIVE_START_MS, span_end_ms, HOUR_MS, dtype=np.int64)

    half_width_days = params.baseline_window_days / 2.0

    # ---- Precomputed null lookups: the optimization that makes H1b fit ----
    #
    # Both quantities the null needs — the local baseline rate and the observed
    # count in a lag window — are *pure functions of the trigger instant*. The
    # null draws every trigger from one fixed pool (`eligible_times_ms`), so
    # both can be evaluated once per eligible hour and then read by index,
    # instead of re-running four binary searches per drawn trigger per
    # iteration.
    #
    # Measured on the real catalogue (4,598 triggers, 26,577 declustered
    # targets, 268,531 eligible hours, 10,000 iterations x 4 windows): the
    # direct form ran **102 s against main's 120 s IPC timeout** — inside the
    # budget but with no headroom worth having. This is exact rather than an
    # approximation: the same pipeline functions produce the tables, and
    # `test_h1b.py` pins the lookup path against a per-row reference.
    #
    # ~4 MB of float64 for the two tables, which is nothing next to the
    # catalogue already in memory.
    rate_by_eligible_hour = local_rate_per_hour(
        target_time,
        eligible_times_ms,
        half_width_days=half_width_days,
        span_start_ms=EFFECTIVE_START_MS,
        span_end_ms=span_end_ms,
    )

    def _counts_by_eligible_hour(lag_start: float, lag_end: float) -> np.ndarray:
        lo = np.searchsorted(target_time, eligible_times_ms + lag_start * HOUR_MS, side="left")
        hi = np.searchsorted(target_time, eligible_times_ms + lag_end * HOUR_MS, side="left")
        return (hi - lo).astype(float)

    raw_p_values: list[float] = []
    test_ids: list[tuple[str, tuple[float, float]]] = []
    test_payload: dict[str, dict] = {}

    for lag_start, lag_end in params.lag_windows_hours:
        rate_per_hour = local_rate_per_hour(
            target_time,
            trigger_times,
            half_width_days=half_width_days,
            span_start_ms=EFFECTIVE_START_MS,
            span_end_ms=span_end_ms,
        )
        observed_stat = lag_window_statistic(
            target_time,
            trigger_times,
            rate_per_hour,
            lag_start_hours=lag_start,
            lag_end_hours=lag_end,
        )

        null_model = UniformRedraw(eligible_times_ms, trigger_times.shape[0])
        counts_lookup = _counts_by_eligible_hour(lag_start, lag_end)
        expected_lookup = rate_by_eligible_hour * (lag_end - lag_start)

        def statistic_fn(
            drawn: np.ndarray,
            _counts: np.ndarray = counts_lookup,
            _expected: np.ndarray = expected_lookup,
        ) -> np.ndarray:
            # The drawn instants come from `eligible_times_ms`, which is a
            # uniform hourly arange — so a drawn time maps back to its pool
            # index by exact integer arithmetic, with no search at all.
            index = (drawn - EFFECTIVE_START_MS) // HOUR_MS

            observed = _counts[index].sum(axis=1)
            expected = _expected[index].sum(axis=1)

            # Matches lag_window_statistic's own guard: no exposure means no
            # ratio. permutation_null compares against a finite observed
            # statistic, so a non-finite draw would silently never exceed it.
            return np.where(expected > 0, observed / np.where(expected > 0, expected, 1.0), 0.0)

        observed_ratio = observed_stat.ratio if not np.isnan(observed_stat.ratio) else 0.0
        permutation = permutation_null(
            observed_statistic=observed_ratio,
            draw_fn=null_model.draw,
            statistic_fn=statistic_fn,
            iterations=params.iterations,
            seed=params.seed,
            tail=params.tail,
        )

        test_id = f"H1b/{TRIGGER_ID}/{lag_start:g}-{lag_end:g}h"
        raw_p_values.append(permutation.p_value)
        test_ids.append((test_id, (lag_start, lag_end)))
        test_payload[test_id] = {"observed": observed_stat, "permutation": permutation}

    bh_within_run = benjamini_hochberg(np.array(raw_p_values), params.q)
    bh_full_matrix = benjamini_hochberg(
        np.array(raw_p_values), params.q, family_size=params.registered_matrix_tests
    )

    tests: list[TestResult] = []
    for i, (test_id, lag) in enumerate(test_ids):
        observed_stat = test_payload[test_id]["observed"]
        permutation = test_payload[test_id]["permutation"]
        tests.append(
            TestResult(
                id=test_id,
                trigger_id=TRIGGER_ID,
                lag_hours=lag,
                observed=observed_stat.observed,
                expected=observed_stat.expected,
                ratio=observed_stat.ratio,
                p_raw=permutation.p_value,
                p_adjusted_within_run=float(bh_within_run.p_adjusted[i]),
                p_adjusted_full_matrix=float(bh_full_matrix.p_adjusted[i]),
                rejected_at_q=bool(bh_full_matrix.rejected[i]),
                null=NullInfo(
                    mean=permutation.null.mean,
                    sd=permutation.null.sd,
                    quantiles=permutation.null.quantiles,
                    histogram=NullHistogram(
                        edges=permutation.null.histogram_edges,
                        counts=permutation.null.histogram_counts,
                    ),
                ),
            )
        )

    span = SpanInfo(
        requested_start_utc=params.requested_start_utc,
        used_start_utc=_iso(EFFECTIVE_START_MS),
        used_end_utc=_iso(span_end_ms),
        truncation_reason=None,
    )

    caveats = [
        f"{declustered_count} declustered M5.0+ events since 1996, against "
        f"{int(trigger_times.shape[0])} M1.0+ flares. The M1.0 floor is "
        "registered (HYPOTHESES.md H1b), not chosen after seeing results.",
        "M5.0+ event counts rose approximately 36% from the 1970s to the 2010s; "
        f"the moving local baseline (±{half_width_days:.1f} days) is the "
        "registered mitigation, not a removal of that trend.",
        "Flares cluster heavily — an active region can produce many M-class "
        "flares over a few days — so lag windows from nearby triggers overlap. "
        "Observed and expected counts are both summed with multiplicity, so the "
        "overlap cancels in the ratio, but the tests in this family are not "
        "independent of one another.",
        "Two catalogues supply the trigger set, split at 2017: NOAA GOES XRS "
        "below, NASA DONKI above. They agree to 97-100% on their 2014-2016 "
        "overlap, but whether \"M1.0\" means exactly the same thing across the "
        "whole 1996-onward span has not been verified — GOES instruments changed "
        "within that period.",
    ]

    if not request.flare_coverage_complete:
        # Front of the list: this one changes what the whole result means.
        caveats.insert(
            0,
            "INCOMPLETE TRIGGER SET — the registered GOES 1996-2016 flare record "
            "is not fully downloaded, so this run used only the flares present. "
            "Every count, ratio and p-value below is computed on a partial "
            "trigger set and is not the registered test.",
        )

    correction = CorrectionInfo(
        method="benjamini-hochberg",
        q=params.q,
        tests_run=len(raw_p_values),
        registered_matrix_tests=params.registered_matrix_tests,
        deferred_tests=DEFERRED_TESTS,
        blocked_tests=BLOCKED_TESTS,
        partial_matrix=len(raw_p_values) < params.registered_matrix_tests,
        note=(
            f"{len(raw_p_values)} of {params.registered_matrix_tests} registered, "
            f"unblocked tests have been run so far ({DEFERRED_TESTS} more are "
            "deferred to Phase 5). "
            "Adjusted p-values are provisional until the full matrix is complete."
        ),
    )

    method = MethodInfo(
        null_model=params.null_model,
        tail=params.tail,
        baseline_window_days=params.baseline_window_days,
        iterations=params.iterations,
    )

    duration_ms = int((time.monotonic() - start_time) * 1000)

    return AnalysisResult(
        contract_version=request.contract_version,
        engine_version=ENGINE_VERSION,
        hypothesis_id="H1b",
        run_at_utc=_iso(int(time.time() * 1000)),
        duration_ms=duration_ms,
        seed=params.seed,
        span=span,
        catalog=CatalogInfo(
            min_magnitude=params.target_min_magnitude,
            raw_count=raw_count,
            declustered_count=declustered_count,
            declustering=params.declustering,
        ),
        triggers=[
            TriggerInfo(
                id=TRIGGER_ID,
                count=int(trigger_times.shape[0]),
                eligible_hours=int(eligible_times_ms.shape[0]),
            )
        ],
        tests=tests,
        correction=correction,
        method=method,
        caveats=caveats,
    )
