"""Lunisolar tidal stress, resolved onto a fault plane — H6's physics.

This module answers one question: **at this place, at this instant, what shear
stress does the solid-Earth body tide exert in the direction this fault
slipped?** Everything else in H6 is bookkeeping around that number.

Sun and Moon only. Planetary tides are ~10^-7 of the Moon's and there is no
mechanism (`PROJECT_PLAN.md` §5.7) — the planets are drawn in Explore and
labelled decorative, and they do not appear here.

-------------------------------------------------------------------------------
The chain, in order
-------------------------------------------------------------------------------

**1. The tidal tensor.** For a body of mass M at geocentric distance d in
direction n̂, the degree-2 tide-generating potential at position x (measured
from Earth's centre) is

    W(x) = ½ xᵀ T x,      T = (GM/d³)(3 n̂ n̂ᵀ − I)

`T` is constant across the Earth to this order and traceless — which is just
the statement that W is harmonic, and it is worth checking numerically because
a sign error in `n̂ n̂ᵀ` leaves a tensor that still looks plausible. Sun and
Moon add linearly.

Positions come from JPL DE440 through Skyfield, in the **ITRF (Earth-fixed)**
frame, so `T` already carries Earth's rotation. That is what makes the site
rotation below time-independent, which the whole performance story rests on.

**2. Into the local frame.** With R the rotation whose rows are the site's
east, north and up unit vectors, T′ = R T Rᵀ.

**3. Surface derivatives of W, which is where curvature enters.** At the site,
W = ½ T′₃₃ a², and the derivatives *along the sphere* are

    ∂²W/∂E² = T′₁₁ − T′₃₃
    ∂²W/∂N² = T′₂₂ − T′₃₃
    ∂²W/∂E∂N = T′₁₂

The `− T′₃₃` terms are the curvature correction and are easy to lose: a flat
Cartesian second derivative would drop them and still produce a smooth,
entirely plausible stress field. The check that catches it is that the surface
Laplacian must equal −6W/a² for a degree-2 field, i.e.
(T′₁₁ − T′₃₃) + (T′₂₂ − T′₃₃) = −3T′₃₃, which holds only because T is
traceless. `test_tides.py` asserts it.

**4. Strain, via Love numbers.** With u_up = (h₂/g)W and horizontal
u = (l₂a/g)∇W,

    ε_EE = (a/g)[ l₂(T′₁₁ − T′₃₃) + ½h₂ T′₃₃ ]
    ε_NN = (a/g)[ l₂(T′₂₂ − T′₃₃) + ½h₂ T′₃₃ ]
    ε_EN = (a/g)  l₂ T′₁₂

Their sum collapses to (a/g)(h₂ − 3l₂)T′₃₃, which is the classical areal-strain
result (2h₂ − 6l₂)W/(ga). That agreement is the main check that the Love-number
convention here is the standard one — pinned by a test.

**5. Stress, at a free surface.** σ_UU = σ_EU = σ_NU = 0, so plane stress:

    σ_EE = 2μ ε_EE + λ′(ε_EE + ε_NN),   λ′ = 2λμ/(λ + 2μ)
    σ_NN = 2μ ε_NN + λ′(ε_EE + ε_NN)
    σ_EN = 2μ ε_EN

**6. Resolve.** τ = ûᵀ σ n̂ with n̂ the fault normal and û the slip direction
from (strike, dip, rake).

-------------------------------------------------------------------------------
What this is not
-------------------------------------------------------------------------------

**No ocean tide loading.** Tanaka, Ohtake & Sato (2002) included it (via
GOTIC), and it is not a small correction near coasts — which is where
subduction earthquakes are. It shifts *phase*, not just amplitude, so it cannot
be waved away by the scale-invariance argument below. This is the single
largest physical simplification here and it belongs in the reported caveats,
not in a comment.

**Free-surface stress applied at the hypocentre's depth.** σ_UU = 0 holds at
the surface and not at 600 km. Over the top few tens of km — where the shallow
thrust events that dominate the subduction subset sit — the error is small
against a tidal field whose wavelength is the whole planet. It grows with
depth, and deep events are the weakest part of this calculation.

**Amplitude is far less load-bearing than it looks**, and this is why the two
approximations above are survivable at all. H6 defines tidal phase from the
*extrema of the computed series* (`HYPOTHESES.md`), so any factor that scales
τ(t) uniformly — every elastic modulus here, both Love numbers, the Earth
radius — cannot move a single phase angle. What matters is the *relative*
weighting of tensor components, since that shifts where the extrema fall in
time. So the constants below are chosen to make the printed stress amplitude
physically sensible (kPa), and the result would be identical if they were all
doubled.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# --- Physical constants -------------------------------------------------------

# Gravitational parameters, m³/s². DE440's own values (km³/s², converted).
GM_SUN = 1.32712440041279419e20
GM_MOON = 4.902800118e12

# Mean Earth radius and surface gravity. Mean rather than equatorial: the tidal
# field varies on a planetary scale, so the ~0.3% flattening is far below the
# level at which anything here is accurate.
EARTH_RADIUS_M = 6.371e6
SURFACE_GRAVITY = 9.80665

# Degree-2 displacement Love numbers for an elastic Earth, IERS 2010 nominal.
# `k₂` deliberately absent: it describes the *additional potential* raised by
# the deformation, which matters for gravimetry and not for strain.
LOVE_H2 = 0.6078
LOVE_L2 = 0.0847

# Crustal elastic moduli, Pa. A Poisson solid (λ = μ, ν = 0.25) — the standard
# default when no local model is available. Only their *ratio* can affect a
# phase; see the amplitude note in the module docstring.
LAME_LAMBDA = 3.0e10
SHEAR_MODULUS = 3.0e10


def plane_stress_lambda(lame_lambda: float = LAME_LAMBDA, mu: float = SHEAR_MODULUS) -> float:
    """λ′ = 2λμ/(λ+2μ), the effective λ when σ_UU is held at zero."""
    return 2.0 * lame_lambda * mu / (lame_lambda + 2.0 * mu)


# --- Geometry -----------------------------------------------------------------


def enu_rotation(latitude_deg: float, longitude_deg: float) -> np.ndarray:
    """ECEF → local (east, north, up), as a 3×3 whose *rows* are those axes."""
    lat = np.radians(latitude_deg)
    lon = np.radians(longitude_deg)
    sin_lat, cos_lat = np.sin(lat), np.cos(lat)
    sin_lon, cos_lon = np.sin(lon), np.cos(lon)
    return np.array(
        [
            [-sin_lon, cos_lon, 0.0],
            [-sin_lat * cos_lon, -sin_lat * sin_lon, cos_lat],
            [cos_lat * cos_lon, cos_lat * sin_lon, sin_lat],
        ]
    )


def fault_vectors(strike_deg: float, dip_deg: float, rake_deg: float) -> tuple[np.ndarray, np.ndarray]:
    """Fault normal and slip direction, returned in **ENU**.

    Aki & Richards' convention, which is defined in (north, east, down) — the
    conversion to ENU happens here rather than at the call site so there is one
    place to get it wrong. Global CMT publishes strike/dip/rake in exactly this
    convention.

    Only nodal plane 1 is ever passed in. The second plane is redundant for
    shear stress (identical by the conjugate-plane identity, which
    `test_tides.py` verifies numerically) and GCMT rounds both to whole
    degrees, so comparing them measures publication precision and reads as
    physics. See `HYPOTHESES.md` H6.
    """
    strike = np.radians(strike_deg)
    dip = np.radians(dip_deg)
    rake = np.radians(rake_deg)

    sin_s, cos_s = np.sin(strike), np.cos(strike)
    sin_d, cos_d = np.sin(dip), np.cos(dip)
    sin_r, cos_r = np.sin(rake), np.cos(rake)

    # (north, east, down)
    normal_ned = np.array([-sin_d * sin_s, sin_d * cos_s, -cos_d])
    slip_ned = np.array(
        [
            cos_r * cos_s + cos_d * sin_r * sin_s,
            cos_r * sin_s - cos_d * sin_r * cos_s,
            -sin_r * sin_d,
        ]
    )

    def to_enu(v: np.ndarray) -> np.ndarray:
        return np.array([v[1], v[0], -v[2]])

    return to_enu(normal_ned), to_enu(slip_ned)


# --- The tidal tensor ---------------------------------------------------------


def tidal_tensor(gm: float, direction_ecef: np.ndarray, distance_m: np.ndarray) -> np.ndarray:
    """T = (GM/d³)(3 n̂n̂ᵀ − I), vectorised over leading axes.

    `direction_ecef` is (..., 3) and unit length; `distance_m` is (...).
    Returns (..., 3, 3).
    """
    n = np.asarray(direction_ecef, dtype=float)
    d = np.asarray(distance_m, dtype=float)
    outer = n[..., :, None] * n[..., None, :]
    identity = np.eye(3)
    return (gm / d[..., None, None] ** 3) * (3.0 * outer - identity)


# --- Stress at a site ---------------------------------------------------------


@dataclass(frozen=True)
class SiteGeometry:
    """Everything about an event that the stress calculation needs."""

    latitude_deg: float
    longitude_deg: float
    strike_deg: float
    dip_deg: float
    rake_deg: float


def local_stress_tensor(tensor_ecef: np.ndarray, site: SiteGeometry) -> np.ndarray:
    """The tidal stress tensor in local ENU, from the ECEF tidal tensor.

    Vectorised over leading axes of `tensor_ecef` ((..., 3, 3) in, (..., 3, 3)
    out). This is the readable reference implementation; `shear_coefficients`
    below collapses the whole chain into one linear form and is checked against
    this.
    """
    rotation = enu_rotation(site.latitude_deg, site.longitude_deg)
    local = rotation @ tensor_ecef @ rotation.T

    t11 = local[..., 0, 0]
    t22 = local[..., 1, 1]
    t33 = local[..., 2, 2]
    t12 = local[..., 0, 1]

    scale = EARTH_RADIUS_M / SURFACE_GRAVITY
    # Surface (not flat-Cartesian) second derivatives — see step 3 in the
    # module docstring for why the −t33 terms are here.
    strain_ee = scale * (LOVE_L2 * (t11 - t33) + 0.5 * LOVE_H2 * t33)
    strain_nn = scale * (LOVE_L2 * (t22 - t33) + 0.5 * LOVE_H2 * t33)
    strain_en = scale * LOVE_L2 * t12

    dilatation = strain_ee + strain_nn
    lambda_prime = plane_stress_lambda()

    sigma_ee = 2.0 * SHEAR_MODULUS * strain_ee + lambda_prime * dilatation
    sigma_nn = 2.0 * SHEAR_MODULUS * strain_nn + lambda_prime * dilatation
    sigma_en = 2.0 * SHEAR_MODULUS * strain_en

    stress = np.zeros(tensor_ecef.shape, dtype=float)
    stress[..., 0, 0] = sigma_ee
    stress[..., 1, 1] = sigma_nn
    stress[..., 0, 1] = sigma_en
    stress[..., 1, 0] = sigma_en
    # σ_UU, σ_EU, σ_NU stay zero — the free-surface condition.
    return stress


def resolved_shear(tensor_ecef: np.ndarray, site: SiteGeometry) -> np.ndarray:
    """Shear stress in the slip direction, Pa. Positive encourages slip.

    The readable reference. Use `shear_coefficients` when this has to run
    across millions of instants.
    """
    stress = local_stress_tensor(tensor_ecef, site)
    normal, slip = fault_vectors(site.strike_deg, site.dip_deg, site.rake_deg)
    return np.einsum("p,...pq,q->...", slip, stress, normal)


def shear_coefficients(site: SiteGeometry) -> np.ndarray:
    """The same calculation as `resolved_shear`, collapsed to a 3×3 form C.

    Every step from the ECEF tidal tensor to the resolved shear is linear, so

        τ(t) = Σ_ij C_ij T_ij(t)

    with C depending only on the site's position and fault geometry — not on
    time. That is what turns "recompute the stress at millions of instants"
    into one matrix product, and it is why the ITRF frame matters: in an
    inertial frame the site rotation would be time-dependent and no such C
    would exist.

    Derived here rather than assumed: C = Rᵀ F R, where F is the coefficient
    matrix in the local frame read straight off the expressions in
    `local_stress_tensor`. `test_tides.py` asserts the two agree.
    """
    rotation = enu_rotation(site.latitude_deg, site.longitude_deg)
    normal, slip = fault_vectors(site.strike_deg, site.dip_deg, site.rake_deg)

    # τ = A σ_EE + B σ_NN + X σ_EN, with only those three components non-zero.
    a_coef = slip[0] * normal[0]
    b_coef = slip[1] * normal[1]
    x_coef = slip[0] * normal[1] + slip[1] * normal[0]

    scale = EARTH_RADIUS_M / SURFACE_GRAVITY
    lambda_prime = plane_stress_lambda()
    two_mu = 2.0 * SHEAR_MODULUS

    local_form = np.zeros((3, 3), dtype=float)
    local_form[0, 0] = scale * two_mu * a_coef * LOVE_L2
    local_form[1, 1] = scale * two_mu * b_coef * LOVE_L2
    # Split across the symmetric pair so the contraction picks up both.
    local_form[0, 1] = local_form[1, 0] = 0.5 * scale * two_mu * x_coef * LOVE_L2
    local_form[2, 2] = scale * (
        two_mu * (a_coef + b_coef) * (0.5 * LOVE_H2 - LOVE_L2)
        + lambda_prime * (a_coef + b_coef) * (LOVE_H2 - 3.0 * LOVE_L2)
    )

    return rotation.T @ local_form @ rotation
