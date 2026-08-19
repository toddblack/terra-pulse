import numpy as np
import pytest

from terra_pulse_engine.pipeline.monte_carlo import CircularShift, UniformRedraw, permutation_null


def _constant_draw_fn(value: float):
    def draw(rng: np.random.Generator, batch_size: int) -> np.ndarray:
        return np.zeros((batch_size, 1))

    return draw


def _identity_statistic_fn(offset: float = 0.0):
    def statistic_fn(drawn: np.ndarray) -> np.ndarray:
        rng_values = np.random.default_rng(0)
        return rng_values.normal(loc=offset, scale=1.0, size=drawn.shape[0])

    return statistic_fn


def test_p_value_is_never_exactly_zero() -> None:
    # An observed statistic far beyond anything the null could produce.
    result = permutation_null(
        observed_statistic=1000.0,
        draw_fn=_constant_draw_fn(0.0),
        statistic_fn=_identity_statistic_fn(offset=0.0),
        iterations=200,
        chunk_size=50,
        seed=1,
        tail="upper",
    )
    assert result.p_value > 0.0
    assert result.p_value == pytest.approx(1 / 201)


def test_deterministic_given_same_seed() -> None:
    kwargs = dict(
        observed_statistic=0.5,
        draw_fn=_constant_draw_fn(0.0),
        statistic_fn=_identity_statistic_fn(offset=0.0),
        iterations=500,
        chunk_size=100,
        seed=42,
        tail="upper",
    )
    result_a = permutation_null(**kwargs)
    result_b = permutation_null(**kwargs)
    assert result_a.p_value == result_b.p_value
    assert result_a.null.mean == result_b.null.mean


def test_chunk_size_does_not_change_the_result() -> None:
    # Chunking is purely a memory-management detail (PROJECT_PLAN.md §7.5) —
    # it must not change which draws happen, given the same seed and total
    # iteration count, drawn from a generator whose output only depends on
    # how many numbers have been consumed so far.
    def draw_fn(rng: np.random.Generator, batch_size: int) -> np.ndarray:
        return rng.normal(size=(batch_size, 1))

    def statistic_fn(drawn: np.ndarray) -> np.ndarray:
        return drawn[:, 0]

    common = dict(
        observed_statistic=0.3,
        draw_fn=draw_fn,
        statistic_fn=statistic_fn,
        iterations=1000,
        seed=7,
        tail="upper",
    )
    small_chunks = permutation_null(chunk_size=10, **common)
    large_chunks = permutation_null(chunk_size=1000, **common)

    assert small_chunks.p_value == large_chunks.p_value
    assert small_chunks.null.mean == pytest.approx(large_chunks.null.mean)


def test_planted_excess_yields_a_small_p_value() -> None:
    def draw_fn(rng: np.random.Generator, batch_size: int) -> np.ndarray:
        return rng.normal(loc=0.0, scale=1.0, size=(batch_size, 1))

    def statistic_fn(drawn: np.ndarray) -> np.ndarray:
        return drawn[:, 0]

    result = permutation_null(
        observed_statistic=6.0,  # 6 sigma above a standard-normal null
        draw_fn=draw_fn,
        statistic_fn=statistic_fn,
        iterations=2000,
        chunk_size=200,
        seed=3,
        tail="upper",
    )
    assert result.p_value < 0.01


@pytest.mark.slow
def test_pure_noise_generator_gives_roughly_uniform_p_across_many_runs() -> None:
    # Calibration check: if the observed statistic is itself drawn from the
    # same null distribution, p-values across many independent runs should
    # be roughly uniform on (0, 1] — no systematic bias toward significance.
    rng = np.random.default_rng(99)

    def draw_fn(inner_rng: np.random.Generator, batch_size: int) -> np.ndarray:
        return inner_rng.normal(size=(batch_size, 1))

    def statistic_fn(drawn: np.ndarray) -> np.ndarray:
        return drawn[:, 0]

    p_values = []
    for i in range(200):
        observed = rng.normal()
        result = permutation_null(
            observed_statistic=observed,
            draw_fn=draw_fn,
            statistic_fn=statistic_fn,
            iterations=500,
            chunk_size=500,
            seed=1000 + i,
            tail="upper",
        )
        p_values.append(result.p_value)

    # Roughly uniform: about half should be below 0.5, generously bounded.
    fraction_below_half = np.mean(np.array(p_values) < 0.5)
    assert 0.3 < fraction_below_half < 0.7


def test_histogram_never_materializes_more_than_requested_bins() -> None:
    def draw_fn(rng: np.random.Generator, batch_size: int) -> np.ndarray:
        return rng.normal(size=(batch_size, 1))

    def statistic_fn(drawn: np.ndarray) -> np.ndarray:
        return drawn[:, 0]

    result = permutation_null(
        observed_statistic=0.0,
        draw_fn=draw_fn,
        statistic_fn=statistic_fn,
        iterations=300,
        chunk_size=50,
        seed=5,
        tail="upper",
        histogram_bins=20,
    )
    assert len(result.null.histogram_counts) == 20
    assert len(result.null.histogram_edges) == 21
    assert sum(result.null.histogram_counts) == 300


def test_circular_shift_is_explicitly_not_implemented() -> None:
    with pytest.raises(NotImplementedError):
        CircularShift().draw(np.random.default_rng(0), 10)


def test_uniform_redraw_draws_without_replacement() -> None:
    eligible = np.arange(100, dtype=np.int64)
    model = UniformRedraw(eligible, n_triggers=10)
    rng = np.random.default_rng(0)
    drawn = model.draw(rng, batch_size=5)

    assert drawn.shape == (5, 10)
    for row in drawn:
        assert len(set(row.tolist())) == 10  # no duplicates within a draw


def test_uniform_redraw_rejects_more_triggers_than_eligible_hours() -> None:
    eligible = np.arange(5, dtype=np.int64)
    with pytest.raises(ValueError):
        UniformRedraw(eligible, n_triggers=10)
