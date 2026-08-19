"""Chunked Monte Carlo permutation testing.

Hypothesis-agnostic: it knows nothing about triggers, lag windows or Poisson
rates. A caller supplies `draw_fn` (produces one batch of redrawn trigger-time
sets) and `statistic_fn` (reduces one batch of trigger-time sets to one
statistic value each); this module handles chunking, the null summary and the
p-value.

Chunked rather than materializing the full (iterations x n_triggers) array at
once, per PROJECT_PLAN.md §7.5's memory-management note ("chunk permutations
rather than materializing the full matrix").
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Literal

import numpy as np

Tail = Literal["upper", "lower"]

DEFAULT_HISTOGRAM_BINS = 60


@dataclass(frozen=True)
class NullSummary:
    iterations: int
    seed: int
    mean: float
    sd: float
    quantiles: dict[str, float]
    histogram_edges: list[float]
    histogram_counts: list[int]


@dataclass(frozen=True)
class PermutationResult:
    observed: float
    p_value: float
    tail: Tail
    null: NullSummary


def permutation_null(
    *,
    observed_statistic: float,
    draw_fn: Callable[[np.random.Generator, int], np.ndarray],
    statistic_fn: Callable[[np.ndarray], np.ndarray],
    iterations: int = 10_000,
    chunk_size: int = 500,
    seed: int,
    tail: Tail = "upper",
    histogram_bins: int = DEFAULT_HISTOGRAM_BINS,
) -> PermutationResult:
    """Runs `iterations` permutations in chunks of at most `chunk_size`,
    deterministic from `seed`. Returns the observed statistic's p-value
    against the null distribution plus a compact summary of that
    distribution (never the raw draws — a 60-bin histogram is the "null
    distribution plot" payload at a fraction of the size).

    p-value uses the standard never-zero form,
    (1 + #{null at least as extreme}) / (1 + N): a permutation test with N
    draws cannot support the claim "p = 0" no matter how extreme the observed
    value, and this estimator says so by construction.
    """
    if iterations <= 0:
        raise ValueError("iterations must be positive")

    rng = np.random.default_rng(seed)
    null_values = np.empty(iterations, dtype=float)

    filled = 0
    while filled < iterations:
        batch_size = min(chunk_size, iterations - filled)
        drawn = draw_fn(rng, batch_size)
        null_values[filled : filled + batch_size] = statistic_fn(drawn)
        filled += batch_size

    finite_null = null_values[np.isfinite(null_values)]

    if tail == "upper":
        exceed = int(np.sum(null_values >= observed_statistic))
    elif tail == "lower":
        exceed = int(np.sum(null_values <= observed_statistic))
    else:
        raise ValueError(f"unknown tail {tail!r}")

    p_value = (1 + exceed) / (1 + iterations)

    if finite_null.size > 0:
        counts, edges = np.histogram(finite_null, bins=histogram_bins)
        mean = float(np.mean(finite_null))
        sd = float(np.std(finite_null))
        quantiles = {
            f"p{int(q * 100)}": float(np.quantile(finite_null, q)) for q in (0.5, 0.9, 0.95, 0.99)
        }
    else:
        counts, edges = np.zeros(histogram_bins, dtype=int), np.zeros(histogram_bins + 1)
        mean = float("nan")
        sd = float("nan")
        quantiles = {f"p{int(q * 100)}": float("nan") for q in (0.5, 0.9, 0.95, 0.99)}

    return PermutationResult(
        observed=observed_statistic,
        p_value=float(p_value),
        tail=tail,
        null=NullSummary(
            iterations=iterations,
            seed=seed,
            mean=mean,
            sd=sd,
            quantiles=quantiles,
            histogram_edges=[float(x) for x in edges],
            histogram_counts=[int(x) for x in counts],
        ),
    )


class UniformRedraw:
    """The registered H4c null model: trigger onsets redrawn uniformly
    without replacement from the eligible-hour pool, independently per batch
    row. `shuffle=False` on the underlying choice — order doesn't matter for
    a set of onset times, and skipping it avoids materializing a full
    permutation of the (large) eligible pool per draw.
    """

    def __init__(self, eligible_times_ms: np.ndarray, n_triggers: int) -> None:
        if n_triggers > eligible_times_ms.shape[0]:
            raise ValueError("not enough eligible hours to draw triggers without replacement")
        self.eligible_times_ms = eligible_times_ms
        self.n_triggers = n_triggers

    def draw(self, rng: np.random.Generator, batch_size: int) -> np.ndarray:
        pool_size = self.eligible_times_ms.shape[0]
        drawn = np.empty((batch_size, self.n_triggers), dtype=np.int64)
        for row in range(batch_size):
            idx = rng.choice(pool_size, size=self.n_triggers, replace=False, shuffle=False)
            drawn[row] = self.eligible_times_ms[idx]
        return drawn


class CircularShift:
    """Not implemented — a circular time-shift null preserves trigger
    clustering and is a genuinely different null model from the registered
    uniform redraw. HYPOTHESES.md would need its own entry for it (rule 2:
    all parameters explicit) before it could be used for a real result.
    """

    def draw(self, rng: np.random.Generator, batch_size: int) -> np.ndarray:
        raise NotImplementedError(
            "CircularShift requires its own registration in HYPOTHESES.md before use"
        )
