import numpy as np

from terra_pulse_engine.api.contracts import LagWindowRunRequest
from terra_pulse_engine.hypotheses.h4c import EFFECTIVE_START_MS, run_h4c

HOUR_MS = 60 * 60 * 1000
DAY_MS = 24 * HOUR_MS
YEAR_MS = 365 * DAY_MS


def _synthetic_request(*, iterations: int = 50) -> LagWindowRunRequest:
    """A small, fast, fully synthetic dataset: 5 years of hourly Kp/Dst with
    a handful of planted storms, and a target catalogue with more events
    shortly after each storm than the quiet background rate would predict —
    enough to exercise every code path without the cost of the real 92k-row
    catalogue.
    """
    rng = np.random.default_rng(0)

    n_hours = 5 * 365 * 24
    time_ms = (EFFECTIVE_START_MS + np.arange(n_hours, dtype=np.int64) * HOUR_MS).tolist()

    kp = rng.uniform(0, 3, size=n_hours)
    dst = rng.uniform(-30, 10, size=n_hours)
    # H4c doesn't use wind speed, but the request contract always carries it
    # (querySpaceWeather returns all three series together) — a plausible
    # quiet-to-moderate series is enough here.
    wind_speed = rng.uniform(300, 450, size=n_hours)

    storm_hours = [10_000, 20_000, 30_000, 40_000]
    for h in storm_hours:
        kp[h : h + 2] = 7.0
        dst[h : h + 2] = -150.0

    # Background catalogue: sparse random M5.0+ events over the same span.
    n_background = 400
    background_times = np.sort(rng.integers(0, n_hours * HOUR_MS, size=n_background))

    # Planted excess shortly after each storm.
    excess_times = []
    for h in storm_hours:
        storm_ms = EFFECTIVE_START_MS + h * HOUR_MS
        excess_times.extend(storm_ms + rng.integers(1, 20 * HOUR_MS, size=15))
    excess_times = np.array(excess_times, dtype=np.int64)

    all_times = np.sort(np.concatenate([background_times, excess_times]))
    n_events = all_times.shape[0]
    latitude = rng.uniform(-60, 60, size=n_events)
    longitude = rng.uniform(-180, 180, size=n_events)
    magnitude = rng.uniform(5.0, 6.5, size=n_events)

    payload = {
        "contractVersion": 1,
        "hypothesisId": "H4c",
        "parameters": {
            "targetMinMagnitude": 5.0,
            "triggers": [
                {
                    "id": "kp>=6",
                    "series": "kp",
                    "comparison": ">=",
                    "threshold": 6,
                    "minConsecutiveHours": 1,
                },
                {
                    "id": "dst<=-100",
                    "series": "dst",
                    "comparison": "<=",
                    "threshold": -100,
                    "minConsecutiveHours": 1,
                },
            ],
            "lagWindowsHours": [[0, 24], [24, 48], [48, 72]],
            "declustering": "gardner-knopoff",
            "baselineWindowDays": 365.25,
            "nullModel": "uniform-redraw",
            "tail": "upper",
            "iterations": iterations,
            "seed": 20260818,
            "q": 0.05,
            "requestedStartUtc": "1963-01-01T00:00:00.000Z",
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


def test_run_h4c_produces_six_tests() -> None:
    request = _synthetic_request()
    result = run_h4c(request)

    assert len(result.tests) == 6  # 2 triggers x 3 lag windows
    assert result.hypothesis_id == "H4c"
    assert result.catalog.declustering == "gardner-knopoff"
    assert result.catalog.raw_count >= result.catalog.declustered_count


def test_planted_storms_produce_nonzero_trigger_counts() -> None:
    request = _synthetic_request()
    result = run_h4c(request)

    trigger_counts = {t.id: t.count for t in result.triggers}
    assert trigger_counts["kp>=6"] == 4
    assert trigger_counts["dst<=-100"] == 4


def test_correction_reports_the_partial_matrix_honestly() -> None:
    request = _synthetic_request()
    result = run_h4c(request)

    assert result.correction.tests_run == 6
    assert result.correction.registered_matrix_tests == 19
    assert result.correction.deferred_tests == 2
    assert result.correction.blocked_tests == 2
    assert result.correction.partial_matrix is True
    # The full-matrix adjustment must never be more significant than the
    # within-run one.
    for test in result.tests:
        assert test.p_adjusted_full_matrix >= test.p_adjusted_within_run - 1e-9


def test_span_is_truncated_to_1970_and_says_so() -> None:
    request = _synthetic_request()
    result = run_h4c(request)

    assert result.span.requested_start_utc == "1963-01-01T00:00:00.000Z"
    assert result.span.used_start_utc == "1970-01-01T00:00:00.000Z"
    assert "1970" in result.span.truncation_reason


def test_p_values_are_never_exactly_zero() -> None:
    request = _synthetic_request()
    result = run_h4c(request)

    for test in result.tests:
        assert test.p_raw > 0.0


def test_deterministic_given_the_same_seed() -> None:
    request_a = _synthetic_request()
    request_b = _synthetic_request()

    result_a = run_h4c(request_a)
    result_b = run_h4c(request_b)

    for test_a, test_b in zip(result_a.tests, result_b.tests):
        assert test_a.p_raw == test_b.p_raw
        assert test_a.observed == test_b.observed
