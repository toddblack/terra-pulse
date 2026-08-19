"""The H2b test statistic: a hemispheric rate ratio, not a lag-window ratio.

For each CME arrival, "near" means within `split_degrees` of longitude of the
subsolar point at that instant — the sun-facing hemisphere at the moment of
arrival, per HYPOTHESES.md H2b's registered spatial split. Every other target
event in the same lag window is "far". Counted with multiplicity across
overlapping triggers, the same convention `pipeline/lag_windows.py` already
documents for H4c/H3b.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from terra_pulse_engine.pipeline.subsolar import subsolar_longitude_deg

HOUR_MS = 60 * 60 * 1000


@dataclass(frozen=True)
class HemisphereStatistic:
    near: int
    far: int
    # near / far — NaN if far is 0 (no exposure on the complement side, an
    # edge case with too few events to mean anything).
    ratio: float


def _longitude_within_deg(
    event_lon_deg: np.ndarray, center_lon_deg: np.ndarray | float, split_degrees: float
) -> np.ndarray:
    """True where `event_lon_deg` is within `split_degrees` of `center_lon_deg`,
    correctly handling the +/-180 wraparound (a naive subtraction would treat
    179 and -179 as 358 degrees apart instead of 2). `center_lon_deg` may be
    a scalar (compare every event to one centre) or an array the same shape
    as `event_lon_deg` (compare each event to its own paired centre, via
    ordinary numpy broadcasting) — `hemisphere_ratio_statistic` uses the
    array form so each matched event is checked against the subsolar
    longitude for *its own* trigger, not a shared one.
    """
    diff = np.mod(event_lon_deg - center_lon_deg + 180.0, 360.0) - 180.0
    return np.abs(diff) <= split_degrees


def hemisphere_ratio_statistic(
    target_time_ms: np.ndarray,
    target_longitude_deg: np.ndarray,
    trigger_times_ms: np.ndarray,
    *,
    lag_start_hours: float,
    lag_end_hours: float,
    split_degrees: float,
) -> HemisphereStatistic:
    """`target_time_ms` must be sorted ascending; `target_longitude_deg` is
    aligned to it index-for-index. One subsolar longitude is computed per
    trigger (the sun's position at the moment that CME arrived), not per
    target event — the classification answers "was this earthquake on the
    sun-facing side when the CME hit", not "is it ever sun-facing".

    **Fully vectorized across triggers — no Python-level loop over them —
    and that is not a style preference.** This function is called once per
    Monte Carlo permutation (10,000 times per lag window). A first version
    called `subsolar_longitude_deg` once per trigger and used
    `np.searchsorted` once per trigger too, both inside a Python `for`
    loop; at the real direct-impact trigger count (~580, measured against
    the dev database) that is >11 million individual numpy calls per lag
    window — measured to exceed 5 minutes and trip the caller's own HTTP
    timeout before finishing, even after hoisting the subsolar computation
    alone wasn't enough. `np.searchsorted` accepts a vector of query points
    and returns a vector of insertion indices in one call — the same "hoist
    the per-row work" fix `sampleFieldGrid` applies to the IGRF field grid
    (see CLAUDE.md), applied to every step here, not just the trig-heavy
    one.
    """
    if trigger_times_ms.size == 0:
        return HemisphereStatistic(near=0, far=0, ratio=float("nan"))

    subsolar_lon_by_trigger = subsolar_longitude_deg(trigger_times_ms.astype(float))

    window_starts = trigger_times_ms + lag_start_hours * HOUR_MS
    window_ends = trigger_times_ms + lag_end_hours * HOUR_MS
    los = np.searchsorted(target_time_ms, window_starts, side="left")
    his = np.searchsorted(target_time_ms, window_ends, side="left")
    counts_per_trigger = his - los

    total_matched = int(counts_per_trigger.sum())
    if total_matched == 0:
        return HemisphereStatistic(near=0, far=0, ratio=float("nan"))

    # Flatten every trigger's window into one array of target-event indices,
    # paired with which trigger each one belongs to — built from per-trigger
    # ranges, but each range costs only array creation, not a numpy function
    # call chain, and the total work is bounded by matched events, not by
    # `n_triggers x iterations` the way the per-trigger loop was.
    target_indices = np.concatenate(
        [np.arange(lo, hi) for lo, hi in zip(los, his) if hi > lo]
    )
    trigger_indices = np.repeat(np.arange(trigger_times_ms.shape[0]), counts_per_trigger)

    matched_longitudes = target_longitude_deg[target_indices]
    matched_subsolar = subsolar_lon_by_trigger[trigger_indices]

    near_mask = _longitude_within_deg(matched_longitudes, matched_subsolar, split_degrees)
    total_near = int(np.sum(near_mask))
    total_far = total_matched - total_near

    ratio = total_near / total_far if total_far > 0 else float("nan")
    return HemisphereStatistic(near=total_near, far=total_far, ratio=ratio)
