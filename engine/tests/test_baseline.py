import numpy as np

from terra_pulse_engine.pipeline.baseline import DAY_MS, local_rate_per_hour

YEAR_MS = 365 * DAY_MS


def test_constant_rate_catalog_recovers_its_own_rate() -> None:
    # One event every 10 days for 20 years -> a known constant rate.
    n_events = 730
    spacing_ms = 10 * DAY_MS
    target_times = np.arange(n_events, dtype=np.int64) * spacing_ms
    span_end = target_times[-1] + spacing_ms

    at_time = np.array([target_times[365]])  # well clear of both edges
    rate = local_rate_per_hour(
        target_times, at_time, half_width_days=180, span_start_ms=0, span_end_ms=span_end
    )

    expected_rate = 1.0 / (10 * 24)  # one event per 240 hours
    assert abs(rate[0] - expected_rate) < expected_rate * 0.15


def test_secular_trend_biases_a_pooled_baseline_but_not_a_moving_one() -> None:
    """The executable argument for why H4c's registered moving-window
    baseline is necessary, not decorative: a catalogue whose rate doubles
    over its span makes a *pooled* mean rate wrong everywhere except the
    midpoint, while a small local window stays right throughout.
    """
    total_span_days = 20 * 365
    span_end = total_span_days * DAY_MS

    # Rate ramps from 1 event/day at the start to 2 events/day at the end.
    # Build it by drawing successively shorter gaps.
    times = []
    t = 0.0
    day = 0.0
    while t < span_end:
        # local instantaneous rate (events/day) grows linearly 1 -> 2
        progress = day / total_span_days
        rate_per_day = 1.0 + progress
        gap_days = 1.0 / rate_per_day
        t += gap_days * DAY_MS
        day += gap_days
        if t < span_end:
            times.append(t)
    target_times = np.array(sorted(times), dtype=np.int64)

    early_time = np.array([2 * 365 * DAY_MS])  # 2 years in: true rate ~1.1/day
    late_time = np.array([18 * 365 * DAY_MS])  # 18 years in: true rate ~1.9/day

    # Pooled: one rate averaged over the *entire* span, used everywhere.
    pooled_rate = target_times.shape[0] / (span_end / (60 * 60 * 1000))

    # Moving: a local window centred on each query point.
    half_width = 180
    early_local = local_rate_per_hour(
        target_times, early_time, half_width_days=half_width, span_start_ms=0, span_end_ms=span_end
    )[0]
    late_local = local_rate_per_hour(
        target_times, late_time, half_width_days=half_width, span_start_ms=0, span_end_ms=span_end
    )[0]

    true_early_rate_per_hour = 1.1 / 24
    true_late_rate_per_hour = 1.9 / 24

    # The pooled rate sits roughly in the middle (~1.5/day => 0.0625/hr),
    # which is a poor estimate at both edges.
    pooled_error_early = abs(pooled_rate - true_early_rate_per_hour)
    pooled_error_late = abs(pooled_rate - true_late_rate_per_hour)
    local_error_early = abs(early_local - true_early_rate_per_hour)
    local_error_late = abs(late_local - true_late_rate_per_hour)

    assert local_error_early < pooled_error_early
    assert local_error_late < pooled_error_late


def test_window_clips_to_span_bounds_near_the_edge() -> None:
    target_times = np.array([100, 200, 300], dtype=np.int64)
    span_start = 0
    span_end = 1000

    # A query point right at the span's start edge: the window would
    # naturally extend before span_start, and must clip rather than assume
    # unobserved history.
    at_time = np.array([0])
    rate = local_rate_per_hour(
        target_times, at_time, half_width_days=1000, span_start_ms=span_start, span_end_ms=span_end
    )
    # exposure is clipped to [0, 1000] regardless of the nominal half-width,
    # so this must not raise and must return a finite, non-negative rate.
    assert np.isfinite(rate[0])
    assert rate[0] >= 0


def test_zero_events_in_window_gives_zero_rate_not_nan() -> None:
    target_times = np.array([], dtype=np.int64)
    at_time = np.array([500])
    rate = local_rate_per_hour(
        target_times, at_time, half_width_days=10, span_start_ms=0, span_end_ms=1000
    )
    assert rate[0] == 0.0
