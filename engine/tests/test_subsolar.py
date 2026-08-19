from datetime import datetime, timezone

import numpy as np
import pytest

from terra_pulse_engine.pipeline.subsolar import subsolar_longitude_deg, subsolar_point


def _ms(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


# Same reference instants and tolerances as
# apps/desktop/src/renderer/src/layers/magnetopause.test.ts's `subsolarPoint`
# suite — this is a port of that function, so it is pinned against the same
# known astronomy rather than a fresh, potentially-different tolerance.


def test_puts_the_sun_over_the_tropics_at_the_solstices() -> None:
    june = subsolar_point(_ms("2026-06-21T12:00:00Z"))
    assert june[0] == pytest.approx(23.4, abs=0.5)

    december = subsolar_point(_ms("2026-12-21T12:00:00Z"))
    assert december[0] == pytest.approx(-23.4, abs=0.5)


def test_puts_the_sun_near_the_equator_at_the_equinoxes() -> None:
    march = subsolar_point(_ms("2026-03-20T12:00:00Z"))
    assert abs(march[0]) < 1.0

    september = subsolar_point(_ms("2026-09-23T12:00:00Z"))
    assert abs(september[0]) < 1.0


def test_sits_near_the_greenwich_meridian_at_noon_utc() -> None:
    # Within the equation of time, ~+/-16 minutes -> ~4 degrees.
    noon = subsolar_point(_ms("2026-03-20T12:00:00Z"))
    assert abs(noon[1]) < 5.0


def test_travels_westward_roughly_15_degrees_an_hour() -> None:
    at12 = subsolar_point(_ms("2026-03-20T12:00:00Z"))[1]
    at15 = subsolar_point(_ms("2026-03-20T15:00:00Z"))[1]
    assert (at12 - at15) == pytest.approx(45.0, abs=0.5)


def test_stays_within_a_legal_longitude() -> None:
    base = _ms("2026-06-01T00:00:00Z")
    for hour in range(48):
        _, longitude = subsolar_point(base + hour * 3_600_000)
        assert -180.001 < longitude <= 180.001


def test_vectorizes_over_an_array_matching_scalar_calls() -> None:
    times = np.array([_ms("2026-01-01T00:00:00Z") + i * 3_600_000 for i in range(24)])
    vectorized_lat, vectorized_lon = subsolar_point(times)

    for i, t in enumerate(times):
        scalar_lat, scalar_lon = subsolar_point(float(t))
        assert vectorized_lat[i] == pytest.approx(scalar_lat, abs=1e-9)
        assert vectorized_lon[i] == pytest.approx(scalar_lon, abs=1e-9)


def test_subsolar_longitude_deg_matches_the_longitude_half_of_the_full_point() -> None:
    t = _ms("2026-07-04T18:00:00Z")
    _, expected_lon = subsolar_point(t)
    assert subsolar_longitude_deg(t) == pytest.approx(expected_lon, abs=1e-9)
