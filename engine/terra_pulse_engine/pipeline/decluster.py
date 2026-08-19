"""Gardner-Knopoff (1974) declustering.

Independent Python port of packages/schema/src/aftershocks.ts and
packages/schema/src/recurrence.ts's declusterGardnerKnopoff. Non-negotiable #2
requires declustering before any statistical test; this module is what the
rest of the pipeline calls to get there.

Ported rather than re-derived, deliberately: the TS formulas were already
checked against Gardner & Knopoff's own published Table 1 (via the
Uhrhammer 1986 analytic fit), and matching a validated reference is worth
more here than re-deriving from first principles and hoping the arithmetic
agrees. tests/test_decluster.py pins the same Table 1 values the TS tests use,
plus a cross-language parity fixture (tests/fixtures/gk_parity.json) shared
with packages/schema/src/recurrence.test.ts — if the two implementations ever
disagree on real data, a test fails in whichever language drifted.
"""

from __future__ import annotations

import numpy as np

from terra_pulse_engine.pipeline.geo import haversine_km

DAY_MS = 24 * 60 * 60 * 1000


def gardner_knopoff_radius_km(magnitude: np.ndarray | float) -> np.ndarray | float:
    """Uhrhammer (1986) fit to GK's Table 1. M6.0 -> 53.2 km (54 tabulated),
    M7.0 -> 70.7 km (70 tabulated).
    """
    return 10.0 ** (0.1238 * magnitude + 0.983)


def gardner_knopoff_window_days(magnitude: np.ndarray | float) -> np.ndarray | float:
    """Two branches, split at M6.5. M7.0 -> 918 days (915 tabulated), M8.0 ->
    988 days (985 tabulated).

    The fit is NOT monotonic across the M6.5 seam, and that is left alone —
    it is a property of the published piecewise form, not a bug: an M6.5 gets
    a window ~45.8 days (4.9%) *shorter* than an M6.4. Taking the larger
    branch everywhere "fixes" the monotonicity and then explodes — the lower
    branch extrapolates to ~20,946 days (57 years) at M9, which would claim
    an entire multi-decade catalogue as one sequence. Smoothing the seam would
    mean inventing a coefficient no paper published, which is exactly the free
    parameter non-negotiable #3 forbids. See the identical note in
    packages/schema/src/recurrence.ts — do not "fix" this independently in
    either language.
    """
    upper = 10.0 ** (0.032 * magnitude + 2.7389)
    lower = 10.0 ** (0.5409 * magnitude - 0.547)
    return np.where(np.asarray(magnitude) >= 6.5, upper, lower)


def decluster_gardner_knopoff(
    time_ms: np.ndarray,
    latitude: np.ndarray,
    longitude: np.ndarray,
    magnitude: np.ndarray,
) -> np.ndarray:
    """Returns a boolean mask, aligned to the input arrays, True where the
    event survives as independent.

    Sweep semantics, copied exactly from declusterGardnerKnopoff:
    - Walks events **largest magnitude first** (stable sort, so ties keep
      their input order — matches Array.prototype.sort's stability).
    - Each surviving event claims every other, not-yet-resolved event inside
      its own space-time window as dependent.
    - Only events **strictly after** the claiming event in time are removed
      (0 < delta <= window) — foreshocks are never removed, so an early
      independent event can't be erased by a later, larger one.
    - Once an event is independent it can never be reclassified dependent.

    Callers must pass finite timestamps — the API contract layer rejects
    non-finite/out-of-range input before it reaches here, so this function
    does not re-check it.
    """
    n = time_ms.shape[0]
    if n == 0:
        return np.zeros(0, dtype=bool)

    magnitude_desc_order = np.argsort(-magnitude, kind="stable")

    time_order = np.argsort(time_ms, kind="stable")
    time_sorted = time_ms[time_order]
    lat_sorted = latitude[time_order]
    lon_sorted = longitude[time_order]
    position_in_time_sorted = np.empty(n, dtype=np.int64)
    position_in_time_sorted[time_order] = np.arange(n)

    # 0 = unresolved, 1 = independent, 2 = dependent
    status = np.zeros(n, dtype=np.int8)

    for idx in magnitude_desc_order:
        if status[idx] == 2:
            continue
        status[idx] = 1

        radius_km = gardner_knopoff_radius_km(magnitude[idx])
        window_ms = gardner_knopoff_window_days(magnitude[idx]) * DAY_MS
        origin_ms = time_ms[idx]

        pos = position_in_time_sorted[idx]
        lo = np.searchsorted(time_sorted, origin_ms, side="right")
        hi = np.searchsorted(time_sorted, origin_ms + window_ms, side="right")
        if hi <= lo:
            continue

        window_positions = np.arange(lo, hi)
        window_positions = window_positions[window_positions != pos]
        if window_positions.size == 0:
            continue

        candidate_original = time_order[window_positions]
        unresolved = status[candidate_original] == 0
        if not np.any(unresolved):
            continue
        candidate_original = candidate_original[unresolved]
        candidate_positions = window_positions[unresolved]

        distances = haversine_km(
            latitude[idx],
            longitude[idx],
            lat_sorted[candidate_positions],
            lon_sorted[candidate_positions],
        )
        within_radius = distances <= radius_km
        if np.any(within_radius):
            status[candidate_original[within_radius]] = 2

    return status == 1
