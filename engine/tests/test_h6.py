"""H6 end to end.

These need a real JPL kernel and are skipped without one — H6's whole point is
DE440 positions, so a fixture standing in for the ephemeris would be testing
something other than the hypothesis. Point `TERRA_PULSE_TEST_EPHEMERIS` at a
`de440s.bsp` to run them; `engine/README.md` says where the app keeps one.

The planted-signal test is the one that matters. Every other test here could
pass on a pipeline that computes phase wrongly but *consistently* — that one
fails if any link between ephemeris and phase is broken, because it places each
event at a known tidal phase **at that event's own site** and asks whether they
are found there.

Events are scattered across the globe with their own fault geometries rather
than sharing one site, and that is not incidental realism: co-located M6
events fall inside each other's Gardner-Knopoff windows, so a fixture built at
a single point declusters down to a handful and the statistic has nothing to
work with. A first draft of this file did exactly that.
"""

from __future__ import annotations

import os

import numpy as np
import pytest

from terra_pulse_engine.api.contracts import (
    OrientedCatalogPayload,
    TidalParameters,
    TidalRunRequest,
    TrenchPayload,
)
from terra_pulse_engine.hypotheses.h6 import run_h6
from terra_pulse_engine.pipeline.tidal_phase import batch_extrema, phase_degrees
from terra_pulse_engine.pipeline.tides import SiteGeometry, shear_coefficients

KERNEL = os.environ.get("TERRA_PULSE_TEST_EPHEMERIS")
needs_kernel = pytest.mark.skipif(
    not KERNEL or not os.path.exists(KERNEL),
    reason="set TERRA_PULSE_TEST_EPHEMERIS to a de440s.bsp to run H6 end to end",
)

HOUR_MS = 3_600_000.0
START_MS = 189_302_400_000.0  # 1976-01-01T00:00:00Z
SPAN_HOURS = 24 * 365 * 3


def _sites(count: int, seed: int) -> list[SiteGeometry]:
    """Scattered globally, so Gardner-Knopoff leaves them alone."""
    rng = np.random.default_rng(seed)
    return [
        SiteGeometry(
            latitude_deg=float(rng.uniform(-60, 60)),
            longitude_deg=float(rng.uniform(-180, 180)),
            strike_deg=float(rng.uniform(0, 360)),
            dip_deg=float(rng.uniform(10, 85)),
            rake_deg=float(rng.uniform(-180, 180)),
        )
        for _ in range(count)
    ]


def _far_from_all(sites: list[SiteGeometry], seed: int, margin_km: float = 600.0):
    """A coordinate more than `margin_km` from every site, found by search."""
    from terra_pulse_engine.pipeline.geo import haversine_km

    latitudes = np.array([s.latitude_deg for s in sites])
    longitudes = np.array([s.longitude_deg for s in sites])
    rng = np.random.default_rng(seed)
    for _ in range(5000):
        lat = float(rng.uniform(-80, 80))
        lon = float(rng.uniform(-180, 180))
        if np.min(haversine_km(lat, lon, latitudes, longitudes)) > margin_km:
            return lat, lon
    raise AssertionError("could not find a coordinate away from every site")


def _phase_grid(sites: list[SiteGeometry]) -> tuple[np.ndarray, np.ndarray]:
    """Hourly phase for every site — `(times_ms, phase[site, hour])`."""
    from skyfield.api import load, load_file
    from skyfield.framelib import itrs

    from terra_pulse_engine.pipeline.tides import GM_MOON, GM_SUN, tidal_tensor

    ephemeris = load_file(KERNEL)
    timescale = load.timescale()
    earth = ephemeris["earth"]

    hours = np.arange(SPAN_HOURS, dtype=float)
    instants = timescale.utc(1976, 1, 1, hours)
    total = np.zeros((SPAN_HOURS, 3, 3))
    for gm, body in ((GM_MOON, ephemeris["moon"]), (GM_SUN, ephemeris["sun"])):
        xyz = (body - earth).at(instants).frame_xyz(itrs).m
        distance = np.linalg.norm(xyz, axis=0)
        total += tidal_tensor(gm, (xyz / distance).T, distance)

    times = START_MS + hours * HOUR_MS
    tensors = total.reshape(SPAN_HOURS, 9).astype(np.float32)
    coefficients = np.array([shear_coefficients(s).reshape(9) for s in sites], dtype=np.float32)
    shear = coefficients @ tensors.T

    phase = np.empty(shear.shape)
    for index, reference in enumerate(batch_extrema(times, shear)):
        phase[index] = phase_degrees(reference, times)
    return times, phase


def _request(
    sites: list[SiteGeometry],
    times_ms: np.ndarray,
    *,
    iterations: int = 400,
    seed: int = 1,
    trenches: TrenchPayload | None = None,
) -> TidalRunRequest:
    order = np.argsort(times_ms)
    ordered_sites = [sites[i] for i in order]
    return TidalRunRequest(
        contractVersion=1,
        hypothesisId="H6",
        parameters=TidalParameters(
            targetMinMagnitude=5.5,
            declustering="gardner-knopoff",
            nullModel="uniform-redraw",
            tail="upper",
            ephemerisPath=KERNEL,
            phaseGridHours=1.0,
            phaseBins=12,
            subductionRadiusKm=300.0,
            iterations=iterations,
            seed=seed,
            q=0.05,
            requestedStartUtc="1976-01-01T00:00:00Z",
            registeredMatrixTests=19,
        ),
        catalog=OrientedCatalogPayload(
            timeMs=[int(t) for t in times_ms[order]],
            latitude=[s.latitude_deg for s in ordered_sites],
            longitude=[s.longitude_deg for s in ordered_sites],
            magnitude=[6.0] * len(ordered_sites),
            np1Strike=[s.strike_deg for s in ordered_sites],
            np1Dip=[s.dip_deg for s in ordered_sites],
            np1Rake=[s.rake_deg for s in ordered_sites],
        ),
        # By default one trench point in the mid-Atlantic, far from everything,
        # so the subduction subset is empty and the "all" test is the subject.
        trenches=trenches or TrenchPayload(latitude=[0.0], longitude=[-25.0]),
    )


class TestContract:
    def test_partial_mechanisms_are_rejected(self):
        """All three angles come from one NDK record, so a row carrying some of
        them is a join bug rather than a missing value."""
        with pytest.raises(ValueError, match="present together"):
            OrientedCatalogPayload(
                timeMs=[int(START_MS)],
                latitude=[0.0],
                longitude=[0.0],
                magnitude=[6.0],
                np1Strike=[10.0],
                np1Dip=[None],
                np1Rake=[20.0],
            )

    def test_fully_absent_mechanisms_are_allowed(self):
        payload = OrientedCatalogPayload(
            timeMs=[int(START_MS)],
            latitude=[0.0],
            longitude=[0.0],
            magnitude=[6.0],
            np1Strike=[None],
            np1Dip=[None],
            np1Rake=[None],
        )
        assert payload.np1_strike == [None]


@needs_kernel
class TestEndToEnd:
    def test_events_planted_at_one_tidal_phase_are_detected(self):
        """The test that fails if any link in the chain is wrong.

        Each event is placed at an hour whose phase is near zero **at its own
        site** — a different instant for every event, since the sites are
        scattered. Only a pipeline that agrees with the planting about what
        phase means at a given place and time recovers the concentration.
        """
        sites = _sites(700, seed=4)
        times, phase = _phase_grid(sites)

        chosen = np.empty(len(sites))
        rng = np.random.default_rng(99)
        for index in range(len(sites)):
            candidates = np.nonzero(np.abs(phase[index]) < 10.0)[0]
            chosen[index] = times[rng.choice(candidates)]

        result = run_h6(_request(sites, chosen))
        overall = {test.id: test for test in result.tests}["H6/all"]

        assert overall.observed > 600, "declustering should leave scattered events alone"
        # R/N near 1 means near-perfect alignment; a 20-degree window keeps it high.
        assert overall.ratio / overall.observed > 0.9
        assert overall.p_raw < 0.01
        assert overall.rejected_at_q

    def test_uniformly_timed_events_do_not_concentrate(self):
        """The complement: nothing planted, so nothing found. A pipeline that
        manufactures a preferred phase — by aliasing the hourly draw pool
        against the 12.000 h solar constituent, say — fails here rather than at
        the end of a real run."""
        sites = _sites(700, seed=5)
        rng = np.random.default_rng(12)
        times = START_MS + rng.integers(0, SPAN_HOURS, size=len(sites)) * HOUR_MS

        result = run_h6(_request(sites, times.astype(float)))
        overall = {test.id: test for test in result.tests}["H6/all"]

        assert overall.p_raw > 0.02
        assert overall.ratio / overall.observed < 0.15

    def test_reports_both_subsets_and_a_complete_matrix(self):
        sites = _sites(300, seed=6)
        rng = np.random.default_rng(3)
        times = START_MS + rng.integers(0, SPAN_HOURS, size=len(sites)) * HOUR_MS

        result = run_h6(_request(sites, times.astype(float)))

        assert [test.id for test in result.tests] == ["H6/all", "H6/subduction-zone"]
        assert result.correction.registered_matrix_tests == 19
        # H6 was the last deferred pair; running it leaves nothing deferred.
        assert result.correction.deferred_tests == 0
        assert result.correction.blocked_tests == 0
        assert result.method.completeness_model is not None
        assert result.method.baseline_window_days is None
        assert result.method.spatial_split_degrees is None

    def test_an_empty_subset_says_so_rather_than_reporting_a_null(self):
        sites = _sites(200, seed=7)
        rng = np.random.default_rng(8)
        times = START_MS + rng.integers(0, SPAN_HOURS, size=len(sites)) * HOUR_MS

        # The trench has to be genuinely far from every site, not merely
        # somewhere that looks remote: with 200 scattered sites there is about
        # a 10% chance any given point has one within 300 km, so a hardcoded
        # "empty" coordinate makes this test fail on a seed change rather than
        # on a regression. Search for one instead.
        far = _far_from_all(sites, seed=44)
        result = run_h6(
            _request(
                sites,
                times.astype(float),
                trenches=TrenchPayload(latitude=[far[0]], longitude=[far[1]]),
            )
        )
        subduction = {test.id: test for test in result.tests}["H6/subduction-zone"]

        assert subduction.observed == 0
        assert any("degenerate" in caveat for caveat in result.caveats)

    def test_the_subduction_subset_selects_on_distance_to_a_trench(self):
        """A trench placed on top of some sites must pick exactly those up."""
        sites = _sites(200, seed=10)
        rng = np.random.default_rng(2)
        times = START_MS + rng.integers(0, SPAN_HOURS, size=len(sites)) * HOUR_MS
        near = sites[0]

        result = run_h6(
            _request(
                sites,
                times.astype(float),
                trenches=TrenchPayload(
                    latitude=[near.latitude_deg], longitude=[near.longitude_deg]
                ),
            )
        )
        subduction = {test.id: test for test in result.tests}["H6/subduction-zone"]
        assert 1 <= subduction.observed < len(sites)

    def test_physical_caveats_always_travel_with_the_result(self):
        """Ocean loading and the free-surface condition are simplifications a
        reader must see beside the number, not conditions that apply
        sometimes."""
        sites = _sites(150, seed=11)
        rng = np.random.default_rng(1)
        times = START_MS + rng.integers(0, SPAN_HOURS, size=len(sites)) * HOUR_MS

        result = run_h6(_request(sites, times.astype(float)))
        joined = " ".join(result.caveats)
        assert "Ocean tide loading is NOT included" in joined
        assert "free-surface" in joined
        assert "nodal plane 1" in joined
