import copy
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from terra_pulse_engine.api.contracts import AnalysisResult, AnalysisRunRequest

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
        },
    }


def test_valid_request_parses() -> None:
    request = AnalysisRunRequest.model_validate(_valid_request_dict())
    assert request.hypothesis_id == "H4c"
    assert request.parameters.baseline_window_days == 365.25


def test_missing_baseline_window_days_is_rejected() -> None:
    payload = _valid_request_dict()
    del payload["parameters"]["baselineWindowDays"]
    with pytest.raises(ValidationError):
        AnalysisRunRequest.model_validate(payload)


def test_unknown_field_is_rejected() -> None:
    # extra="forbid" — a renderer-supplied parameter the schema doesn't know
    # about must fail loudly, not be silently ignored.
    payload = _valid_request_dict()
    payload["parameters"]["extraField"] = 123
    with pytest.raises(ValidationError):
        AnalysisRunRequest.model_validate(payload)


def test_implausible_epoch_is_rejected() -> None:
    # The literal case found in this app's own dev database: a cme_arrivals
    # row with an arrival year of 2914.
    payload = _valid_request_dict()
    year_2914_ms = 29_798_000_000_000  # well past MAX_PLAUSIBLE_EPOCH_MS
    payload["catalog"]["timeMs"] = [0, year_2914_ms]
    with pytest.raises(ValidationError):
        AnalysisRunRequest.model_validate(payload)


def test_non_monotonic_catalog_times_are_rejected() -> None:
    payload = _valid_request_dict()
    payload["catalog"]["timeMs"] = [1000, 0]
    with pytest.raises(ValidationError):
        AnalysisRunRequest.model_validate(payload)


def test_out_of_range_latitude_is_rejected() -> None:
    payload = _valid_request_dict()
    payload["catalog"]["latitude"] = [100.0, 20.0]
    with pytest.raises(ValidationError):
        AnalysisRunRequest.model_validate(payload)


def test_mismatched_array_lengths_are_rejected() -> None:
    payload = _valid_request_dict()
    payload["catalog"]["latitude"] = [10.0]  # now length 1, others length 2
    with pytest.raises(ValidationError):
        AnalysisRunRequest.model_validate(payload)


def test_null_series_values_are_accepted() -> None:
    payload = _valid_request_dict()
    request = AnalysisRunRequest.model_validate(payload)
    assert request.series.kp[1] is None
    assert request.series.dst[0] is None


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
