"""Geometry helpers shared by every hypothesis. Ported from
packages/schema/src/aftershocks.ts and packages/schema/src/antipodal.ts —
Earth as a sphere is ample at these scales, matching the TS side's own
justification.
"""

from __future__ import annotations

import numpy as np

EARTH_RADIUS_KM = 6371.0


def haversine_km(
    lat1: np.ndarray | float,
    lon1: np.ndarray | float,
    lat2: np.ndarray | float,
    lon2: np.ndarray | float,
) -> np.ndarray:
    """Great-circle distance in km. Vectorized — every argument may be a
    scalar or an array, broadcast the usual numpy way.
    """
    lat1_r, lon1_r, lat2_r, lon2_r = map(np.radians, (lat1, lon1, lat2, lon2))
    dlat = lat2_r - lat1_r
    dlon = lon2_r - lon1_r
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1_r) * np.cos(lat2_r) * np.sin(dlon / 2) ** 2
    c = 2 * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))
    return EARTH_RADIUS_KM * c


def antipode(lat: np.ndarray | float, lon: np.ndarray | float) -> tuple[np.ndarray, np.ndarray]:
    """The point diametrically opposite (lat, lon). Kept for H5's later use;
    unused by H4c.
    """
    antipode_lat = -np.asarray(lat, dtype=float)
    antipode_lon = np.mod(np.asarray(lon, dtype=float) + 180.0 + 180.0, 360.0) - 180.0
    return antipode_lat, antipode_lon
