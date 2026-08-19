import numpy as np

from terra_pulse_engine.pipeline.triggers import extract_threshold_episodes

HOUR_MS = 60 * 60 * 1000


def _hourly_grid(n_hours: int, start_ms: int = 0) -> np.ndarray:
    return start_ms + np.arange(n_hours, dtype=np.int64) * HOUR_MS


def test_single_run_becomes_one_episode_dated_to_its_first_hour() -> None:
    time_ms = _hourly_grid(10)
    values = np.array([0, 0, 6, 6, 6, 0, 0, 0, 0, 0], dtype=float)

    episodes = extract_threshold_episodes(
        time_ms, values, threshold=6, comparison=">=", min_consecutive_hours=1
    )

    assert episodes.onset_ms.tolist() == [time_ms[2]]
    assert episodes.run_length_hours.tolist() == [3]


def test_a_gap_ends_a_run_even_if_qualifying_resumes() -> None:
    time_ms = _hourly_grid(10)
    values = np.array([0, 6, 6, 0, 6, 6, 6, 0, 0, 0], dtype=float)  # two separate runs

    episodes = extract_threshold_episodes(
        time_ms, values, threshold=6, comparison=">=", min_consecutive_hours=1
    )

    assert episodes.onset_ms.tolist() == [time_ms[1], time_ms[4]]
    assert episodes.run_length_hours.tolist() == [2, 3]


def test_missing_measured_hour_breaks_a_run() -> None:
    # Registered rule (H3b, and H4c's completed registration): a missing or
    # null hour ends a run rather than being passed through.
    time_ms = _hourly_grid(8)
    values = np.array([600.0, 600.0, np.nan, 600.0, 600.0, 600.0, 0.0, 0.0])

    episodes = extract_threshold_episodes(
        time_ms, values, threshold=500, comparison=">=", min_consecutive_hours=3
    )

    # The first pair (2 measured hours) never reaches min_consecutive_hours=3
    # because the NaN breaks it; the second run of 3 does qualify.
    assert episodes.onset_ms.tolist() == [time_ms[3]]
    assert episodes.run_length_hours.tolist() == [3]


def test_minimum_duration_filters_short_runs() -> None:
    time_ms = _hourly_grid(10)
    values = np.array([0, 6, 6, 0, 6, 6, 6, 6, 6, 6], dtype=float)  # runs of 2 and 6

    episodes = extract_threshold_episodes(
        time_ms, values, threshold=6, comparison=">=", min_consecutive_hours=6
    )

    assert episodes.onset_ms.tolist() == [time_ms[4]]


def test_dst_uses_less_than_or_equal_comparison() -> None:
    time_ms = _hourly_grid(5)
    values = np.array([0.0, -50.0, -110.0, -105.0, 0.0])

    episodes = extract_threshold_episodes(
        time_ms, values, threshold=-100, comparison="<=", min_consecutive_hours=1
    )

    assert episodes.onset_ms.tolist() == [time_ms[2]]
    assert episodes.run_length_hours.tolist() == [2]


def test_eligible_mask_requires_a_fully_measured_forward_window() -> None:
    time_ms = _hourly_grid(6)
    # index:      0    1    2    3   4    5
    values = np.array([1.0, 1.0, np.nan, 1.0, 1.0, 1.0])

    episodes = extract_threshold_episodes(
        time_ms, values, threshold=100, comparison=">=", min_consecutive_hours=3
    )

    # A 3-hour window can start at an index i only if [i, i+3) is fully
    # measured. Index 0: [0,1,nan] -> not eligible. Index 1: [1,nan,3] -> not
    # eligible. Index 2: [nan,3,4] -> not eligible. Index 3: [3,4,5] all
    # measured -> eligible. No index past 3 has room for a full window.
    assert episodes.eligible_mask.tolist() == [False, False, False, True, False, False]


def test_measured_and_total_hours_report_coverage() -> None:
    time_ms = _hourly_grid(5)
    values = np.array([1.0, np.nan, 1.0, np.nan, 1.0])

    episodes = extract_threshold_episodes(
        time_ms, values, threshold=100, comparison=">=", min_consecutive_hours=1
    )

    assert episodes.measured_hours == 3
    assert episodes.total_hours == 5


def test_empty_input() -> None:
    empty_time = np.zeros(0, dtype=np.int64)
    empty_values = np.zeros(0, dtype=float)

    episodes = extract_threshold_episodes(
        empty_time, empty_values, threshold=6, comparison=">=", min_consecutive_hours=1
    )

    assert episodes.onset_ms.shape == (0,)
    assert episodes.measured_hours == 0
    assert episodes.total_hours == 0
