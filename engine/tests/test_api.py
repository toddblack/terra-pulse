from fastapi.testclient import TestClient

from terra_pulse_engine.api.main import app
from terra_pulse_engine.version import CONTRACT_VERSION, ENGINE_VERSION
from tests.test_h2b import _synthetic_request as _synthetic_h2b_request
from tests.test_h3b import _synthetic_request as _synthetic_h3b_request
from tests.test_h4c import _synthetic_request

client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["contractVersion"] == CONTRACT_VERSION
    assert body["engineVersion"] == ENGINE_VERSION


def test_hypotheses_lists_h4c_h3b_and_h2b() -> None:
    response = client.get("/v1/hypotheses")
    assert response.status_code == 200
    body = response.json()
    ids = {entry["id"] for entry in body}
    assert "H4c" in ids
    assert "H3b" in ids
    assert "H2b" in ids
    h4c = next(e for e in body if e["id"] == "H4c")
    assert h4c["implemented"] is True
    assert h4c["testsInFamily"] == 6
    h3b = next(e for e in body if e["id"] == "H3b")
    assert h3b["implemented"] is True
    assert h3b["testsInFamily"] == 4
    h2b = next(e for e in body if e["id"] == "H2b")
    assert h2b["implemented"] is True
    assert h2b["testsInFamily"] == 2


def test_run_analysis_h2b_over_a_small_synthetic_payload() -> None:
    request = _synthetic_h2b_request(iterations=50)
    payload = request.model_dump(by_alias=True)

    response = client.post("/v1/analysis/run", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["hypothesisId"] == "H2b"
    assert len(body["tests"]) == 2


def test_run_analysis_h3b_over_a_small_synthetic_payload() -> None:
    request = _synthetic_h3b_request(iterations=50)
    payload = request.model_dump(by_alias=True)

    response = client.post("/v1/analysis/run", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["hypothesisId"] == "H3b"
    assert len(body["tests"]) == 4


def test_run_analysis_over_a_small_synthetic_payload() -> None:
    request = _synthetic_request(iterations=50)
    payload = request.model_dump(by_alias=True)

    response = client.post("/v1/analysis/run", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["hypothesisId"] == "H4c"
    assert len(body["tests"]) == 6
    assert body["correction"]["testsRun"] == 6


def test_invalid_request_returns_422_not_a_traceback() -> None:
    response = client.post("/v1/analysis/run", json={"contractVersion": 1})
    assert response.status_code == 422
    # Never a bare stack trace reaching the client.
    assert "Traceback" not in response.text
