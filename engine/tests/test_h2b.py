import numpy as np

from terra_pulse_engine.api.contracts import HemisphereRunRequest
from terra_pulse_engine.hypotheses.h2b import EFFECTIVE_START_MS, run_h2b
from terra_pulse_engine.pipeline.subsolar import subsolar_longitude_deg

HOUR_MS = 60 * 60 * 1000
DAY_MS = 24 * HOUR_MS
YEAR_MS = 365 * DAY_MS


def _synthetic_request(*, iterations: int = 50) -> HemisphereRunRequest:
    """A small, fast, fully synthetic dataset: a handful of direct-impact CME
    arrivals, with a planted excess of target events at longitudes near the
    real subsolar longitude at each arrival (computed for real, not guessed,
    so the "near" classification in the assembled request is genuine) and a
    uniform-longitude background.
    """
    rng = np.random.default_rng(3)

    trigger_times = EFFECTIVE_START_MS + np.array(
        [10, 100, 200, 300, 400, 500, 600, 700], dtype=np.int64
    ) * DAY_MS

    n_background = 500
    background_times = np.sort(
        rng.integers(EFFECTIVE_START_MS, EFFECTIVE_START_MS + 800 * DAY_MS, size=n_background)
    )
    background_lon = rng.uniform(-180, 180, size=n_background)

    excess_times = []
    excess_lon = []
    for t in trigger_times:
        subsolar_lon = float(subsolar_longitude_deg(float(t)))
        # Spread across 1-44h so both registered lag windows (0-24h, 24-48h)
        # see the planted excess, not just the first.
        for _ in range(20):
            excess_times.append(int(t) + int(rng.integers(1 * HOUR_MS, 44 * HOUR_MS)))
            # Planted within +/-30 degrees of the real subsolar longitude —
            # comfortably inside the registered +/-90 degree near band.
            excess_lon.append(subsolar_lon + rng.uniform(-30, 30))

    all_times = np.concatenate([background_times, np.array(excess_times, dtype=np.int64)])
    all_lon = np.concatenate([background_lon, np.array(excess_lon)])
    order = np.argsort(all_times)
    all_times = all_times[order]
    all_lon = np.mod(all_lon[order] + 180.0, 360.0) - 180.0

    n_events = all_times.shape[0]
    latitude = rng.uniform(-60, 60, size=n_events)
    magnitude = rng.uniform(5.0, 6.5, size=n_events)

    payload = {
        "contractVersion": 1,
        "hypothesisId": "H2b",
        "parameters": {
            "targetMinMagnitude": 5.0,
            "spatialSplitDegrees": 90,
            "lagWindowsHours": [[0, 24], [24, 48]],
            "declustering": "gardner-knopoff",
            "nullModel": "uniform-redraw",
            "tail": "upper",
            "iterations": iterations,
            "seed": 2026081901,
            "q": 0.05,
            "requestedStartUtc": "2014-01-01T00:00:00.000Z",
            "registeredMatrixTests": 19,
        },
        "catalog": {
            "timeMs": all_times.tolist(),
            "latitude": latitude.tolist(),
            "longitude": all_lon.tolist(),
            "magnitude": magnitude.tolist(),
        },
        "cmeArrivalTimesMs": trigger_times.tolist(),
    }
    return HemisphereRunRequest.model_validate(payload)


def test_run_h2b_produces_two_tests() -> None:
    request = _synthetic_request()
    result = run_h2b(request)

    assert len(result.tests) == 2  # 1 trigger definition x 2 lag windows
    assert result.hypothesis_id == "H2b"
    assert result.catalog.declustering == "gardner-knopoff"


def test_trigger_count_matches_the_sent_arrivals() -> None:
    request = _synthetic_request()
    result = run_h2b(request)

    assert result.triggers[0].id == "direct-impact"
    assert result.triggers[0].count == 8


def test_planted_near_hemisphere_excess_produces_a_ratio_above_one() -> None:
    request = _synthetic_request()
    result = run_h2b(request)

    for test in result.tests:
        assert test.ratio > 1.0
        assert test.observed > test.expected  # near count > far count


def test_span_is_not_truncated() -> None:
    request = _synthetic_request()
    result = run_h2b(request)

    assert result.span.requested_start_utc == "2014-01-01T00:00:00.000Z"
    assert result.span.used_start_utc == "2014-01-01T00:00:00.000Z"
    assert result.span.truncation_reason is None


def test_method_reports_spatial_split_and_no_baseline_window() -> None:
    request = _synthetic_request()
    result = run_h2b(request)

    assert result.method.spatial_split_degrees == 90
    assert result.method.baseline_window_days is None


def test_correction_reports_the_partial_matrix_honestly() -> None:
    request = _synthetic_request()
    result = run_h2b(request)

    assert result.correction.tests_run == 2
    assert result.correction.registered_matrix_tests == 19
    for test in result.tests:
        assert test.p_adjusted_full_matrix >= test.p_adjusted_within_run - 1e-9


def test_deterministic_given_the_same_seed() -> None:
    result_a = run_h2b(_synthetic_request())
    result_b = run_h2b(_synthetic_request())

    for test_a, test_b in zip(result_a.tests, result_b.tests):
        assert test_a.p_raw == test_b.p_raw
        assert test_a.observed == test_b.observed


def test_no_triggers_gives_zero_counts_not_a_crash() -> None:
    payload = {
        "contractVersion": 1,
        "hypothesisId": "H2b",
        "parameters": {
            "targetMinMagnitude": 5.0,
            "spatialSplitDegrees": 90,
            "lagWindowsHours": [[0, 24]],
            "declustering": "gardner-knopoff",
            "nullModel": "uniform-redraw",
            "tail": "upper",
            "iterations": 10,
            "seed": 1,
            "q": 0.05,
            "requestedStartUtc": "2014-01-01T00:00:00.000Z",
            "registeredMatrixTests": 19,
        },
        "catalog": {"timeMs": [], "latitude": [], "longitude": [], "magnitude": []},
        "cmeArrivalTimesMs": [],
    }
    request = HemisphereRunRequest.model_validate(payload)
    result = run_h2b(request)

    assert result.triggers[0].count == 0
    assert result.tests[0].observed == 0
