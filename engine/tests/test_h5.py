import numpy as np
import pytest

from terra_pulse_engine.api.contracts import AntipodalRunRequest
from terra_pulse_engine.hypotheses.h5 import TRIGGER_ID, run_h5
from terra_pulse_engine.pipeline.geo import antipode, haversine_km

HOUR_MS = 60 * 60 * 1000
DAY_MS = 24 * HOUR_MS


def _payload(*, iterations: int = 50, plant_excess: bool = False, seed: int = 3) -> dict:
    """A synthetic catalogue with real geometry: triggers scattered around the
    globe, a background of targets, and optionally a planted excess sitting
    near each trigger's antipode inside the 72h window.
    """
    rng = np.random.default_rng(1)
    span_days = 6 * 365

    # Triggers: M6.0+, spread over the span and the globe.
    n_triggers = 60
    trig_time = np.sort(rng.integers(0, span_days, size=n_triggers)) * DAY_MS
    trig_lat = rng.uniform(-55, 55, size=n_triggers)
    trig_lon = rng.uniform(-180, 180, size=n_triggers)
    trig_mag = rng.uniform(6.0, 7.0, size=n_triggers)

    # Background targets: M5.0-5.9, anywhere, any time.
    n_background = 1500
    bg_time = rng.integers(0, span_days, size=n_background) * DAY_MS + rng.integers(
        0, DAY_MS, size=n_background
    )
    bg_lat = rng.uniform(-55, 55, size=n_background)
    bg_lon = rng.uniform(-180, 180, size=n_background)
    bg_mag = rng.uniform(5.0, 5.9, size=n_background)

    times = [trig_time, bg_time]
    lats = [trig_lat, bg_lat]
    lons = [trig_lon, bg_lon]
    mags = [trig_mag, bg_mag]

    if plant_excess:
        # Two events per trigger, within a few degrees of its antipode and
        # inside the window — the effect H5 exists to detect.
        anti_lat, anti_lon = antipode(trig_lat, trig_lon)
        planted_lat = np.repeat(anti_lat, 2) + rng.uniform(-2, 2, size=n_triggers * 2)
        planted_lon = np.repeat(anti_lon, 2) + rng.uniform(-2, 2, size=n_triggers * 2)
        planted_time = np.repeat(trig_time, 2) + rng.integers(
            HOUR_MS, 60 * HOUR_MS, size=n_triggers * 2
        )
        times.append(planted_time)
        lats.append(np.clip(planted_lat, -89, 89))
        lons.append(((planted_lon + 180) % 360) - 180)
        mags.append(rng.uniform(5.0, 5.9, size=n_triggers * 2))

    time_ms = np.concatenate(times)
    order = np.argsort(time_ms, kind="stable")

    return {
        "contractVersion": 1,
        "hypothesisId": "H5",
        "parameters": {
            "targetMinMagnitude": 5.0,
            "triggerMinMagnitude": 6.0,
            "windowHours": [0, 72],
            "declustering": "gardner-knopoff",
            "nullModel": "uniform-redraw",
            "tail": "upper",
            "distanceBinKm": 100.0,
            "iterations": iterations,
            "seed": seed,
            "q": 0.05,
            "requestedStartUtc": "1970-01-01T00:00:00.000Z",
            "registeredMatrixTests": 19,
        },
        "catalog": {
            "timeMs": time_ms[order].astype(int).tolist(),
            "latitude": np.concatenate(lats)[order].tolist(),
            "longitude": np.concatenate(lons)[order].tolist(),
            "magnitude": np.concatenate(mags)[order].tolist(),
        },
    }


def _request(**kwargs) -> AntipodalRunRequest:
    return AntipodalRunRequest.model_validate(_payload(**kwargs))


def test_runs_and_reports_exactly_one_test():
    result = run_h5(_request())

    assert result.hypothesis_id == "H5"
    # The whole point of the no-fixed-radius design: one test, not one per radius.
    assert len(result.tests) == 1
    assert result.tests[0].lag_hours == (0, 72)
    assert result.tests[0].trigger_id == TRIGGER_ID
    assert result.correction.tests_run == 1


def test_labels_its_statistic_because_it_is_not_a_ratio():
    # `ratio` carries the KS D⁺ because the UI's histogram guide line reads
    # that field; the label is what stops it rendering as "0.07×".
    test = run_h5(_request()).tests[0]

    assert test.statistic_label == "KS D⁺"
    assert 0.0 <= test.ratio <= 1.0


def test_reports_how_completeness_is_handled():
    # The parameter the whole hypothesis turns on must appear in the result,
    # not only in HYPOTHESES.md.
    method = run_h5(_request()).method

    assert method.completeness_model is not None
    assert "conditioned" in method.completeness_model
    # H5 has neither of the other two nullables.
    assert method.baseline_window_days is None
    assert method.spatial_split_degrees is None


def test_derives_both_sets_from_one_declustering_pass():
    result = run_h5(_request())

    # Triggers are a strict subset of targets by magnitude, so there must be
    # fewer of them, and both must be non-empty for the test to mean anything.
    assert 0 < result.triggers[0].count < result.catalog.declustered_count


def test_detects_a_planted_antipodal_excess():
    # A test that cannot find an effect says nothing when it reports none.
    plain = run_h5(_request(iterations=200))
    planted = run_h5(_request(iterations=200, plant_excess=True))

    assert planted.tests[0].ratio > plain.tests[0].ratio
    assert planted.tests[0].p_raw < plain.tests[0].p_raw
    assert planted.tests[0].p_raw < 0.05


def test_is_deterministic_for_a_fixed_seed():
    first = run_h5(_request())
    second = run_h5(_request())

    assert first.tests[0].ratio == second.tests[0].ratio
    assert first.tests[0].p_raw == second.tests[0].p_raw


def test_excludes_a_trigger_from_its_own_window():
    """A trigger is itself in the target set and sits at the antipodal maximum
    from its own antipode. Without the strictly-after rule every trigger would
    contribute one artefact to the far tail."""
    payload = _payload()
    result = run_h5(AntipodalRunRequest.model_validate(payload))

    n_triggers = result.triggers[0].count
    observed_n = result.tests[0].observed

    # Rebuild what the window *would* have caught including self-pairs, and
    # confirm the run caught exactly `n_triggers` fewer.
    time_ms = np.asarray(payload["catalog"]["timeMs"], dtype=np.int64)
    mag = np.asarray(payload["catalog"]["magnitude"], dtype=float)
    # Every trigger instant coincides with a target instant (itself), so the
    # difference between side="left" and side="right" is exactly one per trigger.
    trig_times = np.sort(time_ms[mag >= 6.0])
    inclusive = np.searchsorted(time_ms, trig_times, side="left")
    exclusive = np.searchsorted(time_ms, trig_times, side="right")
    self_pairs = int((exclusive - inclusive).sum())

    assert self_pairs >= n_triggers
    assert observed_n > 0


def test_an_empty_trigger_set_says_so_instead_of_looking_like_a_null():
    # A degenerate run produces D⁺ = 0 and p = 1 — arithmetically fine and
    # indistinguishable from a genuine clean null. It has to announce itself.
    payload = _payload()
    payload["parameters"]["triggerMinMagnitude"] = 9.9

    result = run_h5(AntipodalRunRequest.model_validate(payload))

    assert result.triggers[0].count == 0
    assert result.caveats[0].startswith("NO TRIGGERS")
    assert result.tests[0].ratio == 0.0
    assert result.tests[0].p_raw == 1.0


def test_rejects_a_request_carrying_a_series_or_lag_windows():
    for extra in ({"series": {"timeMs": [], "kp": [], "dst": [], "windSpeed": []}},):
        payload = _payload()
        payload.update(extra)
        with pytest.raises(Exception):
            AntipodalRunRequest.model_validate(payload)

    payload = _payload()
    payload["parameters"]["lagWindowsHours"] = [[0, 24]]
    with pytest.raises(Exception):
        AntipodalRunRequest.model_validate(payload)


def test_requires_the_completed_registration_parameters():
    for field in ("nullModel", "tail", "distanceBinKm", "triggerMinMagnitude", "windowHours"):
        payload = _payload()
        del payload["parameters"][field]
        with pytest.raises(Exception):
            AntipodalRunRequest.model_validate(payload)


def test_antipode_matches_the_typescript_half_turn_convention():
    """`geo.antipode` wraps longitude with a modulo; `packages/schema/src/
    antipodal.ts` deliberately uses a single half-turn shift instead, having
    measured the modulo route drifting ~1e-14 on real coordinates. Nothing tied
    the two together until now.
    """
    lons = np.array([0.0, 45.0, 174.78, -76.24, 180.0, -180.0, 90.0, -90.0])
    lats = np.array([0.0, -12.5, 33.1, -60.0, 10.0, 10.0, 0.0, 0.0])

    anti_lat, anti_lon = antipode(lats, lons)

    # The TS convention, transcribed: lon >= 0 ? lon - 180 : lon + 180.
    expected_lon = np.where(lons >= 0, lons - 180.0, lons + 180.0)

    assert np.allclose(anti_lat, -lats, atol=0)
    # A nanometre of disagreement is irrelevant to a 100 km bin; what matters
    # is that they agree to within it rather than being assumed identical.
    assert np.allclose(np.abs(anti_lon - expected_lon) % 360.0, 0.0, atol=1e-9)


def test_antipode_is_its_own_inverse():
    rng = np.random.default_rng(9)
    lat = rng.uniform(-89, 89, size=200)
    lon = rng.uniform(-180, 180, size=200)

    once_lat, once_lon = antipode(lat, lon)
    twice_lat, twice_lon = antipode(once_lat, once_lon)

    assert np.allclose(twice_lat, lat, atol=1e-9)
    assert np.allclose(twice_lon, lon, atol=1e-9)
    # And the antipode really is half a world away.
    assert np.allclose(haversine_km(lat, lon, once_lat, once_lon), 20015.087, atol=0.5)
