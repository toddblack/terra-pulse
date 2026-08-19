"""Poisson baseline rate, estimated within a moving local window.

H1b registers this mitigation explicitly (HYPOTHESES.md): the M5.0+ target
catalogue is not stationary — measured on this app's own database, M5.0+
events/year rise 36% from the 1970s to the 2010s, network growth rather than
seismicity. A baseline pooled across the whole record would let late-record
windows show a manufactured excess and early ones a manufactured deficit.
H4c's own completed registration (2026-08-18) adopts the same fix, for the
same reason. This module is what makes the fix reusable rather than
per-hypothesis.
"""

from __future__ import annotations

import numpy as np

HOUR_MS = 60 * 60 * 1000
DAY_MS = 24 * HOUR_MS


def local_rate_per_hour(
    target_times_ms: np.ndarray,
    at_times_ms: np.ndarray,
    *,
    half_width_days: float,
    span_start_ms: int,
    span_end_ms: int,
) -> np.ndarray:
    """The declustered-target event rate (events/hour) in a window of
    +/- half_width_days centred on each `at_times_ms` instant.

    `target_times_ms` must be sorted ascending. The window is clipped to
    [span_start_ms, span_end_ms] — the analysis span's own bounds — and
    exposure (the denominator) is clipped identically, so a trigger near
    either edge of the span gets a rate estimated from however much of its
    window actually falls inside observed history, rather than silently
    assuming events could have been seen outside it.
    """
    half_width_ms = half_width_days * DAY_MS
    window_start = np.clip(at_times_ms - half_width_ms, span_start_ms, span_end_ms)
    window_end = np.clip(at_times_ms + half_width_ms, span_start_ms, span_end_ms)

    exposure_hours = np.maximum(window_end - window_start, 0) / HOUR_MS

    lo = np.searchsorted(target_times_ms, window_start, side="left")
    hi = np.searchsorted(target_times_ms, window_end, side="right")
    counts = (hi - lo).astype(float)

    return np.where(exposure_hours > 0, counts / exposure_hours, 0.0)
