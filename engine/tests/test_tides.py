"""Physics checks for the lunisolar tidal stress calculation.

Most of these assert an *identity* rather than a value — a spherical-harmonic
stress field that is subtly wrong still comes out smooth and plausible, so
"the number looks reasonable" is worth very little here. The identities below
each fail loudly for a specific mistake, and they are named for it.
"""

from __future__ import annotations

import numpy as np
import pytest

from terra_pulse_engine.pipeline.tides import (
    EARTH_RADIUS_M,
    GM_MOON,
    GM_SUN,
    LOVE_H2,
    LOVE_L2,
    SURFACE_GRAVITY,
    SiteGeometry,
    enu_rotation,
    fault_vectors,
    local_stress_tensor,
    resolved_shear,
    shear_coefficients,
    tidal_tensor,
)


def unit(vector: np.ndarray) -> np.ndarray:
    return np.asarray(vector, dtype=float) / np.linalg.norm(vector)


class TestTidalTensor:
    def test_is_traceless(self):
        """W must be harmonic. A sign slip in `3n̂n̂ᵀ − I` breaks this and
        leaves a tensor that otherwise looks entirely normal."""
        for direction in (unit([1, 0, 0]), unit([0.3, -0.5, 0.81]), unit([-1, 2, 3])):
            tensor = tidal_tensor(GM_MOON, direction, 384_400_000.0)
            assert abs(np.trace(tensor)) < 1e-20

    def test_is_symmetric(self):
        tensor = tidal_tensor(GM_SUN, unit([0.2, 0.9, -0.3]), 1.496e11)
        assert np.allclose(tensor, tensor.T, rtol=0, atol=1e-24)

    def test_stretches_along_the_body_direction(self):
        """The tidal field pulls out along the body's line and squeezes across
        it — the reason there are two bulges, not one."""
        direction = unit([1, 0, 0])
        tensor = tidal_tensor(GM_MOON, direction, 384_400_000.0)
        along = direction @ tensor @ direction
        across = np.array([0, 1, 0]) @ tensor @ np.array([0, 1, 0])
        assert along > 0
        assert across < 0
        assert along == pytest.approx(-2.0 * across, rel=1e-12)

    def test_moon_dominates_the_sun(self):
        """The Moon raises roughly twice the Sun's tide. Getting GM or the
        cube of distance wrong shows up here immediately."""
        moon = tidal_tensor(GM_MOON, unit([1, 0, 0]), 384_400_000.0)
        sun = tidal_tensor(GM_SUN, unit([1, 0, 0]), 1.496e11)
        ratio = moon[0, 0] / sun[0, 0]
        assert 2.0 < ratio < 2.4


class TestLocalFrame:
    def test_enu_rotation_is_orthonormal_and_right_handed(self):
        for lat, lon in ((0.0, 0.0), (38.3, 142.4), (-33.4, -70.6), (89.0, 179.0)):
            rotation = enu_rotation(lat, lon)
            assert np.allclose(rotation @ rotation.T, np.eye(3), atol=1e-12)
            east, north, up = rotation
            assert np.allclose(np.cross(east, north), up, atol=1e-12)

    def test_up_points_away_from_the_centre(self):
        rotation = enu_rotation(45.0, 30.0)
        up = rotation[2]
        expected = unit(
            [
                np.cos(np.radians(45.0)) * np.cos(np.radians(30.0)),
                np.cos(np.radians(45.0)) * np.sin(np.radians(30.0)),
                np.sin(np.radians(45.0)),
            ]
        )
        assert np.allclose(up, expected, atol=1e-12)

    def test_surface_laplacian_identity(self):
        """The curvature correction, checked directly.

        For a degree-2 field the surface Laplacian is −6W/a². With
        W = ½T′₃₃a², that means (T′₁₁−T′₃₃) + (T′₂₂−T′₃₃) = −3T′₃₃. Dropping
        the −T′₃₃ terms — i.e. using flat Cartesian second derivatives —
        breaks this, and nothing else here would notice.
        """
        tensor = tidal_tensor(GM_MOON, unit([0.4, 0.5, 0.77]), 384_400_000.0)
        rotation = enu_rotation(12.0, -75.0)
        local = rotation @ tensor @ rotation.T
        t11, t22, t33 = local[0, 0], local[1, 1], local[2, 2]
        laplacian = (t11 - t33) + (t22 - t33)
        assert laplacian == pytest.approx(-3.0 * t33, rel=1e-12)


class TestStrain:
    def test_areal_strain_matches_the_classical_love_number_result(self):
        """Areal strain must equal (2h₂ − 6l₂)W/(ga).

        This is the check that the Love-number convention here is the standard
        one. An `l₂` applied without the factor of `a`, or a swapped h/l, still
        produces a smooth field of roughly the right size and fails here.
        """
        site = SiteGeometry(latitude_deg=35.0, longitude_deg=139.0, strike_deg=0, dip_deg=45, rake_deg=90)
        tensor = tidal_tensor(GM_MOON, unit([0.1, -0.6, 0.79]), 384_400_000.0)

        rotation = enu_rotation(site.latitude_deg, site.longitude_deg)
        local = rotation @ tensor @ rotation.T
        potential = 0.5 * local[2, 2] * EARTH_RADIUS_M**2

        scale = EARTH_RADIUS_M / SURFACE_GRAVITY
        strain_ee = scale * (LOVE_L2 * (local[0, 0] - local[2, 2]) + 0.5 * LOVE_H2 * local[2, 2])
        strain_nn = scale * (LOVE_L2 * (local[1, 1] - local[2, 2]) + 0.5 * LOVE_H2 * local[2, 2])

        classical = (2.0 * LOVE_H2 - 6.0 * LOVE_L2) * potential / (SURFACE_GRAVITY * EARTH_RADIUS_M)
        assert strain_ee + strain_nn == pytest.approx(classical, rel=1e-12)


class TestFaultVectors:
    def test_normal_and_slip_are_orthogonal_unit_vectors(self):
        rng = np.random.default_rng(7)
        for _ in range(200):
            strike = rng.uniform(0, 360)
            dip = rng.uniform(0, 90)
            rake = rng.uniform(-180, 180)
            normal, slip = fault_vectors(strike, dip, rake)
            assert np.linalg.norm(normal) == pytest.approx(1.0, abs=1e-12)
            assert np.linalg.norm(slip) == pytest.approx(1.0, abs=1e-12)
            assert normal @ slip == pytest.approx(0.0, abs=1e-12)

    def test_vertical_left_lateral_strike_slip(self):
        """Strike north, vertical, rake 0. Normal points east, slip north."""
        normal, slip = fault_vectors(0.0, 90.0, 0.0)
        assert np.allclose(normal, [1, 0, 0], atol=1e-12)  # ENU: east
        assert np.allclose(slip, [0, 1, 0], atol=1e-12)  # ENU: north

    def test_east_dipping_thrust(self):
        """Strike north, dip 45° east, rake 90°. The hanging wall rides up and
        to the west, and the plane's upward normal tips east."""
        normal, slip = fault_vectors(0.0, 45.0, 90.0)
        root_half = np.sqrt(0.5)
        assert np.allclose(normal, [root_half, 0.0, root_half], atol=1e-12)
        assert np.allclose(slip, [-root_half, 0.0, root_half], atol=1e-12)


class TestResolvedShear:
    def test_conjugate_planes_give_identical_shear(self):
        """H6's load-bearing identity.

        For conjugate planes n̂₂ = û₁ and û₂ = n̂₁, so the resolved shear is
        n̂₁ᵀσû₁ against û₁ᵀσn̂₁ — equal for any symmetric σ. This is what
        removes the fault-plane ambiguity instead of managing it, and is why
        the registration chose shear over Coulomb. If it ever fails, H6's
        whole justification for reading only plane 1 fails with it.
        """
        site = SiteGeometry(latitude_deg=-20.0, longitude_deg=170.0, strike_deg=115, dip_deg=32, rake_deg=78)
        tensor = tidal_tensor(GM_MOON, unit([0.55, 0.2, 0.81]), 3.7e8)
        stress = local_stress_tensor(tensor, site)
        normal, slip = fault_vectors(site.strike_deg, site.dip_deg, site.rake_deg)

        plane_one = slip @ stress @ normal
        # The conjugate plane, by construction: its normal is plane 1's slip
        # direction and vice versa.
        plane_two = normal @ stress @ slip
        assert plane_one == pytest.approx(plane_two, rel=1e-15)

    def test_linear_form_matches_the_reference_implementation(self):
        """`shear_coefficients` collapses the whole chain into one 3×3. It is
        an optimisation, so it has to reproduce the readable version exactly
        rather than merely closely."""
        rng = np.random.default_rng(11)
        for _ in range(50):
            site = SiteGeometry(
                latitude_deg=rng.uniform(-80, 80),
                longitude_deg=rng.uniform(-180, 180),
                strike_deg=rng.uniform(0, 360),
                dip_deg=rng.uniform(5, 89),
                rake_deg=rng.uniform(-180, 180),
            )
            direction = unit(rng.normal(size=3))
            tensor = tidal_tensor(GM_MOON, direction, 3.8e8)

            reference = resolved_shear(tensor, site)
            collapsed = float(np.sum(shear_coefficients(site) * tensor))
            assert collapsed == pytest.approx(reference, rel=1e-11)

    def test_linear_form_is_vectorised_over_time(self):
        site = SiteGeometry(latitude_deg=38.3, longitude_deg=142.4, strike_deg=203, dip_deg=10, rake_deg=88)
        rng = np.random.default_rng(3)
        directions = rng.normal(size=(64, 3))
        directions /= np.linalg.norm(directions, axis=1, keepdims=True)
        tensors = tidal_tensor(GM_MOON, directions, np.full(64, 3.8e8))

        reference = resolved_shear(tensors, site)
        collapsed = tensors.reshape(64, 9) @ shear_coefficients(site).reshape(9)
        assert np.allclose(collapsed, reference, rtol=1e-11)

    def test_amplitude_is_kilopascals(self):
        """Solid-Earth tidal stresses are a few kPa. Three orders either way
        would mean a unit error somewhere in the chain — the kind that leaves
        every identity above intact."""
        site = SiteGeometry(latitude_deg=0.0, longitude_deg=0.0, strike_deg=90, dip_deg=45, rake_deg=90)
        peak = 0.0
        for lon in np.arange(0, 360, 5.0):
            direction = unit([np.cos(np.radians(lon)), np.sin(np.radians(lon)), 0.0])
            total = tidal_tensor(GM_MOON, direction, 3.844e8) + tidal_tensor(
                GM_SUN, unit([1.0, 0.0, 0.0]), 1.496e11
            )
            peak = max(peak, abs(float(resolved_shear(total, site))))
        assert 200.0 < peak < 20_000.0
