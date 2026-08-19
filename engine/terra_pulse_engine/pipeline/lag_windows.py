"""The lag-window test statistic: observed vs. Poisson-expected event count,
summed across all triggers of one trigger definition.

Overlapping trigger windows count a target event once per trigger it falls
under (with multiplicity) — both the observed and expected sums are counted
the same way, so the overlap cancels in the ratio rather than needing to be
deduplicated.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from terra_pulse_engine.pipeline.baseline import HOUR_MS


@dataclass(frozen=True)
class LagWindowStatistic:
    observed: int
    expected: float
    ratio: float  # observed / expected; NaN if expected is 0 (no exposure)


def observed_counts_per_trigger(
    target_times_ms: np.ndarray,
    trigger_times_ms: np.ndarray,
    *,
    lag_start_hours: float,
    lag_end_hours: float,
) -> np.ndarray:
    """For each trigger, the count of target events in
    [trigger + lag_start_hours, trigger + lag_end_hours) hours.
    `target_times_ms` must be sorted ascending.
    """
    window_start = trigger_times_ms + lag_start_hours * HOUR_MS
    window_end = trigger_times_ms + lag_end_hours * HOUR_MS
    lo = np.searchsorted(target_times_ms, window_start, side="left")
    hi = np.searchsorted(target_times_ms, window_end, side="left")
    return hi - lo


def lag_window_statistic(
    target_times_ms: np.ndarray,
    trigger_times_ms: np.ndarray,
    rate_per_hour: np.ndarray,
    *,
    lag_start_hours: float,
    lag_end_hours: float,
) -> LagWindowStatistic:
    """`rate_per_hour` is one local-baseline rate per trigger (see
    pipeline.baseline.local_rate_per_hour), computed once and reused across
    every lag window for the same trigger set — the rate itself doesn't
    depend on the lag window, only the exposure duration does.
    """
    duration_hours = lag_end_hours - lag_start_hours
    observed_per_trigger = observed_counts_per_trigger(
        target_times_ms,
        trigger_times_ms,
        lag_start_hours=lag_start_hours,
        lag_end_hours=lag_end_hours,
    )
    expected_per_trigger = rate_per_hour * duration_hours

    observed_total = int(observed_per_trigger.sum())
    expected_total = float(expected_per_trigger.sum())
    ratio = observed_total / expected_total if expected_total > 0 else float("nan")

    return LagWindowStatistic(observed=observed_total, expected=expected_total, ratio=ratio)
