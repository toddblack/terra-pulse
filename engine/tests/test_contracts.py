import copy
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from terra_pulse_engine.api.contracts import AnalysisResult, HemisphereRunRequest, LagWindowRunRequest

FIXTURES = Path(__file__).parent / "fixtures"

VALID_PARAMETERS = {
    "targetMinMagnitude": 5.0,
    "triggers": [
        {
            "id": "kp>=6",
            "series": "kp",
            "comparison": ">=",
            "threshold": 6,
            "minConsecutiveHours": 1,
        }
    ],
    "lagWindowsHours": [[0, 24]],
    "declustering": "gardner-knopoff",
    "baselineWindowDays": 365.25,
    "nullModel": "uniform-redraw",
    "tail": "upper",
    "iterations": 100,
    "seed": 1,
    "q": 0.05,
    "requestedStartUtc": "1963-01-01T00:00:00.000Z",
    "registeredMatrixTests": 19,
}


def _valid_request_dict() -> dict:
    return {
        "contractVersion": 1,
        "hypothesisId": "H4c",
        "parameters": copy.deepcopy(VALID_PARAMETERS),
        "catalog": {
            "timeMs": [0, 1000],
            "latitude": [10.0, 20.0],
            "longitude": [30.0, 40.0],
            "magnitude": [5.0, 6.0],
        },
        "series": {
            "timeMs": [0, 3_600_000],
            "kp": [3.0, None],
            "dst": [None, -20.0],
            "windSpeed": [400.0, None],
        },
    }


def test_valid_request_parses() -> None:
    request = LagWindowRunRequest.model_validate(_valid_request_dict())
    assert request.hypothesis_id == "H4c"
    assert request.parameters.baseline_window_days == 365.25


def test_missing_baseline_window_days_is_rejected() -> None:
    payload = _valid_request_dict()
    del payload["parameters"]["baselineWindowDays"]
    with pytest.raises(ValidationError):
        LagWindowRunRequest.model_validate(payload)


def test_unknown_field_is_rejected() -> None:
    # extra="forbid" — a renderer-supplied parameter the schema doesn't know
    # about must fail loudly, not be silently ignored.
    payload = _valid_request_dict()
    payload["parameters"]["extraField"] = 123
    with pytest.raises(ValidationError):
        LagWindowRunRequest.model_validate(payload)


def test_implausible_epoch_is_rejected() -> None:
    # The literal case found in this app's own dev database: a cme_arrivals
    # row with an arrival year of 2914.
    payload = _valid_request_dict()
    year_2914_ms = 29_798_000_000_000  # well past MAX_PLAUSIBLE_EPOCH_MS
    payload["catalog"]["timeMs"] = [0, year_2914_ms]
    with pytest.raises(ValidationError):
        LagWindowRunRequest.model_validate(payload)


def test_non_monotonic_catalog_times_are_rejected() -> None:
    payload = _valid_request_dict()
    payload["catalog"]["timeMs"] = [1000, 0]
    with pytest.raises(ValidationError):
        LagWindowRunRequest.model_validate(payload)


def test_out_of_range_latitude_is_rejected() -> None:
    payload = _valid_request_dict()
    payload["catalog"]["latitude"] = [100.0, 20.0]
    with pytest.raises(ValidationError):
        LagWindowRunRequest.model_validate(payload)


def test_mismatched_array_lengths_are_rejected() -> None:
    payload = _valid_request_dict()
    payload["catalog"]["latitude"] = [10.0]  # now length 1, others length 2
    with pytest.raises(ValidationError):
        LagWindowRunRequest.model_validate(payload)


def test_null_series_values_are_accepted() -> None:
    payload = _valid_request_dict()
    request = LagWindowRunRequest.model_validate(payload)
    assert request.series.kp[1] is None
    assert request.series.dst[0] is None


H2B_VALID_PARAMETERS = {
    "targetMinMagnitude": 5.0,
    "spatialSplitDegrees": 90,
    "lagWindowsHours": [[0, 24], [24, 48]],
    "declustering": "gardner-knopoff",
    "nullModel": "uniform-redraw",
    "tail": "upper",
    "iterations": 100,
    "seed": 1,
    "q": 0.05,
    "requestedStartUtc": "2014-01-01T00:00:00.000Z",
    "registeredMatrixTests": 19,
}


def _valid_h2b_request_dict() -> dict:
    return {
        "contractVersion": 1,
        "hypothesisId": "H2b",
        "parameters": copy.deepcopy(H2B_VALID_PARAMETERS),
        "catalog": {
            "timeMs": [0, 1000],
            "latitude": [10.0, 20.0],
            "longitude": [30.0, 40.0],
            "magnitude": [5.0, 6.0],
        },
        "cmeArrivalTimesMs": [0, 3_600_000],
    }


def test_valid_h2b_request_parses() -> None:
    request = HemisphereRunRequest.model_validate(_valid_h2b_request_dict())
    assert request.hypothesis_id == "H2b"
    assert request.parameters.spatial_split_degrees == 90


def test_h2b_has_no_baseline_window_field_at_all() -> None:
    # Unlike H4c/H3b, this hypothesis genuinely has no Poisson baseline —
    # the field must not silently exist as an ignored extra either, since
    # extra="forbid" would catch it if someone tried to sneak one in.
    payload = _valid_h2b_request_dict()
    payload["parameters"]["baselineWindowDays"] = 365.25
    with pytest.raises(ValidationError):
        HemisphereRunRequest.model_validate(payload)


def test_h2b_missing_spatial_split_degrees_is_rejected() -> None:
    payload = _valid_h2b_request_dict()
    del payload["parameters"]["spatialSplitDegrees"]
    with pytest.raises(ValidationError):
        HemisphereRunRequest.model_validate(payload)


def test_h2b_implausible_arrival_epoch_is_rejected() -> None:
    payload = _valid_h2b_request_dict()
    payload["cmeArrivalTimesMs"] = [0, 29_798_000_000_000]  # the real 2914 case
    with pytest.raises(ValidationError):
        HemisphereRunRequest.model_validate(payload)


def test_h2b_non_monotonic_arrival_times_are_rejected() -> None:
    payload = _valid_h2b_request_dict()
    payload["cmeArrivalTimesMs"] = [1000, 0]
    with pytest.raises(ValidationError):
        HemisphereRunRequest.model_validate(payload)


def test_response_fixture_round_trips() -> None:
    """Shared drift-protection fixture (see contracts.py's module docstring):
    a TypeScript test parses this same file against the AnalysisResult type.
    If the two ever disagree about the shape, one of the two tests fails.
    """
    raw = json.loads((FIXTURES / "analysis_response_v1.json").read_text())
    result = AnalysisResult.model_validate(raw)
    assert result.hypothesis_id == "H4c"
    assert len(result.tests) == 6

    round_tripped = json.loads(result.model_dump_json(by_alias=True))
    assert round_tripped == raw
