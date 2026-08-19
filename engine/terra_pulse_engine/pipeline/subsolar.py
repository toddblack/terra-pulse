"""The subsolar point — where the Sun sits directly overhead — needed to
turn a CME arrival instant into "which hemisphere was sun-facing".

Ported from `apps/desktop/src/renderer/src/layers/magnetopause.ts`'s
`subsolarPoint`, not re-derived: that function is itself a port of a
low-precision solar-position formula from the Astronomical Almanac, already
pinned there against known solstice/equinox declinations and the ~15°/hour
westward drift. Matching a validated reference is worth more here than
re-deriving the same trigonometry independently and hoping it agrees — the
same reasoning `pipeline/decluster.py` gives for porting Gardner-Knopoff
rather than re-implementing it from the paper.
"""

from __future__ import annotations

import numpy as np

DAY_MS = 24 * 60 * 60 * 1000
# Epoch ms at J2000.0 (2000-01-01T12:00:00Z) — the formula's own epoch.
J2000_EPOCH_MS = 946_728_000_000


def normalize_longitude_deg(deg: np.ndarray | float) -> np.ndarray | float:
    """To (-180, 180], matching the TS port's own `normaliseLongitude`."""
    value = np.mod(deg, 360.0)
    value = np.where(value > 180.0, value - 360.0, value)
    value = np.where(value <= -180.0, value + 360.0, value)
    return value


def subsolar_point(time_ms: np.ndarray | float) -> tuple[np.ndarray | float, np.ndarray | float]:
    """Returns `(latitude_deg, longitude_deg)`, vectorized over `time_ms`
    (epoch milliseconds, may be a scalar or an array).

    Low-precision solar position, after the Astronomical Almanac — accurate
    to about 0.01 degrees in declination over 1950-2050, far past what a
    hemisphere split needs.
    """
    n = np.asarray(time_ms, dtype=float) / DAY_MS - (J2000_EPOCH_MS / DAY_MS)

    mean_longitude = 280.46 + 0.9856474 * n
    mean_anomaly = np.radians(357.528 + 0.9856003 * n)

    ecliptic_longitude = np.radians(
        mean_longitude + 1.915 * np.sin(mean_anomaly) + 0.02 * np.sin(2 * mean_anomaly)
    )

    obliquity = np.radians(23.439 - 0.0000004 * n)

    declination = np.arcsin(np.sin(obliquity) * np.sin(ecliptic_longitude))

    right_ascension = np.arctan2(
        np.cos(obliquity) * np.sin(ecliptic_longitude), np.cos(ecliptic_longitude)
    )
    gmst_deg = np.mod(280.46061837 + 360.98564736629 * n, 360.0)

    latitude_deg = np.degrees(declination)
    longitude_deg = normalize_longitude_deg(np.degrees(right_ascension) - gmst_deg)

    return latitude_deg, longitude_deg


def subsolar_longitude_deg(time_ms: np.ndarray | float) -> np.ndarray | float:
    """H2b only needs the longitude — the registered spatial split is
    "subsolar longitude at arrival ±90°", not full 3D angular distance from
    the subsolar point, so latitude never enters the classification."""
    _, longitude_deg = subsolar_point(time_ms)
    return longitude_deg
