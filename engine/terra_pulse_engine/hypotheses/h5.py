"""H5 — antipodal triggering. Declustered M6.0+ mainshocks vs. the distribution
of distance-to-antipode for declustered M5.0+ events in the following 0-72h.

Assembly only, like the other four, but the statistic is genuinely different:
a one-sided Kolmogorov-Smirnov D-plus on a distance distribution, not a rate
ratio over lag windows. `pipeline/ks.py` holds the statistic.

## How the completeness requirement is met

H5 registers "Completeness correction: Mandatory" and was blocked for weeks on
a magnitude-of-completeness map. The registered null makes that map
unnecessary rather than deferred, and the reason is worth stating where the
code is:

The null redraws **trigger instants** only. Every target event stays exactly
where the catalogue recorded it, and every trigger's antipode stays exactly
where it is. So the observed and null distance distributions are built from the
same real, instrument-biased set of detections, and detection bias cancels
instead of needing to be estimated. A region the network cannot see contributes
nothing to either side, for the same reason.

That is stricter than weighting by an estimated Mc, not looser: an Mc map would
add several free parameters (grid size, estimator, minimum events per cell) to
approximate what the shuffle conditions on exactly. See HYPOTHESES.md H5.

## The reference CDF is exact, not sampled

Under a uniform time redraw a target is equally likely to land in any trigger's
window, so the null distance distribution is the all-pairs distribution over
(trigger antipode, target) — computable once in closed form rather than
estimated from the draws. `reference_cdf_all_pairs` accumulates it as a
histogram; the permutation loop then only ever measures deviation *from* it.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

import numpy as np

from terra_pulse_engine.api.contracts import (
    AnalysisResult,
    AntipodalRunRequest,
    CatalogInfo,
    CorrectionInfo,
    MethodInfo,
    NullHistogram,
    NullInfo,
    SpanInfo,
    TestResult,
    TriggerInfo,
)
from terra_pulse_engine.pipeline.decluster import decluster_gardner_knopoff
from terra_pulse_engine.pipeline.geo import antipode, haversine_km
from terra_pulse_engine.pipeline.ks import (
    bin_distances,
    cdf_from_counts,
    d_plus,
    reference_cdf_all_pairs,
    two_sided_d,
)
from terra_pulse_engine.pipeline.monte_carlo import UniformRedraw, permutation_null
from terra_pulse_engine.pipeline.multiple_comparisons import benjamini_hochberg
from terra_pulse_engine.version import ENGINE_VERSION

HOUR_MS = 60 * 60 * 1000

# HYPOTHESES.md H5, "Time range" (completed 2026-08-20): 1970-01-01, the M5.0+
# catalogue's own global-completeness bound — unix epoch 0, same as H4c's.
EFFECTIVE_START_MS = 0

DEFERRED_TESTS = 2
BLOCKED_TESTS = 2

TRIGGER_ID = "M6.0+ mainshock"

COMPLETENESS_MODEL = (
    "conditioned, not weighted: the null redraws trigger instants only, so "
    "observed and null share the same detected catalogue and detection bias "
    "cancels"
)


def _iso(ms: int) -> str:
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _window_distances(
    trigger_time: np.ndarray,
    trigger_anti_lat: np.ndarray,
    trigger_anti_lon: np.ndarray,
    target_time: np.ndarray,
    target_lat: np.ndarray,
    target_lon: np.ndarray,
    *,
    lag_start_hours: float,
    lag_end_hours: float,
) -> np.ndarray:
    """Distance from each trigger's antipode to every target inside that
    trigger's window, flattened across all triggers.

    Vectorised the way `pipeline/hemisphere.py` had to be after its own
    per-trigger loop tripped the caller's HTTP timeout: one `searchsorted` for
    all window bounds, then `np.repeat` to pair each matched target with the
    trigger that caught it. `target_time` must be sorted ascending.
    """
    if trigger_time.size == 0 or target_time.size == 0:
        return np.empty(0, dtype=float)

    # `side="right"` on the lower bound makes the window *strictly after* the
    # trigger, which is what implements H5's registered self-exclusion: an
    # M6.0+ trigger is itself in the M5.0+ target set, and at lag 0 its own
    # window would catch it — one artefact per trigger, all of them pinned at
    # the antipodal maximum, packing the far tail. The Explore-side
    # `queryAntipodalWindow` starts its window at `originMs + 1` for the same
    # reason, put there as "an event at the same instant on the far side of the
    # planet cannot have been caused by it".
    #
    # The null needs no equivalent exclusion and must not have one: its drawn
    # instants are not real events, so no self-pair exists to remove. Excluding
    # it from the observed side only is what makes the two comparable.
    lo = np.searchsorted(target_time, trigger_time + int(lag_start_hours * HOUR_MS), side="right")
    hi = np.searchsorted(target_time, trigger_time + int(lag_end_hours * HOUR_MS), side="left")
    per_trigger = hi - lo
    total = int(per_trigger.sum())
    if total == 0:
        return np.empty(0, dtype=float)

    # Flatten (trigger, matched target) pairs without a Python loop: repeat each
    # trigger index by how many targets it caught, then build the matching
    # target indices by offsetting a running arange.
    trigger_index = np.repeat(np.arange(trigger_time.shape[0]), per_trigger)
    starts = np.repeat(lo, per_trigger)
    offsets = np.arange(total) - np.repeat(np.cumsum(per_trigger) - per_trigger, per_trigger)
    target_index = starts + offsets

    return haversine_km(
        trigger_anti_lat[trigger_index],
        trigger_anti_lon[trigger_index],
        target_lat[target_index],
        target_lon[target_index],
    )


def run_h5(request: AntipodalRunRequest) -> AnalysisResult:
    start_time = time.monotonic()
    params = request.parameters

    catalog_time = np.asarray(request.catalog.time_ms, dtype=np.int64)
    catalog_lat = np.asarray(request.catalog.latitude, dtype=float)
    catalog_lon = np.asarray(request.catalog.longitude, dtype=float)
    catalog_mag = np.asarray(request.catalog.magnitude, dtype=float)

    # One Gardner-Knopoff pass produces both sets. This is not an optimisation:
    # declustering an M6.0+-only catalogue marks a *different* set of events
    # independent, because a GK window is sized by the claiming event and the
    # M5.x events removed in the full pass change which M6+ events survive.
    independent = decluster_gardner_knopoff(catalog_time, catalog_lat, catalog_lon, catalog_mag)
    in_span = catalog_time >= EFFECTIVE_START_MS

    target_mask = independent & in_span & (catalog_mag >= params.target_min_magnitude)
    trigger_mask = independent & in_span & (catalog_mag >= params.trigger_min_magnitude)

    order = np.argsort(catalog_time[target_mask], kind="stable")
    target_time = catalog_time[target_mask][order]
    target_lat = catalog_lat[target_mask][order]
    target_lon = catalog_lon[target_mask][order]

    # Location has to travel with time through the sort, so this is an explicit
    # argsort rather than a bare np.sort — the same reason h2b.py sorts this way.
    trigger_order = np.argsort(catalog_time[trigger_mask], kind="stable")
    trigger_time = catalog_time[trigger_mask][trigger_order]
    trigger_anti_lat, trigger_anti_lon = antipode(
        catalog_lat[trigger_mask][trigger_order], catalog_lon[trigger_mask][trigger_order]
    )

    raw_count = int(np.sum(in_span & (catalog_mag >= params.target_min_magnitude)))
    declustered_count = int(target_time.shape[0])

    span_end_ms = int(catalog_time[-1]) if catalog_time.size > 0 else EFFECTIVE_START_MS
    eligible_times_ms = np.arange(EFFECTIVE_START_MS, span_end_ms, HOUR_MS, dtype=np.int64)

    lag_start, lag_end = params.window_hours

    # The exact null distance distribution — see the module note.
    reference_cdf = reference_cdf_all_pairs(
        trigger_anti_lat,
        trigger_anti_lon,
        target_lat,
        target_lon,
        bin_km=params.distance_bin_km,
    )

    observed_distances = _window_distances(
        trigger_time,
        trigger_anti_lat,
        trigger_anti_lon,
        target_time,
        target_lat,
        target_lon,
        lag_start_hours=lag_start,
        lag_end_hours=lag_end,
    )
    observed_cdf = cdf_from_counts(bin_distances(observed_distances, bin_km=params.distance_bin_km))

    observed_d_plus = float(d_plus(observed_cdf, reference_cdf))
    observed_two_sided = float(two_sided_d(observed_cdf, reference_cdf))

    null_model = UniformRedraw(eligible_times_ms, trigger_time.shape[0])

    def statistic_fn(drawn: np.ndarray) -> np.ndarray:
        results = np.empty(drawn.shape[0], dtype=float)
        for row in range(drawn.shape[0]):
            drawn_times = np.sort(drawn[row])
            distances = _window_distances(
                drawn_times,
                trigger_anti_lat,
                trigger_anti_lon,
                target_time,
                target_lat,
                target_lon,
                lag_start_hours=lag_start,
                lag_end_hours=lag_end,
            )
            cdf = cdf_from_counts(bin_distances(distances, bin_km=params.distance_bin_km))
            results[row] = d_plus(cdf, reference_cdf)
        return results

    permutation = permutation_null(
        observed_statistic=observed_d_plus,
        draw_fn=null_model.draw,
        statistic_fn=statistic_fn,
        iterations=params.iterations,
        seed=params.seed,
        tail=params.tail,
    )

    # One test in this family — the whole point of the no-fixed-radius design is
    # that there is exactly one, rather than one per radius.
    raw_p_values = np.array([permutation.p_value])
    bh_within_run = benjamini_hochberg(raw_p_values, params.q)
    bh_full_matrix = benjamini_hochberg(
        raw_p_values, params.q, family_size=params.registered_matrix_tests
    )

    test = TestResult(
        id=f"H5/{TRIGGER_ID}/{lag_start:g}-{lag_end:g}h",
        trigger_id=TRIGGER_ID,
        lag_hours=(lag_start, lag_end),
        # `observed` is the number of target events that fell in any trigger's
        # window — the sample the statistic was computed from, not a count being
        # compared against an expectation. `expected` carries the two-sided D,
        # which is descriptive only. Both spelled out in the caveats and in
        # `statistic_label` so the JSON is never ambiguous alone.
        observed=int(observed_distances.shape[0]),
        observed_label="Events in window",
        expected=observed_two_sided,
        expected_label="two-sided D",
        ratio=observed_d_plus,
        statistic_label="KS D⁺",
        p_raw=permutation.p_value,
        p_adjusted_within_run=float(bh_within_run.p_adjusted[0]),
        p_adjusted_full_matrix=float(bh_full_matrix.p_adjusted[0]),
        rejected_at_q=bool(bh_full_matrix.rejected[0]),
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

    caveats = [
        "The statistic is a one-sided Kolmogorov-Smirnov D⁺ — the largest amount "
        "by which the observed distance-to-antipode distribution exceeds the null "
        "at short distances. \"Observed\" is the number of target events in the "
        "windows and \"expected\" is the two-sided D, reported for description "
        "only; neither is a Poisson count, unlike H4c/H3b/H1b.",
        f"{declustered_count} declustered M{params.target_min_magnitude:g}+ targets "
        f"against {int(trigger_time.shape[0])} declustered "
        f"M{params.trigger_min_magnitude:g}+ triggers, all from one "
        "Gardner-Knopoff pass — declustering the trigger floor separately would "
        "mark a different set of events independent.",
        "THIS TEST IS UNDERPOWERED, and that was registered before it ran: 63% of "
        "M6.0+ antipodes have never had an M5.0+ recorded within 250 km, and 36% "
        "none within 500 km, over the whole 1970-onward record. A null result is "
        "therefore partly an absence-of-instruments result and is not evidence "
        "that antipodal triggering does not occur.",
        "Detection bias is handled by conditioning rather than by a "
        "magnitude-of-completeness map: the null redraws only trigger instants, "
        "so observed and null are built from the same detected events and the "
        "bias cancels. See HYPOTHESES.md H5 for why this is stricter than "
        "weighting, not weaker.",
    ]

    # A degenerate run produces D⁺ = 0 and p = 1 — arithmetically correct and
    # indistinguishable from a genuine clean null unless it says so. Both
    # conditions are unreachable on the real catalogue (thousands of M6.0+
    # triggers, tens of thousands of targets); the guard exists so that if one
    # ever is reached, the output cannot be mistaken for a result.
    if trigger_time.shape[0] == 0:
        caveats.insert(
            0,
            "NO TRIGGERS — the catalogue supplied no declustered event at or "
            "above the trigger floor, so there were no windows to examine. The "
            "statistic and p-value below are degenerate, not a null result.",
        )
    elif observed_distances.shape[0] == 0:
        caveats.insert(
            0,
            "NO TARGETS IN ANY WINDOW — every trigger's 0-72h window was empty, "
            "so the observed distribution has no events in it. The statistic and "
            "p-value below are degenerate, not a null result.",
        )

    correction = CorrectionInfo(
        method="benjamini-hochberg",
        q=params.q,
        tests_run=1,
        registered_matrix_tests=params.registered_matrix_tests,
        deferred_tests=DEFERRED_TESTS,
        blocked_tests=BLOCKED_TESTS,
        partial_matrix=1 < params.registered_matrix_tests,
        note=(
            f"1 of {params.registered_matrix_tests} registered, unblocked tests "
            f"was run in this session ({DEFERRED_TESTS} more deferred to Phase 5, "
            f"{BLOCKED_TESTS} blocked on missing magnetometer data). Adjusted "
            "p-values are provisional until the full matrix is complete."
        ),
    )

    return AnalysisResult(
        contract_version=request.contract_version,
        engine_version=ENGINE_VERSION,
        hypothesis_id="H5",
        run_at_utc=_iso(int(time.time() * 1000)),
        duration_ms=int((time.monotonic() - start_time) * 1000),
        seed=params.seed,
        span=SpanInfo(
            requested_start_utc=params.requested_start_utc,
            used_start_utc=_iso(EFFECTIVE_START_MS),
            used_end_utc=_iso(span_end_ms),
            truncation_reason=None,
        ),
        catalog=CatalogInfo(
            min_magnitude=params.target_min_magnitude,
            raw_count=raw_count,
            declustered_count=declustered_count,
            declustering=params.declustering,
        ),
        triggers=[
            TriggerInfo(
                id=TRIGGER_ID,
                count=int(trigger_time.shape[0]),
                eligible_hours=int(eligible_times_ms.shape[0]),
            )
        ],
        tests=[test],
        correction=correction,
        method=MethodInfo(
            null_model=params.null_model,
            tail=params.tail,
            iterations=params.iterations,
            completeness_model=COMPLETENESS_MODEL,
        ),
        caveats=caveats,
    )
