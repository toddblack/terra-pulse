"""Tidal phase — turning a shear-stress time series into the angle H6 tests.

`HYPOTHESES.md` H6 defines it exactly:

    0 degrees at each local **maximum** of the computed shear-stress time
    series at that hypocentre, +/-180 at the minima, linear in time between
    successive extrema. Referenced to the event's own computed series, so no
    tidal constituent has to be named.

That last clause is the useful one. Nothing here decomposes the tide into M2,
S2, K1 and friends, so nothing has to choose which constituent "the" phase is
measured against — a choice that would have been a free parameter under
non-negotiable #3. The series is its own reference.

It also makes the phase **invariant to any uniform scaling of the stress**,
which is what lets `tides.py` get away with nominal elastic moduli: doubling
every modulus doubles tau and moves no extremum.

-------------------------------------------------------------------------------
Why extrema are found on the derivative and not on tau itself
-------------------------------------------------------------------------------

An extremum is located by parabolic interpolation through the three samples
around a sign change in the first difference. Fitting the peak of tau directly
is the same arithmetic, but the sign change is what makes the *detection*
robust: a flat-topped maximum (which happens when a diurnal and a semidiurnal
constituent nearly cancel) has no unambiguous sample maximum, and it always has
a derivative sign change.

The grid step is a real accuracy knob and it is measured rather than assumed —
see `test_tidal_phase.py`, which drives a synthetic sinusoid of the M2 period
through this module and checks the recovered phase against the analytic answer.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class PhaseReference:
    """The extrema of one event's shear series, ready for phase lookups.

    `times` are epoch milliseconds, ascending. `is_max` marks which of them are
    maxima; the two alternate in practice but nothing here relies on that,
    because a degenerate series (all-zero shear on a fault the tide cannot
    load) would break the alternation and should degrade rather than crash.
    """

    times_ms: np.ndarray
    is_max: np.ndarray

    def __len__(self) -> int:
        return int(self.times_ms.size)


def find_extrema(times_ms: np.ndarray, values: np.ndarray) -> PhaseReference:
    """Locate the extrema of one series by sign changes in its first difference.

    `values` may be (n,) for a single series. Sub-sample position comes from a
    parabola through the three samples bracketing the change, which is what
    keeps the phase accurate on a coarse grid — the samples themselves are up
    to half a step away from the true extremum, and half an hourly step is
    2.4 degrees of a semidiurnal cycle.
    """
    times_ms = np.asarray(times_ms, dtype=float)
    values = np.asarray(values, dtype=float)

    diff = np.diff(values)
    negative = np.signbit(diff)
    # Index into `values` of the sample at the turn: diff[i-1] and diff[i] have
    # opposite signs, so values[i] is the local extremum sample.
    turns = np.nonzero(negative[:-1] != negative[1:])[0] + 1
    if turns.size == 0:
        return PhaseReference(np.empty(0), np.empty(0, dtype=bool))

    y0 = values[turns - 1]
    y1 = values[turns]
    y2 = values[turns + 1]
    curvature = y0 - 2.0 * y1 + y2

    # A sign change guarantees curvature != 0 for a strictly monotone-then-
    # monotone series, but a plateau of exactly equal samples can produce zero.
    # Fall back to the sample itself rather than dividing by it.
    safe = curvature != 0.0
    offset = np.zeros_like(curvature)
    np.divide(0.5 * (y0 - y2), curvature, out=offset, where=safe)

    step = times_ms[turns] - times_ms[turns - 1]
    extremum_times = times_ms[turns] + offset * step
    return PhaseReference(extremum_times, curvature < 0.0)


def batch_extrema(times_ms: np.ndarray, values: np.ndarray) -> list[PhaseReference]:
    """`find_extrema` for many series at once — `values` is (events, samples).

    Identical arithmetic to `find_extrema`, restructured for the only shape H6
    ever runs at: ~14,000 events against ~444,000 hourly samples, which is
    6.2 billion values and the single biggest cost in the hypothesis. Measured
    against the per-series version at that scale, this is about twice as fast,
    for two reasons worth keeping:

    - **Event-major layout.** Each series is contiguous, so the differencing
      runs down cache lines rather than striding across events. The caller is
      expected to produce `values` as `coefficients @ tensors.T`, which lands
      in this layout naturally — building the transpose and flipping it costs
      more than it saves.
    - **No float temporary for the difference.** `tau[1:] > tau[:-1]` answers
      the only question that matters (which way is it going) in a byte per
      sample, where `np.diff` would materialise another full float array.

    `values` may be float32. The extremum times then differ from the float64
    path by well under a tenth of a second — 4e-4 degrees of a semidiurnal
    cycle — which `test_tidal_phase.py` pins.
    """
    times_ms = np.asarray(times_ms, dtype=float)
    values = np.asarray(values)
    if values.ndim != 2:
        raise ValueError("batch_extrema expects (events, samples)")

    rising = values[:, 1:] > values[:, :-1]
    turning = rising[:, :-1] != rising[:, 1:]
    rows, columns = np.nonzero(turning)
    # `turning[e, m]` marks sample m+1 of event e as the extremum sample.
    sample = columns + 1

    y0 = values[rows, sample - 1].astype(float)
    y1 = values[rows, sample].astype(float)
    y2 = values[rows, sample + 1].astype(float)
    curvature = y0 - 2.0 * y1 + y2

    safe = curvature != 0.0
    offset = np.zeros_like(curvature)
    np.divide(0.5 * (y0 - y2), curvature, out=offset, where=safe)

    step = times_ms[sample] - times_ms[sample - 1]
    extremum_times = times_ms[sample] + offset * step
    is_max = curvature < 0.0

    # `np.nonzero` walks a C-contiguous array in row-major order, so `rows` is
    # already ascending and each event's run is contiguous. Splitting on that
    # is a search rather than a sort.
    bounds = np.searchsorted(rows, np.arange(values.shape[0] + 1))
    return [
        PhaseReference(extremum_times[bounds[e] : bounds[e + 1]], is_max[bounds[e] : bounds[e + 1]])
        for e in range(values.shape[0])
    ]


def phase_degrees(reference: PhaseReference, query_ms: np.ndarray) -> np.ndarray:
    """Tidal phase at each query instant, in (-180, 180].

    0 at a maximum of the shear series, +/-180 at a minimum, linear in time
    between. Queries outside the reference's extrema return NaN rather than
    an extrapolated angle — a phase invented past the end of the computed
    series would be indistinguishable from a real one.
    """
    query = np.asarray(query_ms, dtype=float)
    if len(reference) < 2:
        return np.full(query.shape, np.nan)

    times = reference.times_ms
    index = np.searchsorted(times, query, side="right")

    inside = (index >= 1) & (index <= times.size - 1)
    safe_index = np.clip(index, 1, times.size - 1)

    start = times[safe_index - 1]
    end = times[safe_index]
    starts_at_max = reference.is_max[safe_index - 1]

    span = end - start
    fraction = np.where(span > 0, (query - start) / np.where(span > 0, span, 1.0), 0.0)

    # From a maximum the phase runs 0 -> 180; from a minimum, -180 -> 0.
    phase = np.where(starts_at_max, 180.0 * fraction, -180.0 + 180.0 * fraction)
    return np.where(inside, phase, np.nan)
