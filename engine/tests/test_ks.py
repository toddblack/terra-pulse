import numpy as np
from scipy import stats

from terra_pulse_engine.pipeline.ks import (
    DISTANCE_BIN_KM,
    MAX_DISTANCE_KM,
    bin_distances,
    cdf_from_counts,
    d_plus,
    distance_bin_edges,
    reference_cdf_all_pairs,
    two_sided_d,
)


def test_edges_span_the_antipodal_maximum():
    edges = distance_bin_edges()

    assert edges[0] == 0.0
    # The largest great-circle distance must fall inside the last bin, not past
    # the end — an event at the antipode itself would otherwise be dropped by
    # np.histogram, which is the one distance this hypothesis cares most about.
    assert edges[-1] >= MAX_DISTANCE_KM
    assert np.allclose(np.diff(edges), DISTANCE_BIN_KM)


def test_a_distance_at_the_antipodal_maximum_is_counted():
    counts = bin_distances(np.array([MAX_DISTANCE_KM]))

    assert counts.sum() == 1


def test_cdf_is_monotonic_and_reaches_one():
    counts = bin_distances(np.array([100.0, 5000.0, 5000.0, 19000.0]))
    cdf = cdf_from_counts(counts)

    assert np.all(np.diff(cdf) >= 0)
    assert cdf[-1] == 1.0


def test_empty_sample_gives_zeros_not_nan():
    # A trigger set whose windows catch nothing is a real possibility. NaN here
    # would silently never exceed the observed statistic in permutation_null's
    # comparison, turning a degenerate run into a confident p = 1.
    cdf = cdf_from_counts(np.zeros(10))

    assert np.all(cdf == 0.0)
    assert not np.any(np.isnan(cdf))


def test_d_plus_is_zero_when_the_distributions_match():
    cdf = cdf_from_counts(bin_distances(np.array([1000.0, 8000.0, 15000.0])))

    assert d_plus(cdf, cdf) == 0.0


def test_d_plus_detects_an_excess_at_short_distances():
    reference = cdf_from_counts(bin_distances(np.full(1000, 15000.0)))
    near = cdf_from_counts(bin_distances(np.full(1000, 200.0)))

    # Everything near versus everything far: the observed CDF rises to 1
    # immediately while the reference is still 0.
    assert d_plus(near, reference) > 0.99


def test_d_plus_is_floored_at_zero_for_a_deficit():
    # The opposite of the hypothesis — all observed events far, reference near.
    # D-plus must report 0, not a negative number, or permutation_null's
    # upper-tail comparison would rank "strongly contrary" above "unremarkable".
    reference = cdf_from_counts(bin_distances(np.full(1000, 200.0)))
    far = cdf_from_counts(bin_distances(np.full(1000, 15000.0)))

    assert d_plus(far, reference) == 0.0
    # The two-sided statistic still sees it, which is why it is reported.
    assert two_sided_d(far, reference) > 0.99


def test_d_plus_vectorises_across_a_batch():
    reference = cdf_from_counts(bin_distances(np.full(500, 10000.0)))
    batch = np.stack(
        [
            cdf_from_counts(bin_distances(np.full(500, 200.0))),
            cdf_from_counts(bin_distances(np.full(500, 10000.0))),
        ]
    )

    result = d_plus(batch, reference)

    assert result.shape == (2,)
    assert result[0] > 0.99
    assert result[1] == 0.0


def test_agrees_with_scipy_on_the_unbinned_limit():
    """The oracle, mirroring test_multiple_comparisons.py's scipy cross-check.

    scipy's `ks_2samp` compares two raw samples; this module compares two CDFs
    binned onto shared edges. They agree to within one bin width by
    construction, so the check uses samples placed at bin centres, where the
    binning is exact rather than approximate.

    **Scope of the oracle, stated rather than glossed:** scipy has no weighted
    or binned two-sample KS, so this validates the statistic's *arithmetic* on
    the degenerate case only. It does not validate the all-pairs reference,
    which has no scipy counterpart and is covered by its own tests below.
    """
    rng = np.random.default_rng(11)
    centre = DISTANCE_BIN_KM / 2
    a = rng.integers(0, 100, size=400) * DISTANCE_BIN_KM + centre
    b = rng.integers(0, 100, size=400) * DISTANCE_BIN_KM + centre

    mine = two_sided_d(cdf_from_counts(bin_distances(a)), cdf_from_counts(bin_distances(b)))
    theirs = stats.ks_2samp(a, b).statistic

    assert np.isclose(mine, theirs, atol=1e-12)


def test_agrees_with_scipy_on_the_one_sided_statistic():
    rng = np.random.default_rng(12)
    centre = DISTANCE_BIN_KM / 2
    a = rng.integers(0, 60, size=300) * DISTANCE_BIN_KM + centre
    b = rng.integers(20, 100, size=300) * DISTANCE_BIN_KM + centre

    mine = d_plus(cdf_from_counts(bin_distances(a)), cdf_from_counts(bin_distances(b)))
    # scipy's 'greater' alternative is defined as sup(F_a - F_b), the same
    # quantity — note scipy names the alternative for the *distribution*
    # ordering, which is the opposite of the sign convention one might guess.
    theirs = stats.ks_2samp(a, b, alternative="greater").statistic

    assert np.isclose(mine, theirs, atol=1e-12)


def test_reference_cdf_matches_a_brute_force_all_pairs_histogram():
    """The chunked accumulation must equal the obvious version exactly."""
    from terra_pulse_engine.pipeline.geo import haversine_km

    rng = np.random.default_rng(5)
    tlat = rng.uniform(-60, 60, size=37)
    tlon = rng.uniform(-180, 180, size=37)
    glat = rng.uniform(-60, 60, size=53)
    glon = rng.uniform(-180, 180, size=53)

    chunked = reference_cdf_all_pairs(tlat, tlon, glat, glon, chunk_size=8)

    brute = haversine_km(tlat[:, None], tlon[:, None], glat[None, :], glon[None, :]).ravel()
    expected = cdf_from_counts(bin_distances(brute))

    assert np.array_equal(chunked, expected)


def test_reference_cdf_is_chunk_size_independent():
    rng = np.random.default_rng(6)
    args = (
        rng.uniform(-60, 60, size=20),
        rng.uniform(-180, 180, size=20),
        rng.uniform(-60, 60, size=30),
        rng.uniform(-180, 180, size=30),
    )

    assert np.array_equal(
        reference_cdf_all_pairs(*args, chunk_size=1),
        reference_cdf_all_pairs(*args, chunk_size=1000),
    )


def test_reference_cdf_handles_empty_inputs():
    empty = np.array([], dtype=float)
    some = np.array([10.0, -20.0])

    assert np.all(reference_cdf_all_pairs(empty, empty, some, some) == 0.0)
    assert np.all(reference_cdf_all_pairs(some, some, empty, empty) == 0.0)
