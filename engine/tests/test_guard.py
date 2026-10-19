"""The engine refuses everyone but main. See api/guard.py for why each check exists.

Every refusal test sends a request that would otherwise reach the handler —
a JSON body the run endpoint would answer 422 to — so a passing test shows
the guard stopped it, not that the request was malformed anyway.
"""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from terra_pulse_engine.api.guard import host_name
from terra_pulse_engine.api.main import app

LOOPBACK = "http://127.0.0.1:8787"
RUN = {"hypothesisId": "H4c"}  # reaches validation: 422 when let through


@pytest.fixture
def client() -> Iterator[TestClient]:
    previous = app.state.engine_token
    app.state.engine_token = None
    try:
        yield TestClient(app, base_url=LOOPBACK)
    finally:
        app.state.engine_token = previous


@pytest.fixture
def tokened() -> Iterator[TestClient]:
    previous = app.state.engine_token
    app.state.engine_token = "s3cret-token"
    try:
        yield TestClient(app, base_url=LOOPBACK)
    finally:
        app.state.engine_token = previous


def test_main_shaped_requests_get_through(client: TestClient) -> None:
    assert client.get("/health").status_code == 200
    assert client.post("/v1/analysis/run", json=RUN).status_code == 422


def test_localhost_and_ipv6_loopback_are_accepted(client: TestClient) -> None:
    assert client.get("/health", headers={"host": "localhost:8787"}).status_code == 200
    assert client.get("/health", headers={"host": "[::1]:8787"}).status_code == 200


def test_a_web_page_post_is_refused(client: TestClient) -> None:
    # The attack as a browser sends it: text/plain needs no preflight.
    response = client.post(
        "/v1/analysis/run",
        content=b'{"hypothesisId": "H4c"}',
        headers={"origin": "https://evil.example", "content-type": "text/plain"},
    )
    assert response.status_code == 403


def test_any_origin_header_is_refused_even_with_json(client: TestClient) -> None:
    response = client.post("/v1/analysis/run", json=RUN, headers={"origin": "https://evil.example"})
    assert response.status_code == 403
    assert client.get("/health", headers={"origin": "null"}).status_code == 403


def test_a_non_json_post_is_refused_without_an_origin(client: TestClient) -> None:
    response = client.post(
        "/v1/analysis/run",
        content=b'{"hypothesisId": "H4c"}',
        headers={"content-type": "text/plain"},
    )
    assert response.status_code == 415


def test_json_with_a_charset_is_still_json(client: TestClient) -> None:
    response = client.post(
        "/v1/analysis/run",
        content=b'{"hypothesisId": "H4c"}',
        headers={"content-type": "application/json; charset=utf-8"},
    )
    assert response.status_code == 422


def test_a_rebound_hostname_is_refused(client: TestClient) -> None:
    # DNS rebinding: the attacker's domain now resolves to 127.0.0.1.
    assert client.get("/health", headers={"host": "evil.example:8787"}).status_code == 403
    # A loopback name as a prefix of the attacker's is not loopback.
    assert client.get("/health", headers={"host": "localhost.evil.example"}).status_code == 403


def test_with_a_token_every_route_needs_it(tokened: TestClient) -> None:
    assert tokened.get("/health").status_code == 401
    assert tokened.post("/v1/analysis/run", json=RUN).status_code == 401
    assert tokened.get("/health", headers={"x-terra-pulse-token": "s3cret-tokeX"}).status_code == 401


def test_with_the_right_token_requests_get_through(tokened: TestClient) -> None:
    headers = {"x-terra-pulse-token": "s3cret-token"}
    assert tokened.get("/health", headers=headers).status_code == 200
    assert tokened.post("/v1/analysis/run", json=RUN, headers=headers).status_code == 422


def test_the_token_does_not_excuse_a_browser(tokened: TestClient) -> None:
    headers = {"x-terra-pulse-token": "s3cret-token", "origin": "https://evil.example"}
    assert tokened.get("/health", headers=headers).status_code == 403


def test_interactive_docs_are_not_served(client: TestClient) -> None:
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("127.0.0.1:8787", "127.0.0.1"),
        ("localhost", "localhost"),
        ("LOCALHOST:1", "localhost"),
        ("[::1]:8787", "::1"),
        ("[::1]", "::1"),
        ("evil.example:8787", "evil.example"),
        ("", ""),
    ],
)
def test_host_name(header: str, expected: str) -> None:
    assert host_name(header) == expected
