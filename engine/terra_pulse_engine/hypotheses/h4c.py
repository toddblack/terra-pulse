"""H4c — global geomagnetic disturbance (GFZ Kp / OMNI2 Dst) vs. declustered
global M5.0+ seismicity rate. Assembly only: every actual statistic lives in
pipeline/*; this module wires them together for exactly the parameters
HYPOTHESES.md registers for H4c (including the five completed 2026-08-18 —
episode definition, baseline window, null model, tail, effective span).
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

import numpy as np

from terra_pulse_engine.api.contracts import (
    AnalysisResult,
    AnalysisRunRequest,
    CatalogInfo,
    CorrectionInfo,
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
from terra_pulse_engine.pipeline.triggers import extract_threshold_episodes
from terra_pulse_engine.version import ENGINE_VERSION

# HYPOTHESES.md H4c, "Effective span" (completed 2026-08-18): the M5.0+
# target catalogue is only global-complete from 1970-01-01, which is exactly
# unix epoch 0 — the registered 1963 start reflects only when Kp and Dst both
# exist, not when the target catalogue does.
EFFECTIVE_START_MS = 0

# HYPOTHESES.md "Total Test Matrix": 19 unblocked registered tests
# (H1b 4 + H2b 2 + H3b 4 + H4c 6 + H4b 2 + H5 1); H6's 2 stay deferred to
# Phase 5; H4b's 2 stay blocked — no magnetometer table exists yet.
DEFERRED_TESTS = 2
BLOCKED_TESTS = 2


def _iso(ms: int) -> str:
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _build_hourly_grid(
    time_ms: list[int], values: list[float | None], start_ms: int, end_ms: int
) -> tuple[np.ndarray, np.ndarray]:
    """Regularizes a (possibly gappy) input series onto a complete,
    contiguous 1-hour grid over [start_ms, end_ms], NaN wherever the input
    didn't supply an hour. pipeline.triggers requires this shape: a missing
    row and an explicit null value must look identical to it, since both
    mean "not measured".
    """
    n_hours = max(int((end_ms - start_ms) // HOUR_MS) + 1, 0)
    grid_time = start_ms + np.arange(n_hours, dtype=np.int64) * HOUR_MS
    grid_values = np.full(n_hours, np.nan, dtype=float)
    if n_hours == 0 or len(time_ms) == 0:
        return grid_time, grid_values

    input_time = np.asarray(time_ms, dtype=np.int64)
    input_values = np.array([v if v is not None else np.nan for v in values], dtype=float)
    positions = (input_time - start_ms) // HOUR_MS
    in_range = (positions >= 0) & (positions < n_hours)
    grid_values[positions[in_range]] = input_values[in_range]

    return grid_time, grid_values


def run_h4c(request: AnalysisRunRequest) -> AnalysisResult:
    start_time = time.monotonic()
    params = request.parameters

    catalog_time = np.asarray(request.catalog.time_ms, dtype=np.int64)
    catalog_lat = np.asarray(request.catalog.latitude, dtype=float)
    catalog_lon = np.asarray(request.catalog.longitude, dtype=float)
    catalog_mag = np.asarray(request.catalog.magnitude, dtype=float)

    # Decluster over everything sent (a late pre-1970 mainshock can still
    # correctly claim early-1970 aftershocks), but only *report* and *use*
    # the effective-span subset — the deep archive tier holds M7.5+ back to
    # 1900, and letting a handful of those leak into the target set here
    # would bias the baseline near the 1970 boundary with data from an era
    # that wasn't observed at this floor at all. See EFFECTIVE_START_MS.
    independent_mask = decluster_gardner_knopoff(catalog_time, catalog_lat, catalog_lon, catalog_mag)
    target_time_all = np.sort(catalog_time[independent_mask])
    target_time = target_time_all[target_time_all >= EFFECTIVE_START_MS]

    raw_count = int(np.sum(catalog_time >= EFFECTIVE_START_MS))
    declustered_count = int(target_time.shape[0])

    series_time = list(request.series.time_ms)
    span_end_ms = series_time[-1] if series_time else EFFECTIVE_START_MS
    grid_time, kp_grid = _build_hourly_grid(
        series_time, request.series.kp, EFFECTIVE_START_MS, span_end_ms
    )
    _, dst_grid = _build_hourly_grid(
        series_time, request.series.dst, EFFECTIVE_START_MS, span_end_ms
    )

    half_width_days = params.baseline_window_days / 2.0

    episodes_by_trigger = {}
    for trigger_params in params.triggers:
        series_values = kp_grid if trigger_params.series == "kp" else dst_grid
        episodes_by_trigger[trigger_params.id] = extract_threshold_episodes(
            grid_time,
            series_values,
            threshold=trigger_params.threshold,
            comparison=trigger_params.comparison,
            min_consecutive_hours=trigger_params.min_consecutive_hours,
        )

    raw_p_values: list[float] = []
    test_ids: list[tuple[str, str, tuple[float, float]]] = []
    test_payload: dict[str, dict] = {}

    for trigger_params in params.triggers:
        episodes = episodes_by_trigger[trigger_params.id]
        trigger_times = episodes.onset_ms
        eligible_times = grid_time[episodes.eligible_mask]

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

            null_model = UniformRedraw(eligible_times, trigger_times.shape[0])

            def statistic_fn(
                drawn: np.ndarray, _lag_start: float = lag_start, _lag_end: float = lag_end
            ) -> np.ndarray:
                # Not vectorized across the batch dimension — one draw at a
                # time is simplest to verify correct, and measured cost at
                # real data volumes (seconds per test) is well inside the
                # single-POST budget this round chose over a progress/cancel
                # API. Vectorizing this loop is the first place to look if a
                # later hypothesis needs it faster.
                results = np.empty(drawn.shape[0], dtype=float)
                for row in range(drawn.shape[0]):
                    drawn_times = drawn[row]
                    rate = local_rate_per_hour(
                        target_time,
                        drawn_times,
                        half_width_days=half_width_days,
                        span_start_ms=EFFECTIVE_START_MS,
                        span_end_ms=span_end_ms,
                    )
                    stat = lag_window_statistic(
                        target_time,
                        drawn_times,
                        rate,
                        lag_start_hours=_lag_start,
                        lag_end_hours=_lag_end,
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

            test_id = f"H4c/{trigger_params.id}/{lag_start:g}-{lag_end:g}h"
            raw_p_values.append(permutation.p_value)
            test_ids.append((test_id, trigger_params.id, (lag_start, lag_end)))
            test_payload[test_id] = {"observed": observed_stat, "permutation": permutation}

    bh_within_run = benjamini_hochberg(np.array(raw_p_values), params.q)
    bh_full_matrix = benjamini_hochberg(
        np.array(raw_p_values), params.q, family_size=params.registered_matrix_tests
    )

    tests: list[TestResult] = []
    for i, (test_id, trigger_id, lag) in enumerate(test_ids):
        observed_stat = test_payload[test_id]["observed"]
        permutation = test_payload[test_id]["permutation"]
        tests.append(
            TestResult(
                id=test_id,
                trigger_id=trigger_id,
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

    trigger_infos = [
        TriggerInfo(
            id=trigger_params.id,
            count=int(episodes_by_trigger[trigger_params.id].onset_ms.shape[0]),
            eligible_hours=int(episodes_by_trigger[trigger_params.id].eligible_mask.sum()),
        )
        for trigger_params in params.triggers
    ]

    span = SpanInfo(
        requested_start_utc=params.requested_start_utc,
        used_start_utc=_iso(EFFECTIVE_START_MS),
        used_end_utc=_iso(int(span_end_ms)),
        truncation_reason=(
            "the M5.0+ target catalogue is only global-complete from 1970-01-01; "
            "the geomagnetic indices reach further back but were truncated to match"
        ),
    )

    caveats = [
        "Span truncated to the catalogue's 1970-01-01 completeness bound; the "
        "registered 1963 start reflects only geomagnetic-index availability.",
        "M5.0+ event counts rose approximately 36% from the 1970s to the 2010s; "
        f"the moving local baseline (±{half_width_days:.1f} days) is the "
        "registered mitigation, not a removal of that trend.",
        "Kp>=6 and Dst<=-100 episodes overlap substantially in time, so the six "
        "tests in this family are positively correlated rather than independent; "
        "Benjamini-Hochberg remains valid under this, but the correlation is not "
        "zero.",
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
        baseline_window_days=params.baseline_window_days,
        iterations=params.iterations,
    )

    duration_ms = int((time.monotonic() - start_time) * 1000)

    return AnalysisResult(
        contract_version=request.contract_version,
        engine_version=ENGINE_VERSION,
        hypothesis_id="H4c",
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
        triggers=trigger_infos,
        tests=tests,
        correction=correction,
        method=method,
        caveats=caveats,
    )
