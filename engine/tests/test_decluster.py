import json
from pathlib import Path

import numpy as np
import pytest

from terra_pulse_engine.pipeline.decluster import (
    decluster_gardner_knopoff,
    gardner_knopoff_radius_km,
    gardner_knopoff_window_days,
)

FIXTURES = Path(__file__).parent / "fixtures"


# Gardner & Knopoff (1974) published Table 1, via the same Uhrhammer (1986)
# analytic fit packages/schema/src/aftershocks.ts uses and was checked
# against. These are the exact figures quoted in that file's own docstring.
@pytest.mark.parametrize(
    "magnitude,expected_km",
    [(6.0, 53.2), (7.0, 70.7)],
)
def test_radius_matches_table_1(magnitude: float, expected_km: float) -> None:
    assert gardner_knopoff_radius_km(magnitude) == pytest.approx(expected_km, abs=0.1)


@pytest.mark.parametrize(
    "magnitude,expected_days",
    [(7.0, 918.0), (8.0, 988.0)],
)
def test_window_days_matches_table_1(magnitude: float, expected_days: float) -> None:
    assert gardner_knopoff_window_days(magnitude) == pytest.approx(expected_days, abs=0.5)


def test_window_days_discontinuity_at_seam_matches_documented_values() -> None:
    # At exactly M6.5 the formula switches from the lower to the upper
    # branch. What the *lower* branch would have given there (930.8 days) is
    # larger than what the *upper* branch — the one actually used at M6.5 —
    # gives (884.9 days): a real discontinuity, not a bug. See the module
    # docstring and packages/schema/src/aftershocks.ts's identical note. If
    # this test ever starts failing because someone "fixed" the seam, that's
    # the free parameter non-negotiable #3 forbids — don't just update it.
    lower_branch_at_seam = 10.0 ** (0.5409 * 6.5 - 0.547)
    upper_branch_at_seam = gardner_knopoff_window_days(6.5)  # uses the upper branch

    assert upper_branch_at_seam == pytest.approx(884.9, abs=0.1)
    assert lower_branch_at_seam == pytest.approx(930.8, abs=0.1)
    assert upper_branch_at_seam < lower_branch_at_seam


def test_forward_only_foreshocks_never_removed() -> None:
    # A large event followed by a small one just before it in time: the
    # small one is a "foreshock" by clock order and must survive.
    time_ms = np.array([1_000_000, 2_000_000], dtype=np.int64)  # foreshock, then M7
    lat = np.array([10.0, 10.0])
    lon = np.array([10.0, 10.0])
    magnitude = np.array([5.0, 7.0])

    independent = decluster_gardner_knopoff(time_ms, lat, lon, magnitude)
    assert independent[0], "the earlier, smaller event must survive as independent"
    assert independent[1], "the mainshock is always independent"


def test_aftershock_within_window_and_radius_is_removed() -> None:
    day_ms = 24 * 60 * 60 * 1000
    time_ms = np.array([0, 1 * day_ms], dtype=np.int64)  # M7 then an aftershock 1 day later
    lat = np.array([10.0, 10.0])
    lon = np.array([10.0, 10.0])  # co-located
    magnitude = np.array([7.0, 5.0])

    independent = decluster_gardner_knopoff(time_ms, lat, lon, magnitude)
    assert independent[0]
    assert not independent[1]


def test_event_outside_radius_survives() -> None:
    day_ms = 24 * 60 * 60 * 1000
    time_ms = np.array([0, 1 * day_ms], dtype=np.int64)
    lat = np.array([10.0, 10.0])
    lon = np.array([10.0, 40.0])  # ~3,300 km away — far outside any GK radius
    magnitude = np.array([7.0, 5.0])

    independent = decluster_gardner_knopoff(time_ms, lat, lon, magnitude)
    assert independent[0]
    assert independent[1]


def test_independent_event_cannot_be_demoted() -> None:
    # A small early shock, then a much larger one later whose window reaches
    # back to it spatially. Sweeping largest-first means the small shock is
    # already marked independent by the time the big one is processed, and
    # must stay that way.
    day_ms = 24 * 60 * 60 * 1000
    time_ms = np.array([0, 10 * day_ms], dtype=np.int64)
    lat = np.array([10.0, 10.0])
    lon = np.array([10.0, 10.0])
    magnitude = np.array([5.0, 7.5])

    independent = decluster_gardner_knopoff(time_ms, lat, lon, magnitude)
    # The M5.0 precedes the M7.5, so it is a foreshock relative to it (never
    # removed) regardless of demotion rules — but this also exercises that
    # largest-first processing order doesn't retroactively touch it.
    assert independent[0]
    assert independent[1]


def test_empty_input() -> None:
    empty = np.zeros(0, dtype=np.int64)
    result = decluster_gardner_knopoff(empty, empty.astype(float), empty.astype(float), empty.astype(float))
    assert result.shape == (0,)


def test_cross_language_parity_fixture() -> None:
    """Shared with packages/schema/src/recurrence.test.ts. If this fails but
    the TS test passes (or vice versa), the two independent implementations
    have drifted apart on real data.
    """
    fixture = json.loads((FIXTURES / "gk_parity.json").read_text())
    events = fixture["events"]

    time_ms = np.array([e["timeMs"] for e in events], dtype=np.int64)
    lat = np.array([e["latitude"] for e in events], dtype=float)
    lon = np.array([e["longitude"] for e in events], dtype=float)
    magnitude = np.array([e["magnitude"] for e in events], dtype=float)

    independent = decluster_gardner_knopoff(time_ms, lat, lon, magnitude)
    independent_ids = sorted(events[i]["id"] for i in range(len(events)) if independent[i])

    assert independent_ids == fixture["independentIds"]
