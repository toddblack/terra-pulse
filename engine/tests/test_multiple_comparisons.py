import numpy as np
import pytest
from scipy import stats

from terra_pulse_engine.pipeline.multiple_comparisons import benjamini_hochberg


def test_hand_computable_example() -> None:
    # m=8, q=0.05 -> critical value at rank i is (i/8)*0.05 = 0.00625*i.
    # Sorted: 0.001<=0.00625 (ok), 0.008<=0.0125 (ok), 0.039>0.01875 (fails),
    # and every rank after that fails too (0.041>0.025, 0.09>0.03125, ...).
    # BH rejects up to the *largest* rank whose own p clears its own critical
    # value, which is rank 2 here -> exactly the 2 smallest are rejected.
    p_values = np.array([0.039, 0.7, 0.001, 0.09, 0.205, 0.008, 0.5, 0.041])
    result = benjamini_hochberg(p_values, q=0.05)

    assert result.rejected.sum() == 2
    assert result.rejected[p_values == 0.001][0]
    assert result.rejected[p_values == 0.008][0]
    assert not result.rejected[p_values == 0.039][0]


def test_adjusted_p_values_are_monotonic_in_the_raw_p_value() -> None:
    rng = np.random.default_rng(0)
    p_values = rng.uniform(0, 1, size=50)
    result = benjamini_hochberg(p_values, q=0.05)

    order = np.argsort(p_values)
    adjusted_in_order = result.p_adjusted[order]
    assert np.all(np.diff(adjusted_in_order) >= -1e-12)  # non-decreasing


def test_single_test_is_the_identity() -> None:
    result = benjamini_hochberg(np.array([0.03]), q=0.05)
    assert result.p_adjusted[0] == pytest.approx(0.03)
    assert result.rejected[0]


def test_q_boundary_is_inclusive() -> None:
    # A single test at exactly p == q should be rejected (<=, not <).
    result = benjamini_hochberg(np.array([0.05]), q=0.05)
    assert result.rejected[0]


def test_full_matrix_family_size_is_conservative() -> None:
    p_values = np.array([0.001, 0.01, 0.02, 0.03, 0.04, 0.048])
    within_run = benjamini_hochberg(p_values, q=0.05, family_size=len(p_values))
    full_matrix = benjamini_hochberg(p_values, q=0.05, family_size=19)

    assert np.all(full_matrix.p_adjusted >= within_run.p_adjusted - 1e-12)
    assert full_matrix.family_size == 19
    assert within_run.family_size == 6


def test_family_size_smaller_than_tests_run_is_rejected() -> None:
    with pytest.raises(ValueError):
        benjamini_hochberg(np.array([0.1, 0.2, 0.3]), q=0.05, family_size=2)


def test_agrees_with_scipy_false_discovery_control() -> None:
    rng = np.random.default_rng(123)
    p_values = rng.uniform(0, 1, size=25)

    ours = benjamini_hochberg(p_values, q=0.05)
    scipy_adjusted = stats.false_discovery_control(p_values, method="bh")

    np.testing.assert_allclose(ours.p_adjusted, scipy_adjusted, atol=1e-9)


def test_empty_input() -> None:
    result = benjamini_hochberg(np.zeros(0), q=0.05)
    assert result.tests_run == 0
    assert result.p_adjusted.shape == (0,)
