"""Phase extraction, checked against series whose answer is known analytically.

The point of a synthetic sinusoid here is that its extrema are known in closed
form, so the recovered phase can be compared against truth rather than against
another run of the same code. The grid-step test is the one that sets the
sampling used on real data.
"""

from __future__ import annotations

import numpy as np
import pytest

from terra_pulse_engine.pipeline.tidal_phase import (
    PhaseReference,
    batch_extrema,
    find_extrema,
    phase_degrees,
)

HOUR_MS = 3_600_000.0
M2_PERIOD_H = 12.4206  # principal lunar semidiurnal


def sinusoid(step_h: float, span_h: float, period_h: float, phase_offset_h: float = 0.0):
    times = np.arange(0.0, span_h, step_h) * HOUR_MS
    values = np.cos(2.0 * np.pi * (times / HOUR_MS - phase_offset_h) / period_h)
    return times, values


class TestFindExtrema:
    def test_recovers_the_period_of_a_pure_sinusoid(self):
        """Extrema of a semidiurnal sinusoid must sit half a period apart.

        The tolerance is 3.6 seconds, which is 0.03 degrees of a 12.42 h
        cycle — chosen as a bound on what matters (phase) rather than on what
        is measured (time). Observed on a 15-minute grid is about 0.3 s.
        """
        times, values = sinusoid(0.25, 24 * 40, M2_PERIOD_H)
        reference = find_extrema(times, values)
        gaps = np.diff(reference.times_ms) / HOUR_MS
        assert np.max(np.abs(gaps - M2_PERIOD_H / 2.0)) < 1e-3

    def test_maxima_and_minima_alternate_and_are_labelled_correctly(self):
        times, values = sinusoid(0.25, 24 * 10, M2_PERIOD_H)
        reference = find_extrema(times, values)
        flags = reference.is_max
        assert np.all(flags[:-1] != flags[1:]), "extrema must alternate"
        # A maximum of cos() sits at an integer number of periods from t=0.
        for time_ms, is_max in zip(reference.times_ms, flags, strict=True):
            cycles = (time_ms / HOUR_MS) / M2_PERIOD_H
            nearest = round(cycles)
            if is_max:
                assert cycles == pytest.approx(nearest, abs=1e-4)
            else:
                assert abs(cycles - nearest) == pytest.approx(0.5, abs=1e-4)

    def test_locates_extrema_far_better_than_the_sample_spacing(self):
        """Parabolic interpolation is what makes a coarse grid usable. Without
        it the error would be up to half a step — 30 minutes on an hourly grid,
        which is 14 degrees of a semidiurnal cycle."""
        # Offset so no extremum lands on a sample.
        times, values = sinusoid(1.0, 24 * 20, M2_PERIOD_H, phase_offset_h=0.37)
        reference = find_extrema(times, values)
        for time_ms, is_max in zip(reference.times_ms, reference.is_max, strict=True):
            hours = time_ms / HOUR_MS - 0.37
            cycles = hours / M2_PERIOD_H
            target = round(cycles) if is_max else round(cycles - 0.5) + 0.5
            error_h = abs(cycles - target) * M2_PERIOD_H
            assert error_h < 0.02, f"extremum off by {error_h * 60:.1f} minutes"

    def test_empty_when_the_series_never_turns(self):
        times = np.arange(0.0, 10.0) * HOUR_MS
        assert len(find_extrema(times, np.arange(10.0))) == 0


class TestPhaseDegrees:
    def test_zero_at_maxima_and_180_at_minima(self):
        times, values = sinusoid(0.25, 24 * 10, M2_PERIOD_H)
        reference = find_extrema(times, values)
        maxima = reference.times_ms[reference.is_max][1:-1]
        minima = reference.times_ms[~reference.is_max][1:-1]

        assert np.allclose(phase_degrees(reference, maxima), 0.0, atol=1e-6)
        assert np.allclose(np.abs(phase_degrees(reference, minima)), 180.0, atol=1e-6)

    def test_matches_the_analytic_phase_of_a_sinusoid(self):
        """For a single sinusoid the registered definition coincides with the
        ordinary phase of the cosine, so there is an exact answer to check."""
        times, values = sinusoid(0.25, 24 * 30, M2_PERIOD_H)
        reference = find_extrema(times, values)

        rng = np.random.default_rng(5)
        query = rng.uniform(times[40], times[-40], size=400)
        recovered = phase_degrees(reference, query)

        expected = (query / HOUR_MS) / M2_PERIOD_H * 360.0
        expected = (expected + 180.0) % 360.0 - 180.0
        difference = (recovered - expected + 180.0) % 360.0 - 180.0
        assert np.max(np.abs(difference)) < 0.05

    def test_hourly_sampling_is_accurate_enough_for_real_use(self):
        """Sets the grid step used against the real catalogue.

        An hourly grid is 44x cheaper than a one-minute one over fifty years.
        What it costs in phase accuracy is measured here rather than assumed:
        the tolerance below is the claim, and Schuster's statistic over
        thousands of events is untroubled by a fraction of a degree.
        """
        times, values = sinusoid(1.0, 24 * 60, M2_PERIOD_H, phase_offset_h=0.41)
        reference = find_extrema(times, values)

        rng = np.random.default_rng(9)
        query = rng.uniform(times[30], times[-30], size=2000)
        recovered = phase_degrees(reference, query)

        expected = ((query / HOUR_MS) - 0.41) / M2_PERIOD_H * 360.0
        expected = (expected + 180.0) % 360.0 - 180.0
        difference = (recovered - expected + 180.0) % 360.0 - 180.0
        assert np.max(np.abs(difference)) < 1.0

    def test_queries_outside_the_series_are_nan_not_extrapolated(self):
        times, values = sinusoid(0.25, 24 * 5, M2_PERIOD_H)
        reference = find_extrema(times, values)
        outside = np.array([times[0] - 10 * HOUR_MS, times[-1] + 10 * HOUR_MS])
        assert np.all(np.isnan(phase_degrees(reference, outside)))

    def test_degenerate_reference_yields_nan(self):
        empty = PhaseReference(np.empty(0), np.empty(0, dtype=bool))
        assert np.all(np.isnan(phase_degrees(empty, np.array([0.0, 1.0]))))


class TestBatchExtrema:
    """The batched path is an optimisation, so it is held to reproducing the
    single-series version rather than merely resembling it."""

    def _series(self, count: int, step_h: float):
        rng = np.random.default_rng(31)
        times = np.arange(0.0, 24 * 120, step_h) * HOUR_MS
        hours = times / HOUR_MS
        rows = []
        for _ in range(count):
            # A mixture, so the series has the mixed diurnal/semidiurnal shape
            # real tidal shear has — including the shallow turning points that
            # a single clean sinusoid would never produce.
            values = np.zeros_like(hours)
            for period, amp in ((M2_PERIOD_H, 1.0), (12.0, 0.46), (23.9345, 0.58), (25.8193, 0.42)):
                values += amp * rng.uniform(0.5, 1.5) * np.cos(
                    2 * np.pi * (hours - rng.uniform(0, period)) / period
                )
            rows.append(values)
        return times, np.array(rows)

    def test_matches_find_extrema_series_by_series(self):
        times, values = self._series(12, 0.5)
        batched = batch_extrema(times, values)
        for row, reference in zip(values, batched, strict=True):
            expected = find_extrema(times, row)
            assert len(reference) == len(expected)
            assert np.allclose(reference.times_ms, expected.times_ms, rtol=0, atol=1e-6)
            assert np.array_equal(reference.is_max, expected.is_max)

    def test_float32_input_agrees_with_float64(self):
        """The batched path runs in float32 at real scale. What that costs is
        pinned here: well under a tenth of a second of extremum time, which is
        4e-4 degrees of a semidiurnal cycle."""
        times, values = self._series(8, 1.0)
        wide = batch_extrema(times, values)
        narrow = batch_extrema(times, values.astype(np.float32))
        for a, b in zip(wide, narrow, strict=True):
            assert len(a) == len(b)
            assert np.max(np.abs(a.times_ms - b.times_ms)) < 100.0  # ms

    def test_phases_agree_with_the_reference_path(self):
        times, values = self._series(10, 1.0)
        rng = np.random.default_rng(77)
        query = rng.uniform(times[50], times[-50], size=1500)
        for row, reference in zip(values, batch_extrema(times, values), strict=True):
            a = phase_degrees(find_extrema(times, row), query)
            b = phase_degrees(reference, query)
            assert np.allclose(a, b, equal_nan=True, atol=1e-6)

    def test_rejects_a_single_series(self):
        times, values = self._series(1, 1.0)
        with pytest.raises(ValueError):
            batch_extrema(times, values[0])
