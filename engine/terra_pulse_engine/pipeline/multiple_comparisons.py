"""Benjamini-Hochberg (1995) false discovery rate correction.

Non-negotiable #4: multiple-comparison correction is mandatory, across the
*full* test matrix, not per-test — and HYPOTHESES.md rule 4 requires every
result to report its denominator. This module is deliberately small rather
than a statsmodels dependency: the procedure is ~10 lines, and a hand-rolled,
readable, tested version is worth more here than a black-box import, per this
project's "reference implementations over clever ones" convention.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class BhResult:
    q: float
    family_size: int
    tests_run: int
    p_adjusted: np.ndarray  # aligned to the input p_values order
    rejected: np.ndarray  # bool, aligned


def benjamini_hochberg(
    p_values: np.ndarray, q: float, *, family_size: int | None = None
) -> BhResult:
    """Standard step-up BH: sort ascending, adjusted p at rank i is
    min over j>=i of (family_size/j) * p_(j) — the running minimum from the
    largest rank down enforces the required monotonicity (adjusted p can
    never decrease as the raw p increases).

    `family_size` lets the same function report both numbers this project's
    partial test matrices need: pass `len(p_values)` (the default) for
    "corrected across the tests actually run", or the full registered matrix
    size to get the conservative full-matrix figure. The latter treats every
    test outside `p_values` as not-yet-observed rather than assuming
    anything about it — it changes only the `family_size/j` scale factor,
    never the ranking, so for a fixed p-value set:
    `family_size=m2 >= m1` produces `p_adjusted` values that are
    element-wise >= the `family_size=m1` result. That is what makes the
    full-matrix figure conservative rather than merely different, and it's
    pinned by a test.

    Raises if `family_size < len(p_values)` — the family can never be smaller
    than the tests actually run.
    """
    p = np.asarray(p_values, dtype=float)
    n_tested = p.shape[0]
    m = family_size if family_size is not None else n_tested
    if m < n_tested:
        raise ValueError("family_size must be >= the number of p-values provided")
    if n_tested == 0:
        return BhResult(
            q=q,
            family_size=m,
            tests_run=0,
            p_adjusted=np.zeros(0),
            rejected=np.zeros(0, dtype=bool),
        )

    order = np.argsort(p, kind="stable")
    ranked = p[order]
    ranks = np.arange(1, n_tested + 1)

    scaled = ranked * (m / ranks)
    # Running minimum from the largest rank down to the smallest — this is
    # what guarantees p_adjusted is non-decreasing in the raw p-value.
    adjusted_sorted = np.minimum.accumulate(scaled[::-1])[::-1]
    adjusted_sorted = np.clip(adjusted_sorted, 0.0, 1.0)

    p_adjusted = np.empty(n_tested, dtype=float)
    p_adjusted[order] = adjusted_sorted

    rejected = p_adjusted <= q

    return BhResult(
        q=q, family_size=m, tests_run=n_tested, p_adjusted=p_adjusted, rejected=rejected
    )
