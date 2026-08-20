"""One-sided Kolmogorov-Smirnov statistic over a binned reference CDF.

H5's test statistic, and the first in this engine that is not a rate ratio.
`engine/README.md` says a new pipeline module is warranted only for a
genuinely new *kind* of statistic; a supremum-of-CDF-difference is one.

## Why binned rather than the textbook two-sample form

The textbook `ks_2samp` compares two raw samples by sorting their union. H5's
reference sample is the all-pairs distance distribution — every declustered
M6.0+ trigger antipode against every declustered M5.0+ target — which is
~10^8 pairs on the real catalogue. That is cheap to *accumulate* into a
histogram and impossible to hold as a sample.

Binning makes the reference a fixed step function evaluated once, after which
each of the 10,000 permutation draws costs one `np.searchsorted` rather than a
re-sort. The bin width is a registered parameter (`DISTANCE_BIN_KM`), not a
tuning knob discovered later: at 100 km over a 0-20,020 km domain the reference
has ~201 steps, which is far finer than the distance resolution any of this
data supports (epicentres carry location error of order 10 km, and the
narrowest feature the hypothesis predicts — the antipodal focus — is a few
degrees wide, i.e. hundreds of km).

## Why one-sided

HYPOTHESES.md H5 registers D-plus: the maximum amount by which the observed
CDF *exceeds* the reference. An excess of events at short distances pushes the
observed CDF up at small distances, so D-plus is the directional statistic
matching the registered statement. The two-sided D is computed alongside for
description only and is never the test — see `two_sided_d`.
"""

from __future__ import annotations

import numpy as np

# Half the Earth's circumference, the largest possible great-circle distance.
MAX_DISTANCE_KM = 20015.087

# Registered bin width for the reference CDF. See the module note: chosen for
# being far finer than the data's own resolution, not tuned against a result.
DISTANCE_BIN_KM = 100.0


def distance_bin_edges(bin_km: float = DISTANCE_BIN_KM) -> np.ndarray:
    """Fixed, shared bin edges from 0 to the antipodal maximum.

    Every CDF in this module is evaluated on these edges, so the observed,
    reference and permutation CDFs are directly comparable without any
    interpolation.
    """
    n_bins = int(np.ceil(MAX_DISTANCE_KM / bin_km))
    return np.arange(n_bins + 1, dtype=float) * bin_km


def cdf_from_counts(counts: np.ndarray) -> np.ndarray:
    """Normalised cumulative distribution from per-bin counts.

    Returns zeros when the sample is empty rather than dividing by zero — an
    empty observed set is a real possibility (a trigger set whose windows catch
    nothing) and must not produce NaN, which would silently never exceed the
    observed statistic in `permutation_null`'s comparison.
    """
    total = counts.sum(axis=-1, keepdims=True)
    cumulative = np.cumsum(counts, axis=-1)
    return np.divide(cumulative, total, out=np.zeros_like(cumulative, dtype=float), where=total > 0)


def bin_distances(distances: np.ndarray, bin_km: float = DISTANCE_BIN_KM) -> np.ndarray:
    """Per-bin counts for one sample of distances."""
    edges = distance_bin_edges(bin_km)
    counts, _ = np.histogram(distances, bins=edges)
    return counts.astype(float)


def d_plus(observed_cdf: np.ndarray, reference_cdf: np.ndarray) -> np.ndarray:
    """One-sided KS statistic: max(observed - reference), floored at zero.

    Vectorised over any leading batch dimension — pass a (batch, bins) array of
    observed CDFs against a single (bins,) reference and get (batch,) back,
    which is what the permutation loop needs.

    Floored at zero because D-plus is defined as a supremum of a *positive*
    part: an observed CDF that sits entirely below the reference (a deficit at
    short distances) is not evidence for the registered directional claim, and
    reporting a negative statistic would let `permutation_null`'s upper-tail
    comparison treat "strongly opposite to the hypothesis" as merely unremarkable
    rather than as the zero it should be.
    """
    return np.maximum(np.max(observed_cdf - reference_cdf, axis=-1), 0.0)


def two_sided_d(observed_cdf: np.ndarray, reference_cdf: np.ndarray) -> np.ndarray:
    """The conventional two-sided KS D. **Descriptive only for H5** — the
    registered statistic is `d_plus`. Kept so the reported result can say how
    much of the deviation is directional without running a second test.
    """
    return np.max(np.abs(observed_cdf - reference_cdf), axis=-1)


def reference_cdf_all_pairs(
    trigger_antipode_lat: np.ndarray,
    trigger_antipode_lon: np.ndarray,
    target_lat: np.ndarray,
    target_lon: np.ndarray,
    *,
    bin_km: float = DISTANCE_BIN_KM,
    chunk_size: int = 64,
) -> np.ndarray:
    """The null distance distribution, as a binned CDF.

    Under the registered null every trigger instant is redrawn uniformly, so a
    given target is equally likely to fall inside any trigger's window
    regardless of where either sits. The null distance distribution is
    therefore the **all-pairs** distribution of distance(trigger antipode,
    target) — which can be computed exactly, once, rather than estimated from
    the permutation draws.

    Accumulated chunk-by-chunk into a histogram: the full pair matrix on the
    real catalogue is ~4,000 x 26,000 doubles (about 800 MB), while a chunk of
    64 triggers is ~13 MB and the histogram it folds into is 201 floats. The
    result is identical either way; only the peak memory differs.

    This is the piece that carries the completeness weighting, and it does so by
    construction: the targets are real recorded events, so a region the network
    cannot see contributes nothing to the reference for exactly the same reason
    it contributes nothing to the observed set.
    """
    from terra_pulse_engine.pipeline.geo import haversine_km

    edges = distance_bin_edges(bin_km)
    counts = np.zeros(edges.shape[0] - 1, dtype=float)

    if trigger_antipode_lat.size == 0 or target_lat.size == 0:
        return cdf_from_counts(counts)

    for start in range(0, trigger_antipode_lat.shape[0], chunk_size):
        stop = start + chunk_size
        distances = haversine_km(
            trigger_antipode_lat[start:stop, None],
            trigger_antipode_lon[start:stop, None],
            target_lat[None, :],
            target_lon[None, :],
        )
        chunk_counts, _ = np.histogram(distances, bins=edges)
        counts += chunk_counts

    return cdf_from_counts(counts)
