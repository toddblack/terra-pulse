"""Schuster's resultant, checked against cases with known answers."""

from __future__ import annotations

import numpy as np
import pytest

from terra_pulse_engine.pipeline.schuster import (
    phase_histogram,
    resultant,
    resultant_lengths,
    schuster_p_value,
)


class TestResultant:
    def test_perfectly_aligned_phases_give_r_equal_to_n(self):
        result = resultant(np.full(500, 42.0))
        assert result.resultant_length == pytest.approx(500.0)
        assert result.mean_resultant_length == pytest.approx(1.0)
        assert result.preferred_phase_deg == pytest.approx(42.0)

    def test_evenly_spread_phases_cancel(self):
        spread = np.linspace(-180.0, 180.0, 360, endpoint=False)
        assert resultant(spread).resultant_length == pytest.approx(0.0, abs=1e-9)

    def test_opposed_pairs_cancel(self):
        result = resultant(np.array([0.0, 180.0, 90.0, -90.0]))
        assert result.resultant_length == pytest.approx(0.0, abs=1e-12)

    def test_uniform_random_phases_sit_near_the_rayleigh_expectation(self):
        """Under the null E[R] ~ sqrt(pi*N)/2. This is the sanity check that
        the statistic is on the scale the analytic p-value assumes."""
        rng = np.random.default_rng(4)
        lengths = [resultant(rng.uniform(-180, 180, 2000)).resultant_length for _ in range(300)]
        expected = np.sqrt(np.pi * 2000) / 2.0
        assert np.mean(lengths) == pytest.approx(expected, rel=0.05)

    def test_nan_phases_are_dropped_not_propagated(self):
        """An event whose phase could not be computed must not zero the sum."""
        phases = np.array([10.0, np.nan, 10.0, np.nan])
        result = resultant(phases)
        assert result.count == 2
        assert result.resultant_length == pytest.approx(2.0)

    def test_empty_input_is_a_zero_resultant_not_a_crash(self):
        result = resultant(np.array([]))
        assert result.count == 0
        assert result.resultant_length == 0.0
        assert np.isnan(result.preferred_phase_deg)


class TestVectorisedResultant:
    def test_matches_the_scalar_version_row_by_row(self):
        rng = np.random.default_rng(17)
        batch = rng.uniform(-180, 180, size=(64, 250))
        vectorised = resultant_lengths(batch)
        for row, value in zip(batch, vectorised, strict=True):
            assert value == pytest.approx(resultant(row).resultant_length, rel=1e-12)


class TestAnalyticPValue:
    def test_rayleigh_tail_matches_simulation_for_uniform_phases(self):
        """The analytic formula is only used as a diagnostic, so it is worth
        confirming it is right — a disagreement with the Monte Carlo value
        should mean the *pool* is aliasing, not that this is broken."""
        rng = np.random.default_rng(21)
        n = 800
        lengths = resultant_lengths(rng.uniform(-180, 180, size=(20_000, n)))
        for threshold in (20.0, 30.0, 45.0):
            simulated = float(np.mean(lengths >= threshold))
            assert simulated == pytest.approx(schuster_p_value(threshold, n), abs=0.015)

    def test_a_planted_concentration_is_detected(self):
        rng = np.random.default_rng(2)
        # 5% of events pushed toward 60 degrees, the rest uniform.
        n = 4000
        phases = rng.uniform(-180, 180, n)
        phases[: n // 20] = rng.normal(60.0, 10.0, n // 20)
        assert schuster_p_value(resultant(phases).resultant_length, n) < 0.01


class TestHistogram:
    def test_twelve_bins_of_thirty_degrees(self):
        counts = phase_histogram(np.array([-179.0, -1.0, 1.0, 179.0]))
        assert counts.size == 12
        assert counts.sum() == 4
        assert counts[0] == 1  # -180..-150
        assert counts[5] == 1  # -30..0
        assert counts[6] == 1  # 0..30
        assert counts[11] == 1  # 150..180

    def test_ignores_uncomputable_phases(self):
        assert phase_histogram(np.array([0.0, np.nan])).sum() == 1
