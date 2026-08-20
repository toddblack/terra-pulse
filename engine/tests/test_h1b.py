import numpy as np
import pytest

from terra_pulse_engine.api.contracts import DiscreteTriggerRunRequest
from terra_pulse_engine.hypotheses.h1b import EFFECTIVE_START_MS, TRIGGER_ID, run_h1b
from terra_pulse_engine.pipeline.baseline import HOUR_MS, local_rate_per_hour
from terra_pulse_engine.pipeline.lag_windows import lag_window_statistic

DAY_MS = 24 * HOUR_MS


def _payload(
    *,
    iterations: int = 50,
    plant_excess: bool = False,
    coverage_complete: bool = True,
    seed: int = 7,
) -> dict:
    """A small synthetic dataset exercising every path without the cost of the
    real ~4,600-trigger run. Flares as discrete instants, not a thresholded
    series — H1b's whole structural difference from H4c/H3b.
    """
    rng = np.random.default_rng(1)

    n_hours = 5 * 365 * 24
    span_ms = n_hours * HOUR_MS

    # Flares cluster in active regions, so the fixture clusters them too —
    # that is what makes the overlapping-window arithmetic worth testing.
    flare_times: list[int] = []
    for cluster_start in range(2_000, n_hours - 2_000, 6_000):
        flare_times.extend(
            EFFECTIVE_START_MS + (cluster_start + rng.integers(0, 72, size=6)) * HOUR_MS
        )
    flare_times_ms = np.sort(np.array(flare_times, dtype=np.int64))

    background = np.sort(rng.integers(0, span_ms, size=600)) + EFFECTIVE_START_MS

    times = background
    if plant_excess:
        planted: list[int] = []
        for flare in flare_times_ms[::4]:
            planted.extend(flare + rng.integers(1, 20 * HOUR_MS, size=12))
        times = np.sort(np.concatenate([background, np.array(planted, dtype=np.int64)]))

    n = times.shape[0]
    return {
        "contractVersion": 1,
        "hypothesisId": "H1b",
        "parameters": {
            "targetMinMagnitude": 5.0,
            "lagWindowsHours": [[0, 24], [24, 48], [48, 72], [72, 168]],
            "declustering": "gardner-knopoff",
            "baselineWindowDays": 365.25,
            "nullModel": "uniform-redraw",
            "tail": "upper",
            "iterations": iterations,
            "seed": seed,
            "q": 0.05,
            "requestedStartUtc": "1996-01-01T00:00:00.000Z",
            "registeredMatrixTests": 19,
        },
        "catalog": {
            "timeMs": times.tolist(),
            "latitude": rng.uniform(-60, 60, size=n).tolist(),
            "longitude": rng.uniform(-180, 180, size=n).tolist(),
            "magnitude": rng.uniform(5.0, 6.5, size=n).tolist(),
        },
        "flarePeakTimesMs": flare_times_ms.tolist(),
        "flareCoverageComplete": coverage_complete,
    }


def _request(**kwargs) -> DiscreteTriggerRunRequest:
    return DiscreteTriggerRunRequest.model_validate(_payload(**kwargs))


def test_runs_and_reports_the_registered_shape():
    result = run_h1b(_request())

    assert result.hypothesis_id == "H1b"
    # Four registered lag windows, one trigger definition.
    assert len(result.tests) == 4
    assert [t.lag_hours for t in result.tests] == [(0, 24), (24, 48), (48, 72), (72, 168)]
    assert all(t.trigger_id == TRIGGER_ID for t in result.tests)
    assert result.triggers[0].id == TRIGGER_ID
    assert result.method.baseline_window_days == 365.25
    # H1b has a Poisson baseline, unlike H2b — so no spatial split.
    assert result.method.spatial_split_degrees is None


def test_span_is_not_truncated():
    # Unlike H4c, 1996 already sits inside the catalogue's completeness window,
    # so there is nothing to truncate and no reason to claim there is.
    result = run_h1b(_request())

    assert result.span.truncation_reason is None
    assert result.span.used_start_utc.startswith("1996-01-01")


def test_triggers_before_the_registered_start_are_dropped():
    payload = _payload()
    early = EFFECTIVE_START_MS - 30 * DAY_MS
    payload["flarePeakTimesMs"] = [early, *payload["flarePeakTimesMs"]]

    kept = run_h1b(DiscreteTriggerRunRequest.model_validate(payload)).triggers[0].count
    baseline = run_h1b(_request()).triggers[0].count

    assert kept == baseline


def test_is_deterministic_for_a_fixed_seed():
    first = run_h1b(_request())
    second = run_h1b(_request())

    assert [t.p_raw for t in first.tests] == [t.p_raw for t in second.tests]
    assert [t.ratio for t in first.tests] == [t.ratio for t in second.tests]


def test_detects_a_planted_excess():
    # The test has to be able to find something, or a null result says nothing.
    plain = run_h1b(_request(iterations=200))
    planted = run_h1b(_request(iterations=200, plant_excess=True))

    assert planted.tests[0].ratio > plain.tests[0].ratio
    assert planted.tests[0].p_raw < plain.tests[0].p_raw


def test_incomplete_coverage_is_reported_first_and_loudly():
    complete = run_h1b(_request())
    partial = run_h1b(_request(coverage_complete=False))

    assert not any("INCOMPLETE" in c for c in complete.caveats)
    # First, because it changes what every other number in the result means.
    assert partial.caveats[0].startswith("INCOMPLETE TRIGGER SET")
    assert len(partial.caveats) == len(complete.caveats) + 1


def test_empty_trigger_set_does_not_crash():
    payload = _payload()
    payload["flarePeakTimesMs"] = []

    result = run_h1b(DiscreteTriggerRunRequest.model_validate(payload))

    assert result.triggers[0].count == 0
    assert len(result.tests) == 4


def test_precomputed_null_lookup_matches_the_per_row_reference():
    """The correctness oracle for h1b.py's precomputed null lookup.

    h4c.py and h3b.py compute the null one drawn row at a time, re-running
    four binary searches per drawn trigger per iteration. h1b.py instead
    evaluates the baseline rate and the lag-window count once per *eligible
    hour* and reads them by index, because both are pure functions of the
    trigger instant and the null draws from a fixed hourly pool.

    That is an optimization — measured 102s down to a few seconds on the real
    catalogue — so it has to be shown to agree with the obvious implementation
    rather than assumed to. Exact equality is the bar here, not closeness:
    the lookup evaluates the very same functions, just at fewer points.
    """
    rng = np.random.default_rng(3)
    span_start = int(EFFECTIVE_START_MS)
    span_end = int(EFFECTIVE_START_MS + 400 * DAY_MS)

    target = np.sort(rng.integers(span_start, span_end, size=900).astype(np.int64))
    eligible = np.arange(span_start, span_end, HOUR_MS, dtype=np.int64)
    # Draw from the pool the way UniformRedraw does, so the drawn instants
    # really do land on the hourly grid.
    drawn = eligible[rng.integers(0, eligible.shape[0], size=(16, 40))]

    half_width_days = 365.25 / 2.0
    lag_start, lag_end = 24.0, 48.0

    # The straightforward, obviously-correct version: one row at a time,
    # through the same pipeline functions h4c.py uses.
    reference = np.empty(drawn.shape[0], dtype=float)
    for row in range(drawn.shape[0]):
        row_times = drawn[row]
        rate = local_rate_per_hour(
            target,
            row_times,
            half_width_days=half_width_days,
            span_start_ms=span_start,
            span_end_ms=span_end,
        )
        stat = lag_window_statistic(
            target, row_times, rate, lag_start_hours=lag_start, lag_end_hours=lag_end
        )
        reference[row] = stat.ratio if not np.isnan(stat.ratio) else 0.0

    # The lookup version, exactly as h1b.py computes it.
    rate_by_hour = local_rate_per_hour(
        target,
        eligible,
        half_width_days=half_width_days,
        span_start_ms=span_start,
        span_end_ms=span_end,
    )
    lo = np.searchsorted(target, eligible + lag_start * HOUR_MS, side="left")
    hi = np.searchsorted(target, eligible + lag_end * HOUR_MS, side="left")
    counts_by_hour = (hi - lo).astype(float)
    expected_by_hour = rate_by_hour * (lag_end - lag_start)

    index = (drawn - span_start) // HOUR_MS
    observed = counts_by_hour[index].sum(axis=1)
    expected = expected_by_hour[index].sum(axis=1)
    looked_up = np.where(expected > 0, observed / np.where(expected > 0, expected, 1.0), 0.0)

    assert np.array_equal(looked_up, reference)


def test_index_arithmetic_recovers_the_pool_exactly():
    """The lookup rests on a drawn instant mapping back to its pool index by
    integer arithmetic rather than a search. That holds only because the pool
    is a uniform hourly arange — worth pinning, since a future change to how
    the eligible pool is built would break it silently and produce plausible
    wrong numbers rather than an error."""
    span_start = int(EFFECTIVE_START_MS)
    eligible = np.arange(span_start, span_start + 5000 * HOUR_MS, HOUR_MS, dtype=np.int64)

    index = (eligible - span_start) // HOUR_MS

    assert np.array_equal(index, np.arange(eligible.shape[0]))
    assert np.array_equal(eligible[index], eligible)


def test_rejects_a_request_carrying_a_series():
    """H1b has no series, and the contract must refuse one rather than
    accept-and-ignore it — the failure mode the split request families exist
    to prevent."""
    payload = _payload()
    payload["series"] = {"timeMs": [], "kp": [], "dst": [], "windSpeed": []}

    with pytest.raises(Exception):
        DiscreteTriggerRunRequest.model_validate(payload)


def test_requires_the_completed_registration_parameters():
    for field in ("baselineWindowDays", "nullModel", "tail"):
        payload = _payload()
        del payload["parameters"][field]
        with pytest.raises(Exception):
            DiscreteTriggerRunRequest.model_validate(payload)
