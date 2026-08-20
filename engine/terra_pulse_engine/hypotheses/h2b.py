"""H2b — hemispheric asymmetry at CME arrival vs. declustered global M5.0+
seismicity. Assembly only, same posture as h4c.py/h3b.py, but a genuinely
different test shape: no Poisson baseline, no threshold-episode extraction.
The trigger set is CME arrivals, already filtered to direct impacts by main
(`isDirectImpact`, `packages/schema/src/solar-events.ts`) before the request
ever reaches here — this module receives arrival instants, not raw
glancing-blow flags to re-derive the same registered rule from.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

import numpy as np

from terra_pulse_engine.api.contracts import (
    AnalysisResult,
    CatalogInfo,
    CorrectionInfo,
    HemisphereRunRequest,
    MethodInfo,
    NullHistogram,
    NullInfo,
    SpanInfo,
    TestResult,
    TriggerInfo,
)
from terra_pulse_engine.pipeline.decluster import decluster_gardner_knopoff
from terra_pulse_engine.pipeline.hemisphere import HOUR_MS, hemisphere_ratio_statistic
from terra_pulse_engine.pipeline.monte_carlo import UniformRedraw, permutation_null
from terra_pulse_engine.pipeline.multiple_comparisons import benjamini_hochberg
from terra_pulse_engine.version import ENGINE_VERSION

# HYPOTHESES.md H2b: "Time range: 2014-01-01 onward." Already well inside the
# earthquake catalogue's own 1970-onward completeness window, unlike H4c's
# 1963, so this needs no separate truncation the way H4c's did.
EFFECTIVE_START_MS = int(datetime(2014, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)

DEFERRED_TESTS = 2
BLOCKED_TESTS = 2

# A single fixed trigger id — H2b has exactly one trigger *definition*
# ("direct CME impact"), not several the way H4c has two indices. Kept as a
# named constant rather than a literal scattered across the module.
TRIGGER_ID = "direct-impact"


def _iso(ms: int) -> str:
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def run_h2b(request: HemisphereRunRequest) -> AnalysisResult:
    start_time = time.monotonic()
    params = request.parameters

    catalog_time = np.asarray(request.catalog.time_ms, dtype=np.int64)
    catalog_lat = np.asarray(request.catalog.latitude, dtype=float)
    catalog_lon = np.asarray(request.catalog.longitude, dtype=float)
    catalog_mag = np.asarray(request.catalog.magnitude, dtype=float)

    # Decluster over everything sent, then restrict to the registered
    # 2014-01-01 start — same reasoning as h4c.py's EFFECTIVE_START_MS.
    # Longitude has to travel through this step paired with time (unlike
    # h4c.py/h3b.py, which only ever needed timestamps), so sorting is done
    # explicitly here rather than via a bare np.sort on time alone.
    independent_mask = decluster_gardner_knopoff(catalog_time, catalog_lat, catalog_lon, catalog_mag)
    independent_time = catalog_time[independent_mask]
    independent_lon = catalog_lon[independent_mask]
    time_order = np.argsort(independent_time, kind="stable")
    target_time_all = independent_time[time_order]
    target_lon_all = independent_lon[time_order]

    effective_mask = target_time_all >= EFFECTIVE_START_MS
    target_time = target_time_all[effective_mask]
    target_longitude = target_lon_all[effective_mask]

    raw_count = int(np.sum(catalog_time >= EFFECTIVE_START_MS))
    declustered_count = int(target_time.shape[0])

    trigger_times = np.asarray(request.cme_arrival_times_ms, dtype=np.int64)
    trigger_times.sort()
    span_end_ms = int(trigger_times[-1]) if trigger_times.size > 0 else EFFECTIVE_START_MS
    span_end_ms = max(span_end_ms, int(target_time[-1]) if target_time.size > 0 else EFFECTIVE_START_MS)

    # The null-draw pool: every hour in the analysis span. There is no
    # threshold series here, so unlike triggers.py's eligibility (which
    # excludes hours where a measured window couldn't have started), every
    # hour is an equally valid hypothetical arrival instant.
    eligible_times_ms = np.arange(EFFECTIVE_START_MS, span_end_ms, HOUR_MS, dtype=np.int64)

    raw_p_values: list[float] = []
    test_ids: list[tuple[str, tuple[float, float]]] = []
    test_payload: dict[str, dict] = {}

    for lag_start, lag_end in params.lag_windows_hours:
        observed_stat = hemisphere_ratio_statistic(
            target_time,
            target_longitude,
            trigger_times,
            lag_start_hours=lag_start,
            lag_end_hours=lag_end,
            split_degrees=params.spatial_split_degrees,
        )

        null_model = UniformRedraw(eligible_times_ms, trigger_times.shape[0])

        def statistic_fn(
            drawn: np.ndarray, _lag_start: float = lag_start, _lag_end: float = lag_end
        ) -> np.ndarray:
            results = np.empty(drawn.shape[0], dtype=float)
            for row in range(drawn.shape[0]):
                drawn_times = np.sort(drawn[row])
                stat = hemisphere_ratio_statistic(
                    target_time,
                    target_longitude,
                    drawn_times,
                    lag_start_hours=_lag_start,
                    lag_end_hours=_lag_end,
                    split_degrees=params.spatial_split_degrees,
                )
                results[row] = stat.ratio
            return results

        observed_ratio = observed_stat.ratio if not np.isnan(observed_stat.ratio) else 0.0
        permutation = permutation_null(
            observed_statistic=observed_ratio,
            draw_fn=null_model.draw,
            statistic_fn=statistic_fn,
            iterations=params.iterations,
            seed=params.seed,
            tail=params.tail,
        )

        test_id = f"H2b/{TRIGGER_ID}/{lag_start:g}-{lag_end:g}h"
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
        # Reusing TestResult's observed/expected fields for near/far rather
        # than adding a parallel response shape: `observed` is the
        # near-hemisphere count, `expected` the far-hemisphere count (not a
        # Poisson expectation, which this test has none of) — spelled out in
        # the caveats below so the JSON is never ambiguous on its own.
        tests.append(
            TestResult(
                id=test_id,
                trigger_id=TRIGGER_ID,
                lag_hours=lag,
                observed=observed_stat.near,
                observed_label="Near",
                expected=float(observed_stat.far),
                expected_label="Far",
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
        "\"Observed\" is the near-hemisphere (sun-facing at arrival) event "
        "count and \"expected\" is the far-hemisphere count for this "
        "hypothesis — there is no Poisson baseline here, unlike H4c/H3b; "
        "the ratio is near/far, tested against a null built by permuting "
        "arrival instants.",
        f"{declustered_count} declustered M5.0+ events since 2014, against "
        f"{int(trigger_times.shape[0])} direct-impact CME arrivals — glancing "
        "blows and minor impacts are excluded by registration (HYPOTHESES.md "
        "H2b), not filtered after seeing results.",
        "WSA-ENLIL arrival-time coverage has not been independently verified "
        "the way the flare record was against GOES (HYPOTHESES.md H2b) — the "
        "2014 start is inherited by analogy, the weakest claim in this "
        "hypothesis's own registration.",
    ]

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
            f"unblocked tests have been run so far ({DEFERRED_TESTS} more deferred "
            f"to Phase 5, {BLOCKED_TESTS} blocked on missing magnetometer data). "
            "Adjusted p-values are provisional until the full matrix is complete."
        ),
    )

    method = MethodInfo(
        null_model=params.null_model,
        tail=params.tail,
        iterations=params.iterations,
        spatial_split_degrees=params.spatial_split_degrees,
    )

    duration_ms = int((time.monotonic() - start_time) * 1000)

    return AnalysisResult(
        contract_version=request.contract_version,
        engine_version=ENGINE_VERSION,
        hypothesis_id="H2b",
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
