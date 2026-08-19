import math

import numpy as np

from terra_pulse_engine.pipeline.lag_windows import (
    lag_window_statistic,
    observed_counts_per_trigger,
)

HOUR_MS = 60 * 60 * 1000


def test_observed_counts_per_trigger_counts_correctly() -> None:
    target_times = np.array([0, 10, 30, 50, 90], dtype=np.int64) * HOUR_MS
    triggers = np.array([0, 40], dtype=np.int64) * HOUR_MS

    counts = observed_counts_per_trigger(
        target_times, triggers, lag_start_hours=0, lag_end_hours=24
    )
    # Trigger at 0h: targets in [0,24) -> just the one at 0h and 10h -> 2.
    # Trigger at 40h: targets in [40,64) -> just the one at 50h -> 1.
    assert counts.tolist() == [2, 1]


def test_ratio_is_observed_over_expected() -> None:
    target_times = np.array([0, 5, 10], dtype=np.int64) * HOUR_MS
    triggers = np.array([0], dtype=np.int64)
    rate_per_hour = np.array([1.0])  # 1 event/hour expected

    stat = lag_window_statistic(
        target_times, triggers, rate_per_hour, lag_start_hours=0, lag_end_hours=24
    )
    assert stat.observed == 3
    assert stat.expected == 24.0
    assert stat.ratio == 3 / 24


def test_zero_expected_gives_nan_ratio_not_a_crash() -> None:
    target_times = np.array([0], dtype=np.int64)
    triggers = np.array([0], dtype=np.int64)
    rate_per_hour = np.array([0.0])

    stat = lag_window_statistic(
        target_times, triggers, rate_per_hour, lag_start_hours=0, lag_end_hours=24
    )
    assert stat.expected == 0.0
    assert math.isnan(stat.ratio)


def test_multiple_triggers_sum_with_multiplicity() -> None:
    # One target event falls inside both triggers' windows; it must be
    # counted once per trigger, not deduplicated.
    target_times = np.array([10], dtype=np.int64) * HOUR_MS
    triggers = np.array([0, 5], dtype=np.int64) * HOUR_MS  # windows [0,24) and [5,29)
    rate_per_hour = np.array([0.0, 0.0])

    stat = lag_window_statistic(
        target_times, triggers, rate_per_hour, lag_start_hours=0, lag_end_hours=24
    )
    assert stat.observed == 2
