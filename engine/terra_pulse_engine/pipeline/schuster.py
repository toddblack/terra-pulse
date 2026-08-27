"""Schuster's test — H6's statistic, and the standard one for tidal triggering.

Each event contributes a unit vector at its tidal phase. If occurrence is
independent of tidal phase the vectors point every which way and their sum
stays near the origin; if some phase is preferred the sum grows. The statistic
is the length of that resultant:

    R = |sum_i exp(i * phi_i)|

This is the test Schuster proposed in 1897 for exactly this question, and the
one the tidal-triggering literature has used since — including Tanaka, Ohtake &
Sato (2002), whose positive result on tidal shear stress is H6's starting
reference. Using anything else here would make the result harder to compare
against the work that motivated it.

-------------------------------------------------------------------------------
Why the analytic p-value is computed but not reported
-------------------------------------------------------------------------------

Under a uniform-phase null, R follows a Rayleigh distribution and

    P(R >= r) = exp(-r^2 / N)

which is exact, free, and **not what H6 registered**. The registration calls
for 10,000 Monte Carlo iterations redrawing origin instants from the pool of
hours in the span, and that is not the same null: it draws from *whole hours*,
and the solar semidiurnal constituent S2 has a period of exactly 12.000 hours.
An hourly pool is therefore commensurate with S2 and cannot sample its phase
uniformly. The Rayleigh formula would silently assume it does.

`schuster_p_value` exists so the two can be compared — a large gap between the
analytic and Monte Carlo p-values is a signal that the pool is aliasing, which
is worth knowing rather than hiding. Only the Monte Carlo value is reported as
the result.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class SchusterResult:
    """The resultant, plus what a reader needs to interpret it."""

    resultant_length: float
    """R — the registered statistic."""

    mean_resultant_length: float
    """R/N, in [0, 1]. Scale-free, so it is the number to compare across
    subsets of different size; R itself grows like sqrt(N) under the null."""

    preferred_phase_deg: float
    """Direction of the resultant — the phase events cluster toward, if any.
    Meaningless when R is at its noise floor, and reported anyway because
    withholding it would make a null look like a missing value."""

    count: int


def resultant(phases_deg: np.ndarray) -> SchusterResult:
    """Schuster's resultant over a set of phase angles in degrees.

    NaN phases are dropped rather than propagated — they arise when a query
    falls outside the computed series (see `tidal_phase.phase_degrees`), and an
    event with no computable phase must not silently zero the statistic.
    """
    phases = np.asarray(phases_deg, dtype=float)
    phases = phases[np.isfinite(phases)]
    count = int(phases.size)
    if count == 0:
        return SchusterResult(0.0, 0.0, float("nan"), 0)

    radians = np.radians(phases)
    east = float(np.sum(np.cos(radians)))
    north = float(np.sum(np.sin(radians)))
    length = float(np.hypot(east, north))

    return SchusterResult(
        resultant_length=length,
        mean_resultant_length=length / count,
        preferred_phase_deg=float(np.degrees(np.arctan2(north, east))),
        count=count,
    )


def resultant_lengths(phases_deg: np.ndarray) -> np.ndarray:
    """R for many phase sets at once — `phases_deg` is (iterations, n).

    The Monte Carlo loop's inner statistic. Vectorised over the iteration axis
    because a Python loop over 10,000 iterations of a 10,000-element sum is
    most of this hypothesis's runtime otherwise, which is the lesson `h1b.py`
    already records about Monte Carlo inner loops.
    """
    radians = np.radians(np.asarray(phases_deg, dtype=float))
    east = np.sum(np.cos(radians), axis=-1)
    north = np.sum(np.sin(radians), axis=-1)
    return np.hypot(east, north)


def schuster_p_value(resultant_length: float, count: int) -> float:
    """The classical Rayleigh tail, P(R >= r) = exp(-r^2/N).

    Reference only — see the module docstring for why the reported p-value is
    the Monte Carlo one instead.
    """
    if count <= 0:
        return 1.0
    return float(np.exp(-(resultant_length**2) / count))


def phase_histogram(phases_deg: np.ndarray, bins: int = 12) -> np.ndarray:
    """Counts per equal phase bin, for presentation only.

    H6 registers 12 bins (30 degree windows) explicitly "for presentation and
    the sinusoidal fit only" — the statistic above is unbinned, so nothing
    about the result depends on this choice. Bin edges run from -180.
    """
    phases = np.asarray(phases_deg, dtype=float)
    phases = phases[np.isfinite(phases)]
    counts, _ = np.histogram(phases, bins=bins, range=(-180.0, 180.0))
    return counts
