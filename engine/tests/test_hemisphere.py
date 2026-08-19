import math

import numpy as np
import pytest

from terra_pulse_engine.pipeline.hemisphere import _longitude_within_deg, hemisphere_ratio_statistic

HOUR_MS = 60 * 60 * 1000


def test_longitude_within_deg_handles_ordinary_case() -> None:
    result = _longitude_within_deg(np.array([10.0, 100.0, -80.0]), 0.0, 90.0)
    assert result.tolist() == [True, False, True]


def test_longitude_within_deg_handles_the_180_wraparound() -> None:
    # 179 and -179 are 2 degrees apart the short way round, not 358.
    result = _longitude_within_deg(np.array([-179.0]), 179.0, 90.0)
    assert result.tolist() == [True]


def test_ratio_counts_near_and_far_correctly() -> None:
    # Subsolar longitude near 0 deg at this instant is not what matters for
    # this unit test; we only need target events at known offsets.
    target_time = np.array([1 * HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS, 4 * HOUR_MS], dtype=np.int64)
    target_lon = np.array([0.0, 0.0, 0.0, 0.0])  # placeholder; classification tested separately
    trigger_times = np.array([0], dtype=np.int64)

    stat = hemisphere_ratio_statistic(
        target_time, target_lon, trigger_times, lag_start_hours=0, lag_end_hours=24, split_degrees=90
    )
    # All 4 events share the same longitude, so however the split falls they
    # all land on the same side.
    assert stat.near + stat.far == 4
    assert stat.near == 4 or stat.far == 4


def test_zero_far_gives_nan_ratio_not_a_crash() -> None:
    target_time = np.array([1 * HOUR_MS], dtype=np.int64)
    target_lon = np.array([0.0])
    trigger_times = np.array([0], dtype=np.int64)

    stat = hemisphere_ratio_statistic(
        target_time, target_lon, trigger_times, lag_start_hours=0, lag_end_hours=24, split_degrees=180
    )
    # split_degrees=180 means everything is "near" -> far is 0.
    assert stat.far == 0
    assert math.isnan(stat.ratio)


def test_multiple_triggers_sum_with_multiplicity() -> None:
    target_time = np.array([5 * HOUR_MS], dtype=np.int64)
    target_lon = np.array([0.0])
    trigger_times = np.array([0, 1 * HOUR_MS], dtype=np.int64)  # both see the same event

    stat = hemisphere_ratio_statistic(
        target_time, target_lon, trigger_times, lag_start_hours=0, lag_end_hours=24, split_degrees=180
    )
    assert stat.near + stat.far == 2  # counted once per trigger


def test_empty_trigger_set_gives_zero_counts() -> None:
    target_time = np.array([1 * HOUR_MS], dtype=np.int64)
    target_lon = np.array([0.0])
    trigger_times = np.zeros(0, dtype=np.int64)

    stat = hemisphere_ratio_statistic(
        target_time, target_lon, trigger_times, lag_start_hours=0, lag_end_hours=24, split_degrees=90
    )
    assert stat.near == 0
    assert stat.far == 0


def test_split_degrees_180_classifies_everything_near() -> None:
    target_time = np.array([1 * HOUR_MS, 2 * HOUR_MS], dtype=np.int64)
    target_lon = np.array([170.0, -170.0])
    trigger_times = np.array([0], dtype=np.int64)

    stat = hemisphere_ratio_statistic(
        target_time, target_lon, trigger_times, lag_start_hours=0, lag_end_hours=24, split_degrees=180
    )
    assert stat.far == 0
    assert stat.near == 2
