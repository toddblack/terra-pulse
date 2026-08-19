"""Threshold-episode extraction: turn a sampled index series (Kp, Dst, solar
wind speed, ...) into discrete trigger instants.

One function serves both H4c (min_consecutive_hours=1, run twice — once for
Kp >= 6, once for Dst <= -100) and H3b later (speed > 500, min 6 consecutive
measured hours) without change, per the registered episode definitions in
HYPOTHESES.md.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

Comparison = Literal[">=", "<="]


@dataclass(frozen=True)
class Episodes:
    """`onset_ms[i]` is the first hour of the i-th maximal qualifying run,
    `run_length_hours[i]` its length. `eligible_mask` marks every hour in the
    input grid where a full-duration measured window *could* have started
    (used only as the null model's draw pool — it says nothing about whether
    the value there qualified). `measured_hours`/`total_hours` describe
    exposure, for reporting coverage.
    """

    onset_ms: np.ndarray
    run_length_hours: np.ndarray
    eligible_mask: np.ndarray
    measured_hours: int
    total_hours: int


def extract_threshold_episodes(
    time_ms: np.ndarray,
    values: np.ndarray,
    *,
    threshold: float,
    comparison: Comparison,
    min_consecutive_hours: int,
) -> Episodes:
    """`time_ms` must be a complete, contiguous, ascending 1-hour grid —
    gaps in the underlying series must already be represented as NaN at their
    correct position (not omitted as missing rows), or run-contiguity can't
    be judged. `values` carries NaN wherever an hour was not measured.

    A missing/null hour always ends a run — the registered rule for both
    H4c and H3b (HYPOTHESES.md). This falls out automatically: an unmeasured
    hour never qualifies, so a run of qualifying hours can't span one.
    """
    n = time_ms.shape[0]
    if n == 0:
        return Episodes(
            onset_ms=np.zeros(0, dtype=np.int64),
            run_length_hours=np.zeros(0, dtype=np.int64),
            eligible_mask=np.zeros(0, dtype=bool),
            measured_hours=0,
            total_hours=0,
        )

    measured = ~np.isnan(values)
    if comparison == ">=":
        qualifies = measured & (values >= threshold)
    elif comparison == "<=":
        qualifies = measured & (values <= threshold)
    else:
        raise ValueError(f"unknown comparison {comparison!r}")

    qualifies_int = qualifies.astype(np.int8)
    edges = np.diff(np.concatenate(([0], qualifies_int, [0])))
    run_starts = np.flatnonzero(edges == 1)
    run_ends = np.flatnonzero(edges == -1)  # exclusive
    run_lengths_all = run_ends - run_starts

    keep = run_lengths_all >= min_consecutive_hours
    onset_ms = time_ms[run_starts[keep]]
    run_length_hours = run_lengths_all[keep]

    window = min_consecutive_hours
    eligible = np.zeros(n, dtype=bool)
    if window <= n:
        cum_unmeasured = np.concatenate(([0], np.cumsum(~measured)))
        unmeasured_in_window = cum_unmeasured[window:] - cum_unmeasured[: n - window + 1]
        eligible[: n - window + 1] = unmeasured_in_window == 0

    return Episodes(
        onset_ms=onset_ms.astype(np.int64),
        run_length_hours=run_length_hours.astype(np.int64),
        eligible_mask=eligible,
        measured_hours=int(measured.sum()),
        total_hours=n,
    )
