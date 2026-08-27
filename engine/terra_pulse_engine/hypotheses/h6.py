"""H6 — lunisolar tidal stress. Declustered M5.5+ mainshocks against the
distribution of tidal shear phase at their own hypocentres.

Assembly only; `pipeline/tides.py` holds the physics, `pipeline/tidal_phase.py`
turns a stress series into the registered phase angle, and
`pipeline/schuster.py` holds the statistic.

Two tests: all events, and subduction-zone events (within the registered 300 km
of a Slab2 trench).

-------------------------------------------------------------------------------
Why this hypothesis costs what it does
-------------------------------------------------------------------------------

Every hypothesis before this one reduces each trigger to a scalar — a time, a
hemisphere, a lag window. H6 cannot: the phase of an event depends on the shape
of a *time series* computed at its own hypocentre from its own fault geometry.
There are ~14,000 of those series and the null asks for each at 10,000 redrawn
instants, so the work is 14,000 x 444,000 grid points rather than 14,000 x 1.

Three things make that affordable, and all three are load-bearing:

1. **The whole chain from tidal tensor to resolved shear is linear**, so each
   event collapses to a 3x3 coefficient form and its entire series is one
   matrix product against a tensor grid shared by every event. Computing the
   grid once, in the Earth-fixed frame, is what makes the site rotation
   time-independent. See `tides.shear_coefficients`.
2. **The subduction subset is a subset**, so phases are computed once and both
   tests read the same numbers. Recomputing them per test would double the
   most expensive part of the run for no change in any result.
3. **Extrema are found in bulk, event-major, in float32.** See
   `tidal_phase.batch_extrema`.

Even so this is the slowest hypothesis here by a wide margin, which is why
main gives it its own timeout rather than the shared one.

-------------------------------------------------------------------------------
Order of operations that is easy to get backwards
-------------------------------------------------------------------------------

**Decluster first, then drop events with no orientation.** A dependent event
shadows its neighbours whether or not Global CMT inverted a mechanism for it,
so removing the unoriented ones first would let aftershocks survive as
"independent" and inflate the target set. The registration says "declustered
M5.5+ ... restricted to events carrying a CMT orientation", in that order.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

import numpy as np

from terra_pulse_engine.api.contracts import (
    AnalysisResult,
    CatalogInfo,
    CorrectionInfo,
    MethodInfo,
    NullHistogram,
    NullInfo,
    SpanInfo,
    TestResult,
    TidalRunRequest,
    TriggerInfo,
)
from terra_pulse_engine.pipeline.decluster import decluster_gardner_knopoff
from terra_pulse_engine.pipeline.geo import haversine_km
from terra_pulse_engine.pipeline.multiple_comparisons import benjamini_hochberg
from terra_pulse_engine.pipeline.schuster import phase_histogram, resultant
from terra_pulse_engine.pipeline.tidal_phase import batch_extrema, phase_degrees
from terra_pulse_engine.pipeline.tides import (
    GM_MOON,
    GM_SUN,
    SiteGeometry,
    shear_coefficients,
    tidal_tensor,
)
from terra_pulse_engine.version import ENGINE_VERSION

HOUR_MS = 3_600_000.0

# Running H6 completes the registered matrix: its two tests were the last
# deferred pair, and nothing is blocked (H4b was withdrawn unrun 2026-08-20).
DEFERRED_TESTS = 0
BLOCKED_TESTS = 0

COMPLETENESS_MODEL = (
    "None applied, and none needed. The null redraws origin instants only, keeping every "
    "hypocentre and mechanism exactly where the catalogue put them, so detection bias "
    "appears identically in the observed and null phase distributions and cancels. "
    "Orientation coverage varies by era, which is why the target floor is M5.5 rather "
    "than the M5.0 the other hypotheses use — see HYPOTHESES.md H6."
)


def _iso(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).isoformat().replace("+00:00", "Z")

# How many events share one pass over the tensor grid. Sized for memory, not
# speed: a batch holds (batch x grid) float32, which is 114 MB at 64 events
# against a 50-year hourly grid, on top of the ~560 MB draw matrix below.
EVENT_BATCH = 64


def _to_ms(iso: str) -> float:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000.0


def _tensor_grid(
    ephemeris_path: str, start_ms: float, end_ms: float, step_hours: float
) -> tuple[np.ndarray, np.ndarray]:
    """Earth-fixed lunisolar tidal tensors on a uniform grid.

    Returns `(times_ms, tensors)` with tensors flattened to (n, 9) float32 —
    float32 because this is only ever consumed by a matrix product whose
    result feeds extremum *location*, and the difference against float64 is
    4e-4 degrees of phase (pinned in `test_tidal_phase.py`).

    Imported lazily so the engine still starts, reports its version and serves
    every other hypothesis on an install where Skyfield is missing or the
    kernel has not been downloaded.
    """
    from skyfield.api import load, load_file
    from skyfield.framelib import itrs

    ephemeris = load_file(ephemeris_path)
    timescale = load.timescale()
    earth = ephemeris["earth"]
    bodies = ((GM_MOON, ephemeris["moon"]), (GM_SUN, ephemeris["sun"]))

    step_ms = step_hours * HOUR_MS
    count = int(np.ceil((end_ms - start_ms) / step_ms)) + 1
    times_ms = start_ms + np.arange(count, dtype=float) * step_ms

    epoch = datetime.fromtimestamp(start_ms / 1000.0, tz=timezone.utc)
    tensors = np.empty((count, 9), dtype=np.float32)

    # Chunked so the Skyfield call never holds the whole span's positions.
    chunk = 100_000
    for begin in range(0, count, chunk):
        stop = min(begin + chunk, count)
        offsets = np.arange(begin, stop, dtype=float) * step_hours
        instants = timescale.utc(
            epoch.year, epoch.month, epoch.day, epoch.hour + offsets, epoch.minute, epoch.second
        )
        total = np.zeros((stop - begin, 3, 3))
        for gm, body in bodies:
            xyz = (body - earth).at(instants).frame_xyz(itrs).m
            distance = np.linalg.norm(xyz, axis=0)
            total += tidal_tensor(gm, (xyz / distance).T, distance)
        tensors[begin:stop] = total.reshape(stop - begin, 9)

    return times_ms, tensors


def _near_trench(
    latitude: np.ndarray,
    longitude: np.ndarray,
    trench_lat: np.ndarray,
    trench_lon: np.ndarray,
    radius_km: float,
) -> np.ndarray:
    """Which events lie within `radius_km` of any trench vertex.

    Brute force, as `nearestFault` already is on the TypeScript side and for
    the same reason: ~14,000 events against a few thousand trench points is
    small enough that a spatial index would cost more to build than it saves.
    """
    near = np.zeros(latitude.size, dtype=bool)
    for index in range(latitude.size):
        distances = haversine_km(latitude[index], longitude[index], trench_lat, trench_lon)
        near[index] = bool(np.min(distances) <= radius_km)
    return near


def run_h6(request: TidalRunRequest) -> AnalysisResult:
    started = time.perf_counter()
    params = request.parameters
    catalog = request.catalog

    time_ms = np.asarray(catalog.time_ms, dtype=float)
    latitude = np.asarray(catalog.latitude, dtype=float)
    longitude = np.asarray(catalog.longitude, dtype=float)
    magnitude = np.asarray(catalog.magnitude, dtype=float)

    requested_start_ms = _to_ms(params.requested_start_utc)
    raw_count = int(time_ms.size)

    # --- target set -----------------------------------------------------------
    # Decluster over everything main sent (which reaches back past the
    # registered start for context), then restrict. Order matters — see the
    # module docstring.
    independent = decluster_gardner_knopoff(time_ms, latitude, longitude, magnitude)

    strike = np.array([np.nan if v is None else v for v in catalog.np1_strike])
    dip = np.array([np.nan if v is None else v for v in catalog.np1_dip])
    rake = np.array([np.nan if v is None else v for v in catalog.np1_rake])
    oriented = np.isfinite(strike) & np.isfinite(dip) & np.isfinite(rake)

    in_span = time_ms >= requested_start_ms
    selected = independent & oriented & in_span
    indices = np.nonzero(selected)[0]
    count = int(indices.size)

    if count == 0:
        raise ValueError("H6: no declustered, oriented events in the registered span")

    event_time = time_ms[indices]
    event_lat = latitude[indices]
    event_lon = longitude[indices]

    # --- subsets --------------------------------------------------------------
    subduction = _near_trench(
        event_lat,
        event_lon,
        np.asarray(request.trenches.latitude, dtype=float),
        np.asarray(request.trenches.longitude, dtype=float),
        params.subduction_radius_km,
    )

    # --- shared tensor grid ---------------------------------------------------
    # Padded by a day at each end so an event near a boundary still has extrema
    # on both sides of it; `phase_degrees` returns NaN rather than
    # extrapolating, and a silently-NaN edge event would shrink the target set
    # without saying so.
    pad_ms = 24 * HOUR_MS
    grid_times, grid_tensors = _tensor_grid(
        params.ephemeris_path,
        float(event_time.min()) - pad_ms,
        float(event_time.max()) + pad_ms,
        params.phase_grid_hours,
    )

    # --- the null's drawn instants -------------------------------------------
    # Every hour in the analysis span is eligible; the registered null redraws
    # `count` of them per iteration, without replacement.
    #
    # Held as one (count x iterations) int32 array — about 560 MB at real
    # scale, and the reason `EVENT_BATCH` is sized for memory. It cannot be
    # generated per batch: "without replacement" couples all events within an
    # iteration, so a batch's columns are not independently drawable.
    rng = np.random.default_rng(params.seed)
    pool_size = int(grid_times.size)
    eligible_hours = pool_size
    draw_index = np.empty((count, params.iterations), dtype=np.int32)
    for iteration in range(params.iterations):
        # `shuffle=True` (the default) matters and is not free: with
        # `shuffle=False` the sample comes back in ascending order, so event 0
        # would draw an early hour every single iteration and the pairing of
        # geometry to time would stop being random.
        draw_index[:, iteration] = rng.choice(pool_size, count, replace=False)

    # --- phases ---------------------------------------------------------------
    observed_phase = np.empty(count)
    null_vectors_all = np.zeros(params.iterations, dtype=complex)
    null_vectors_sub = np.zeros(params.iterations, dtype=complex)

    coefficients = np.empty((count, 9), dtype=np.float32)
    for position, index in enumerate(indices):
        coefficients[position] = shear_coefficients(
            SiteGeometry(
                latitude_deg=float(latitude[index]),
                longitude_deg=float(longitude[index]),
                strike_deg=float(strike[index]),
                dip_deg=float(dip[index]),
                rake_deg=float(rake[index]),
            )
        ).reshape(9)

    for begin in range(0, count, EVENT_BATCH):
        stop = min(begin + EVENT_BATCH, count)
        shear = coefficients[begin:stop] @ grid_tensors.T
        references = batch_extrema(grid_times, shear)

        for offset, reference in enumerate(references):
            position = begin + offset
            observed_phase[position] = phase_degrees(
                reference, np.array([event_time[position]])
            )[0]

            drawn = phase_degrees(reference, grid_times[draw_index[position]])
            # A NaN here means a drawn hour fell outside this event's extrema,
            # which the padding makes unreachable; contributing zero rather
            # than NaN keeps one bad event from erasing an entire iteration.
            unit = np.where(np.isfinite(drawn), np.exp(1j * np.radians(drawn)), 0.0)
            null_vectors_all += unit
            if subduction[position]:
                null_vectors_sub += unit

    # --- the two tests --------------------------------------------------------
    tests: list[TestResult] = []
    raw_p_values: list[float] = []
    subset_counts: list[tuple[str, int]] = []

    subsets = (
        ("all", np.ones(count, dtype=bool), null_vectors_all),
        ("subduction-zone", subduction, null_vectors_sub),
    )

    for subset_id, mask, null_vectors in subsets:
        phases = observed_phase[mask]
        observed = resultant(phases)
        null_lengths = np.abs(null_vectors)
        subset_counts.append((subset_id, int(np.count_nonzero(mask))))

        # One-sided upper: excess concentration at some phase. The +1/+1 is the
        # standard permutation correction — a p-value of exactly zero would
        # claim more resolution than 10,000 iterations carry.
        exceed = int(np.count_nonzero(null_lengths >= observed.resultant_length))
        p_raw = (exceed + 1) / (params.iterations + 1)
        raw_p_values.append(p_raw)

        # A degenerate subset gives `np.histogram` no range to cut 60 bins
        # across, and it raises rather than returning something empty. Two ways
        # in, and the second is not obvious:
        #   - an empty subset makes every null resultant exactly 0;
        #   - a **one-event** subset makes every one exactly 1, because the
        #     resultant of a single unit vector is a unit vector whatever its
        #     phase. That range is not zero, it is ~4e-16 wide from floating
        #     point, which still collapses the bin edges onto each other.
        # Widening keeps the response shape intact so the caveats can explain
        # the degeneracy, instead of the run dying inside numpy with an error
        # that says nothing about the cause.
        low = float(np.min(null_lengths)) if null_lengths.size else 0.0
        high = float(np.max(null_lengths)) if null_lengths.size else 0.0
        if not (high - low) > max(1e-9, abs(low) * 1e-9):
            high = low + 1.0
        counts, edges = np.histogram(null_lengths, bins=60, range=(low, high))
        tests.append(
            TestResult(
                id=f"H6/{subset_id}",
                trigger_id=subset_id,
                # H6 has no lag window — phase is measured at the origin instant
                # itself. Zero-width rather than an invented span.
                lag_hours=(0.0, 0.0),
                # `observed` is the sample size, as in H5: the statistic is a
                # concentration, not a count being compared to an expectation.
                # `ratio` carries R, because that is the field the UI draws its
                # null-histogram guide line from.
                observed=int(np.count_nonzero(mask)),
                observed_label="Events",
                expected=float(np.mean(null_lengths)),
                expected_label="Mean null R",
                ratio=float(observed.resultant_length),
                statistic_label="Schuster R",
                p_raw=p_raw,
                p_adjusted_within_run=1.0,
                p_adjusted_full_matrix=1.0,
                rejected_at_q=False,
                preferred_phase_deg=(
                    None
                    if not np.isfinite(observed.preferred_phase_deg)
                    else round(observed.preferred_phase_deg, 2)
                ),
                phase_histogram=[int(c) for c in phase_histogram(phases, params.phase_bins)],
                null=NullInfo(
                    mean=float(np.mean(null_lengths)),
                    sd=float(np.std(null_lengths)),
                    quantiles={
                        "p50": float(np.percentile(null_lengths, 50)),
                        "p95": float(np.percentile(null_lengths, 95)),
                        "p99": float(np.percentile(null_lengths, 99)),
                    },
                    histogram=NullHistogram(
                        edges=[float(e) for e in edges],
                        counts=[int(c) for c in counts],
                    ),
                ),
            )
        )

    within_run = benjamini_hochberg(np.array(raw_p_values), params.q)
    full_matrix = benjamini_hochberg(
        np.array(raw_p_values), params.q, family_size=params.registered_matrix_tests
    )
    for index, test in enumerate(tests):
        test.p_adjusted_within_run = float(within_run.p_adjusted[index])
        test.p_adjusted_full_matrix = float(full_matrix.p_adjusted[index])
        test.rejected_at_q = bool(full_matrix.rejected[index])

    caveats = _caveats(count, raw_count, subset_counts, observed_phase)

    return AnalysisResult(
        contract_version=request.contract_version,
        engine_version=ENGINE_VERSION,
        hypothesis_id="H6",
        run_at_utc=_iso(time.time() * 1000),
        duration_ms=int((time.perf_counter() - started) * 1000),
        seed=params.seed,
        span=SpanInfo(
            requested_start_utc=params.requested_start_utc,
            used_start_utc=_iso(float(event_time.min())),
            used_end_utc=_iso(float(event_time.max())),
            truncation_reason=None,
        ),
        catalog=CatalogInfo(
            min_magnitude=params.target_min_magnitude,
            raw_count=raw_count,
            declustered_count=count,
            declustering=params.declustering,
        ),
        triggers=[
            TriggerInfo(id=subset_id, count=subset_count, eligible_hours=eligible_hours)
            for subset_id, subset_count in subset_counts
        ],
        tests=tests,
        correction=CorrectionInfo(
            method="benjamini-hochberg",
            q=params.q,
            tests_run=len(tests),
            registered_matrix_tests=params.registered_matrix_tests,
            deferred_tests=DEFERRED_TESTS,
            blocked_tests=BLOCKED_TESTS,
            partial_matrix=len(tests) < params.registered_matrix_tests,
            note=(
                f"{len(tests)} of {params.registered_matrix_tests} registered tests were run "
                "in this session. Adjusted p-values are reported both within this run and "
                "against the full registered matrix; the full-matrix figure is the "
                "conservative one."
            ),
        ),
        method=MethodInfo(
            null_model=params.null_model,
            tail=params.tail,
            iterations=params.iterations,
            completeness_model=COMPLETENESS_MODEL,
        ),
        caveats=caveats,
    )


def _caveats(
    count: int,
    raw_count: int,
    subset_counts: list[tuple[str, int]],
    observed_phase: np.ndarray,
) -> list[str]:
    """What a reader must know before believing either number.

    The first two are physical simplifications in the stress calculation. They
    are not fixable by running longer, and they belong beside the result rather
    than in a source comment nobody reading a table will open.
    """
    caveats = [
        "Ocean tide loading is NOT included — only the solid-Earth body tide is computed. "
        "Loading is comparable to the body tide near coasts, which is where subduction "
        "earthquakes are, and it shifts phase rather than only amplitude. This is the "
        "largest physical simplification in this test, and the main respect in which it "
        "is weaker than Tanaka, Ohtake & Sato (2002), which corrected for it.",
        "Tidal stress is evaluated under a free-surface (plane-stress) condition at the "
        "hypocentre's coordinates. That is accurate for shallow events and degrades with "
        "depth, so deep events are the weakest part of the calculation.",
        "Shear stress is resolved onto Global CMT's nodal plane 1 only. That is exact "
        "rather than an approximation: resolved shear is identical on conjugate planes, "
        "which is precisely why the registration chose shear over Coulomb stress.",
        f"{count:,} of {raw_count:,} supplied events survived declustering, fell inside the "
        "registered span, and carry a Global CMT orientation. Events with no matched "
        "mechanism are excluded — about 10% overall, but era-dependent; see HYPOTHESES.md "
        "H6 for the per-era coverage table.",
    ]

    uncomputable = int(np.count_nonzero(~np.isfinite(observed_phase)))
    if uncomputable:
        caveats.append(
            f"{uncomputable:,} events had no computable tidal phase and were dropped from "
            "the statistic."
        )

    for subset_id, subset_count in subset_counts:
        if subset_count == 0:
            caveats.insert(
                0,
                f"NO EVENTS in the '{subset_id}' subset — its statistic and p-value below "
                "are degenerate, not a null result.",
            )
        elif subset_count < 500:
            caveats.append(
                f"The '{subset_id}' subset holds only {subset_count:,} events, too few to "
                "resolve the few-percent modulation this hypothesis is looking for."
            )
    return caveats
