import numpy as np

from terra_pulse_engine.api.contracts import LagWindowRunRequest
from terra_pulse_engine.hypotheses.h3b import EFFECTIVE_START_MS, run_h3b

HOUR_MS = 60 * 60 * 1000
DAY_MS = 24 * HOUR_MS


def _synthetic_request(*, iterations: int = 50) -> LagWindowRunRequest:
    """Same shape as test_h4c.py's synthetic request — a small, fast, fully
    synthetic dataset exercising every code path without the cost of the
    real ~90k-row catalogue. Wind speed instead of Kp/Dst, and streams
    (6+ consecutive hours above threshold) instead of single-hour episodes,
    since that's H3b's registered trigger.
    """
    rng = np.random.default_rng(1)

    n_hours = 5 * 365 * 24
    time_ms = (EFFECTIVE_START_MS + np.arange(n_hours, dtype=np.int64) * HOUR_MS).tolist()

    wind_speed = rng.uniform(300, 450, size=n_hours)
    kp = rng.uniform(0, 3, size=n_hours)
    dst = rng.uniform(-30, 10, size=n_hours)

    stream_hours = [10_000, 20_000, 30_000, 40_000]
    for h in stream_hours:
        wind_speed[h : h + 8] = 650.0  # 8 consecutive hours above the 500 km/s threshold

    n_background = 400
    background_times = np.sort(rng.integers(0, n_hours * HOUR_MS, size=n_background))

    excess_times = []
    for h in stream_hours:
        stream_ms = EFFECTIVE_START_MS + h * HOUR_MS
        excess_times.extend(stream_ms + rng.integers(1, 20 * HOUR_MS, size=15))
    excess_times = np.array(excess_times, dtype=np.int64)

    all_times = np.sort(np.concatenate([background_times, excess_times]))
    n_events = all_times.shape[0]
    latitude = rng.uniform(-60, 60, size=n_events)
    longitude = rng.uniform(-180, 180, size=n_events)
    magnitude = rng.uniform(5.0, 6.5, size=n_events)

    payload = {
        "contractVersion": 1,
        "hypothesisId": "H3b",
        "parameters": {
            "targetMinMagnitude": 5.0,
            "triggers": [
                {
                    "id": "wind>500",
                    "series": "wind_speed",
                    "comparison": ">=",
                    "threshold": 500,
                    "minConsecutiveHours": 6,
                },
            ],
            "lagWindowsHours": [[0, 24], [24, 48], [48, 72], [72, 120]],
            "declustering": "gardner-knopoff",
            "baselineWindowDays": 365.25,
            "nullModel": "uniform-redraw",
            "tail": "upper",
            "iterations": iterations,
            "seed": 20260819,
            "q": 0.05,
            "requestedStartUtc": "1995-01-01T00:00:00.000Z",
            "registeredMatrixTests": 19,
        },
        "catalog": {
            "timeMs": all_times.tolist(),
            "latitude": latitude.tolist(),
            "longitude": longitude.tolist(),
            "magnitude": magnitude.tolist(),
        },
        "series": {
            "timeMs": time_ms,
            "kp": kp.tolist(),
            "dst": dst.tolist(),
            "windSpeed": wind_speed.tolist(),
        },
    }
    return LagWindowRunRequest.model_validate(payload)


def test_run_h3b_produces_four_tests() -> None:
    request = _synthetic_request()
    result = run_h3b(request)

    assert len(result.tests) == 4  # 1 trigger x 4 lag windows
    assert result.hypothesis_id == "H3b"
    assert result.catalog.declustering == "gardner-knopoff"


def test_planted_streams_produce_the_expected_onset_count() -> None:
    request = _synthetic_request()
    result = run_h3b(request)

    assert result.triggers[0].id == "wind>500"
    assert result.triggers[0].count == 4


def test_span_is_not_truncated_unlike_h4c() -> None:
    request = _synthetic_request()
    result = run_h3b(request)

    assert result.span.requested_start_utc == "1995-01-01T00:00:00.000Z"
    assert result.span.used_start_utc == "1995-01-01T00:00:00.000Z"
    assert result.span.truncation_reason is None


def test_caveats_mention_the_missing_wind_bias() -> None:
    request = _synthetic_request()
    result = run_h3b(request)

    assert any("under-samples the strongest streams" in c for c in result.caveats)


def test_correction_reports_the_partial_matrix_honestly() -> None:
    request = _synthetic_request()
    result = run_h3b(request)

    assert result.correction.tests_run == 4
    assert result.correction.registered_matrix_tests == 19
    for test in result.tests:
        assert test.p_adjusted_full_matrix >= test.p_adjusted_within_run - 1e-9


def test_deterministic_given_the_same_seed() -> None:
    result_a = run_h3b(_synthetic_request())
    result_b = run_h3b(_synthetic_request())

    for test_a, test_b in zip(result_a.tests, result_b.tests):
        assert test_a.p_raw == test_b.p_raw
        assert test_a.observed == test_b.observed


def test_a_five_hour_streak_below_the_six_hour_minimum_does_not_trigger() -> None:
    rng = np.random.default_rng(2)
    n_hours = 1000
    time_ms = (EFFECTIVE_START_MS + np.arange(n_hours, dtype=np.int64) * HOUR_MS).tolist()
    wind_speed = rng.uniform(300, 450, size=n_hours)
    wind_speed[100:105] = 650.0  # only 5 consecutive hours — one short

    payload = {
        "contractVersion": 1,
        "hypothesisId": "H3b",
        "parameters": {
            "targetMinMagnitude": 5.0,
            "triggers": [
                {
                    "id": "wind>500",
                    "series": "wind_speed",
                    "comparison": ">=",
                    "threshold": 500,
                    "minConsecutiveHours": 6,
                }
            ],
            "lagWindowsHours": [[0, 24]],
            "declustering": "gardner-knopoff",
            "baselineWindowDays": 365.25,
            "nullModel": "uniform-redraw",
            "tail": "upper",
            "iterations": 10,
            "seed": 1,
            "q": 0.05,
            "requestedStartUtc": "1995-01-01T00:00:00.000Z",
            "registeredMatrixTests": 19,
        },
        "catalog": {"timeMs": [], "latitude": [], "longitude": [], "magnitude": []},
        "series": {
            "timeMs": time_ms,
            "kp": [None] * n_hours,
            "dst": [None] * n_hours,
            "windSpeed": wind_speed.tolist(),
        },
    }
    request = LagWindowRunRequest.model_validate(payload)
    result = run_h3b(request)

    assert result.triggers[0].count == 0
