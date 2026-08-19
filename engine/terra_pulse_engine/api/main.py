"""FastAPI app: /health, /v1/hypotheses, /v1/analysis/run.

Electron main adopts (if one is already running — the normal dev loop) or
spawns this process; see apps/desktop/src/main/ipc/analysis.ts. Bound to
127.0.0.1 only by __main__.py's default — this is never meant to be reachable
off the local machine.
"""

from __future__ import annotations

import platform

from fastapi import FastAPI

from terra_pulse_engine.api.contracts import (
    AnalysisResult,
    AnalysisRunRequest,
    HealthResponse,
    HypothesisSummary,
)
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
def run_analysis(request: AnalysisRunRequest) -> AnalysisResult:
    entry = REGISTRY[request.hypothesis_id]
    return entry["run"](request)
