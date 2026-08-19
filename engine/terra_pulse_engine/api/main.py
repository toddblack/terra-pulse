"""FastAPI app: /health, /v1/hypotheses, /v1/analysis/run.

Electron main adopts (if one is already running — the normal dev loop) or
spawns this process; see apps/desktop/src/main/ipc/analysis.ts. Bound to
127.0.0.1 only by __main__.py's default — this is never meant to be reachable
off the local machine.
"""

from __future__ import annotations

import platform

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError

from terra_pulse_engine.api.contracts import AnalysisResult, HealthResponse, HypothesisSummary
from terra_pulse_engine.api.errors import unhandled_exception_handler
from terra_pulse_engine.hypotheses import REGISTRY
from terra_pulse_engine.version import CONTRACT_VERSION, ENGINE_VERSION

app = FastAPI(title="Terra Pulse Statistical Engine")
app.add_exception_handler(Exception, unhandled_exception_handler)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        engine_version=ENGINE_VERSION,
        contract_version=CONTRACT_VERSION,
        python=platform.python_version(),
    )


@app.get("/v1/hypotheses", response_model=list[HypothesisSummary])
def hypotheses() -> list[HypothesisSummary]:
    return [
        HypothesisSummary(
            id=hypothesis_id,
            implemented=entry["implemented"],
            tests_in_family=entry["tests_in_family"],
        )
        for hypothesis_id, entry in REGISTRY.items()
    ]


@app.post("/v1/analysis/run", response_model=AnalysisResult)
async def run_analysis(raw_request: Request) -> AnalysisResult:
    """One URL for every hypothesis, still — but each hypothesis family has
    its own request model (`LagWindowRunRequest`, `HemisphereRunRequest`,
    ...; see contracts.py), because they genuinely carry different
    parameters: H2b has no baseline window, H4c/H3b have no spatial split.
    Cramming both into one model would mean marking fields optional across
    families, which reopens exactly the "field present but silently unused"
    gap non-negotiable #3 exists to close.

    So this reads the hypothesis id first, then validates the *rest* of the
    body against that hypothesis's own model — the same 422-on-anything-else
    behaviour a single typed parameter would have given FastAPI automatically,
    reproduced by hand for the one field (`hypothesisId`) that has to be read
    before the rest of the body means anything.
    """
    body = await raw_request.json()
    hypothesis_id = body.get("hypothesisId") if isinstance(body, dict) else None
    entry = REGISTRY.get(hypothesis_id) if isinstance(hypothesis_id, str) else None
    if entry is None:
        raise RequestValidationError(
            [
                {
                    "type": "value_error",
                    "loc": ("body", "hypothesisId"),
                    "msg": f"unknown or unimplemented hypothesisId: {hypothesis_id!r}",
                    "input": hypothesis_id,
                }
            ]
        )

    try:
        request = entry["request_model"].model_validate(body)
    except ValidationError as exc:
        raise RequestValidationError(exc.errors()) from exc

    return entry["run"](request)
